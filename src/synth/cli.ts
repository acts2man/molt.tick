import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { synthesize } from './synthesize.js';
import type { CaptureManifest, ComputedEntry, PageIR, MigrationPlan } from '../ir/types.js';

const [captureDir = '/tmp/molt-capture', outDir = '/tmp/molt-site'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(captureDir, 'manifest.json'), 'utf-8')) as CaptureManifest;
const plan = JSON.parse(await readFile(join(captureDir, 'plan.json'), 'utf-8')) as MigrationPlan;

const pages = [];
for (const p of manifest.pages) {
  const slug = p.files.dom.split('/')[0];
  try {
    const ir = JSON.parse(await readFile(join(captureDir, slug, 'page.ir.json'), 'utf-8')) as PageIR;
    const computed = JSON.parse(await readFile(join(captureDir, slug, 'computed.json'), 'utf-8')) as ComputedEntry[];
    ir.route = p.route;
    pages.push({ route: p.route, ir, computed });
  } catch { /* no IR — skip */ }
}

const result = await synthesize({ plan, pages, outDir, projectName: 'soul2souls-react' });
console.log(`[molt] synthesize · ${result.files.length} files → ${outDir}`);
console.log(`  routes: ${pages.length} · shared chrome: ${plan.sharedChrome.length} sections built once`);
console.log(`  library components emitted: ${result.components.join(', ')}`);
