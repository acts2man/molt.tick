import { normalizePage, irStats } from './elementor.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [captureDir = '/tmp/molt-capture', slug = 'home'] = process.argv.slice(2);
const ir = await normalizePage(
  join(captureDir, slug, 'page.html'),
  join(captureDir, slug, 'computed.json'),
);
ir.route = slug === 'home' ? '/' : '/' + slug.replace(/__/g, '/');
const stats = irStats(ir);
console.log(`[molt] normalize ${slug} · builder=${ir.builder}`);
console.log(`  sections: ${stats.sections} · columns: ${stats.columns} · widgets: ${stats.widgets}`);
console.log(`  by type:`, stats.byType);
console.log(`  unknown plugin widgets: ${ir.unknownWidgets.join(', ') || '(none)'}`);
await writeFile(join(captureDir, slug, 'page.ir.json'), JSON.stringify(ir, null, 1));
console.log(`  → ${join(captureDir, slug, 'page.ir.json')}`);
