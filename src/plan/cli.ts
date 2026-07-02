import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPlan, type PlanInput } from './plan.js';
import type { CaptureManifest, ComputedEntry, PageIR } from '../ir/types.js';

const [captureDir = '/tmp/molt-capture'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(captureDir, 'manifest.json'), 'utf-8')) as CaptureManifest;

const inputs: PlanInput[] = [];
for (const p of manifest.pages) {
  const slug = p.files.dom.split('/')[0];
  try {
    const ir = JSON.parse(await readFile(join(captureDir, slug, 'page.ir.json'), 'utf-8')) as PageIR;
    const dom = await readFile(join(captureDir, slug, 'page.html'), 'utf-8');
    const computed = JSON.parse(await readFile(join(captureDir, slug, 'computed.json'), 'utf-8')) as ComputedEntry[];
    inputs.push({ route: p.route, ir, dom, computed });
  } catch { console.log(`[molt] plan: skipping ${slug} (no IR — run normalize first)`); }
}

const plan = buildPlan(inputs);
await writeFile(join(captureDir, 'plan.json'), JSON.stringify(plan, null, 1));

console.log(`[molt] plan · ${plan.stats.pages} pages`);
console.log(`\nCHROME — build once (${plan.stats.chromeSections} global sections; saves rebuilding ${plan.stats.perPageSectionsSaved} per-page sections)`);
for (const c of plan.chrome) {
  const scope = c.global ? 'all pages' : `${c.pages.length} pages`;
  const inst = c.instancesPerPage > 1 ? ` ·×${c.instancesPerPage} breakpoint variants` : '';
  const sv = c.styleVariants && c.label === 'header' ? ' · per-route style variants (sidecar)' : '';
  console.log(`  [${c.label.padEnd(11)}] ${c.id} · ${scope}${inst}${sv} · ${c.widgets.slice(0,4).join(', ')}${c.widgets.length>4?'…':''}`);
}
console.log(`\nLIBRARY — matched to proven components (${plan.library.length})`);
for (const m of plan.library) console.log(`  ${m.widgetType.padEnd(18)} → ${m.component} (${m.confidence})`);
console.log(`\nFLAGS — needs your call (${plan.flags.length})`);
for (const f of plan.flags) console.log(`  [${f.kind.padEnd(14)}] ${f.page.padEnd(10)} ${f.summary}`);
console.log(`\n→ ${join(captureDir, 'plan.json')}`);
