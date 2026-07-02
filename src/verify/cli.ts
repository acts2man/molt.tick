import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyStructure } from './structure.js';
import type { MigrationPlan } from '../ir/types.js';

const [siteDir = '/tmp/molt-site', captureDir = '/tmp/molt-capture'] = process.argv.slice(2);
const plan = JSON.parse(await readFile(join(captureDir, 'plan.json'), 'utf-8')) as MigrationPlan;

const rep = await verifyStructure(siteDir, plan);

console.log(`[molt] verify (structural) · ${siteDir}`);
console.log(`\nSCAFFOLD`);
for (const s of rep.scaffold) console.log(`  ${s.present ? '✓' : '✗'} ${s.file}`);
console.log(`\nROUTE CHECKS — ${rep.routeChecks.passed}/${rep.routeChecks.total} passed`);
for (const r of rep.routes) {
  const flags = [];
  if (!r.fileExists) flags.push('NO FILE');
  if (r.deadLinks.length) flags.push(`${r.deadLinks.length} dead link(s): ${r.deadLinks.join(', ')}`);
  if (r.componentsUnimported.length) flags.push(`unimported: ${r.componentsUnimported.join(', ')}`);
  const ok = r.fileExists && !r.deadLinks.length && !r.componentsUnimported.length;
  console.log(`  ${ok ? '✓' : '✗'} ${r.route.padEnd(20)} ${r.internalLinks} links${flags.length ? ' · ' + flags.join(' · ') : ''}`);
}
console.log(`\nLINK INTEGRITY — ${rep.deadLinkTotal} dead link(s) across site`);
console.log(`COMPONENT WIRING — ${rep.unimportedTotal} unimported component reference(s)`);
console.log(`FLAGS REPRESENTED — ${rep.flagsRepresented.filter(f => f.found).length}/${rep.flagsRepresented.length}`);
console.log(`\n${rep.pass ? '✅ STRUCTURAL VERIFY PASSED' : '⚠️  STRUCTURAL ISSUES — see above'}`);
