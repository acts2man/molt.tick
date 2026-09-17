import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyProductionBuild } from '../src/verify/build.js';

async function withBuild(script: string, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'molt-build-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node check.cjs' } }));
  await writeFile(join(dir, 'check.cjs'), script);
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('actual successful build is recorded', () => withBuild("console.log('compiled')", async (dir) => {
  const result = await verifyProductionBuild(dir);
  assert.equal(result.ok, true);
  assert.match(await readFile(result.logPath, 'utf8'), /compiled/);
}));
test('nonzero build is a failure, with retained diagnostics', () => withBuild("console.error('bad TSX'); process.exit(2)", async (dir) => {
  const result = await verifyProductionBuild(dir);
  assert.equal(result.ok, false);
  assert.match(await readFile(result.logPath, 'utf8'), /bad TSX/);
}));
test('build receives no worker API secrets', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'local-test-not-a-real-secret';
  try {
    await withBuild("if (process.env.ANTHROPIC_API_KEY) process.exit(7)", async (dir) => assert.equal((await verifyProductionBuild(dir)).ok, true));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
test('hung build is stopped', () => withBuild('setTimeout(() => {}, 30000)', async (dir) => {
  const result = await verifyProductionBuild(dir, 1000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out/);
}));
