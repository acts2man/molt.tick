import { crawl } from './crawler.js';

const [url, ...rest] = process.argv.slice(2);
if (!url) {
  console.error('usage: npm run crawl -- <url> [--out dir] [--max N]');
  process.exit(1);
}
const out = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : 'capture';
const max = rest.includes('--max') ? Number(rest[rest.indexOf('--max') + 1]) : 50;

crawl({ startUrl: url, outDir: out, maxPages: max }).then((m) => {
  console.log(`\n[molt] done — ${m.pages.length} page(s) captured → ${out}/manifest.json`);
});
