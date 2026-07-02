/**
 * Local validation harness: serve a reconstructed site (from real captures)
 * in-process and run the crawler against it. Ground truth is the completed
 * Soul2Souls manual migration.
 *
 *   tsx test/local-crawl.ts <siteDir> <outDir> [startPath]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { crawl } from '../src/crawl/crawler.js';

const [siteDir = '/tmp/moltsite', outDir = '/tmp/molt-capture', startPath = '/about/'] =
  process.argv.slice(2);

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let fp = join(siteDir, p);
    try {
      const s = await stat(fp);
      if (s.isDirectory()) fp = join(fp, 'index.html');
    } catch {
      // extensionless path → try dir index
      fp = join(siteDir, p, 'index.html');
    }
    const body = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise<void>((ok) => server.listen(8077, '127.0.0.1', ok));
console.log(`[harness] serving ${siteDir} on http://127.0.0.1:8077`);

try {
  const manifest = await crawl({
    startUrl: `http://127.0.0.1:8077${startPath}`,
    outDir,
    maxPages: 12,
  });
  console.log(`[harness] captured ${manifest.pages.length} pages`);
} finally {
  server.close();
}
