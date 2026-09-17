import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessQuality, pixelThreshold } from '../src/verify/quality.js';
import { verifyStructure } from '../src/verify/structure.js';
import type { MigrationPlan } from '../src/ir/types.js';

const measured = (pixelMatch: number | null = 99) => [{ route: '/', rendered: true, pixelMatch }];
test('accepts exactly one measured passing render for every requested route', () => assert.equal(assessQuality(['/'], measured(), true).pass, true));
test('zero is a measured mismatch, not missing data', () => assert.equal(assessQuality(['/'], measured(0), true).checks[0].score, 0));
test('null does not pass', () => assert.equal(assessQuality(['/'], measured(null), true).pass, false));
test('missing render does not pass', () => assert.equal(assessQuality(['/'], [], true).pass, false));
test('unrendered result cannot pass with a fabricated score', () => assert.equal(assessQuality(['/'], [{ ...measured()[0], rendered: false }], true).pass, false));
test('invalid or out-of-range scores cannot pass', () => {
  for (const n of [NaN, Infinity, -1, 101]) assert.equal(assessQuality(['/'], measured(n), true).pass, false);
});
test('structural failure blocks visually matching pages', () => assert.equal(assessQuality(['/'], measured(100), false).pass, false));
test('all routes must be measured including those beyond render cap', () => assert.equal(assessQuality(['/', '/about'], measured(), true).pass, false));
test('duplicate render results cannot overwrite failures', () => assert.equal(assessQuality(['/'], [...measured(0), ...measured(100)], true).pass, false));
test('unexpected results and duplicate planned routes do not pass', () => {
  assert.equal(assessQuality(['/about'], measured(), true).pass, false);
  assert.equal(assessQuality(['/', '/'], measured(), true).pass, false);
});
test('renderer warnings prevent a clean pass', () => assert.equal(assessQuality(['/'], [{ ...measured()[0], note: 'Runtime error' }], true).pass, false));
test('empty jobs and invalid thresholds fail closed', () => {
  assert.equal(assessQuality([], [], true).pass, false);
  for (const value of ['', 'NaN', 'Infinity', '-1', '0', '101']) assert.throws(() => pixelThreshold(value));
  assert.equal(pixelThreshold(undefined), 95);
  assert.equal(pixelThreshold('97.5'), 97.5);
});

function plan(routes: string[] = ['/']): MigrationPlan {
  return { routes: routes.map((route) => ({ route, title: route })), flags: [], chrome: [], sharedChrome: [], library: [],
    stats: { pages: routes.length, chromeSections: 0, perPageSectionsSaved: 0, pluginTypesMatched: 0, pluginTypesUnmatched: 0 } };
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'molt-contract-'));
  await mkdir(join(dir, 'src/pages'), { recursive: true });
  for (const file of ['package.json', 'vite.config.ts', 'index.html', 'src/index.css', 'tailwind.config.js', 'postcss.config.js']) await writeFile(join(dir, file), '{}');
  await writeFile(join(dir, 'src/main.tsx'), "import Page from './pages/index'; export default Page;");
  await writeFile(join(dir, 'src/pages/index.tsx'), 'export default function Page() { return <main>Home</main>; }');
  await writeFile(join(dir, 'MOLT_OUTPUT.json'), JSON.stringify({ mode: 'ai-visual-rebuild', routes: ['/'], pagesFailed: 0 }));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('recognizes the actual src/pages AI scaffold', () => fixture(async (dir) => assert.equal((await verifyStructure(dir, plan())).pass, true)));
test('missing page is a failure', () => fixture(async (dir) => {
  await rm(join(dir, 'src/pages/index.tsx'));
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('source HTML wrapper is not an independent React rebuild', () => fixture(async (dir) => {
  await writeFile(join(dir, 'src/pages/index.tsx'), 'export default () => <div dangerouslySetInnerHTML={{__html: "source"}}/>;');
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('legacy snapshot mode is explicitly rejected', () => fixture(async (dir) => {
  await writeFile(join(dir, 'MOLT_OUTPUT.json'), JSON.stringify({ mode: 'faithful-visual', routes: ['/'] }));
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('a failure placeholder cannot be accepted', () => fixture(async (dir) => {
  await writeFile(join(dir, 'src/pages/index.tsx'), 'export default () => <div>Page could not be rebuilt.</div>;');
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('manifest page failures and incomplete coverage fail', () => fixture(async (dir) => {
  await writeFile(join(dir, 'MOLT_OUTPUT.json'), JSON.stringify({ routes: ['/'], pagesFailed: 1 }));
  assert.equal((await verifyStructure(dir, plan())).pass, false);
  await writeFile(join(dir, 'MOLT_OUTPUT.json'), JSON.stringify({ routes: ['/about'], pagesFailed: 0 }));
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('internal query strings and anchors do not create false dead links', () => fixture(async (dir) => {
  await writeFile(join(dir, 'src/pages/index.tsx'), 'export default () => <a href="/?plan=basic#contact">Contact</a>;');
  assert.equal((await verifyStructure(dir, plan())).pass, true);
}));
test('real dead links fail, external protocol-relative URLs are excluded', () => fixture(async (dir) => {
  await writeFile(join(dir, 'src/pages/index.tsx'), 'export default () => <a href="//example.com/away">Away</a>;');
  assert.equal((await verifyStructure(dir, plan())).pass, true);
  await writeFile(join(dir, 'src/pages/index.tsx'), 'export default () => <a href="/missing#intro">Missing</a>;');
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('relative imports must resolve in the module that uses them', () => fixture(async (dir) => {
  await writeFile(join(dir, 'src/pages/index.tsx'), "import Header from '../components/Header'; export default Header;");
  assert.equal((await verifyStructure(dir, plan())).pass, false);
}));
test('duplicate route filenames are rejected', () => fixture(async (dir) => {
  const p = plan(['/foo/bar', '/foo.bar']);
  const report = await verifyStructure(dir, p);
  assert.ok(report.integrityIssues.some((i) => i.includes('collision')));
}));
test('path traversal route names are rejected', () => fixture(async (dir) => {
  const report = await verifyStructure(dir, plan(['/../../outside']));
  assert.equal(report.pass, false);
  assert.ok(report.integrityIssues.some((i) => i.includes('Invalid route')));
}));
