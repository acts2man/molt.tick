import { chromium, type BrowserContext } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir, symlink, access, realpath } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { assertPublicUrl, inside, safeEnvironment } from './policy.js';

export async function browser() {
  return chromium.launch({
    ...(process.env.MOLT_CHROME ? { executablePath: process.env.MOLT_CHROME } : {}),
    chromiumSandbox: process.env.MOLT_NO_SANDBOX !== '1',
    env: safeEnvironment(), args: ['--disable-dev-shm-usage'],
  });
}
export async function restrictNetwork(context: BrowserContext, localOrigin?: string, offline = false): Promise<void> {
  await context.route('**/*', async route => {
    try {
      const req = route.request(), u = new URL(req.url());
      if (!['GET', 'HEAD'].includes(req.method())) { await route.abort(); return; }
      if (u.origin === localOrigin) { await route.continue(); return; }
      if (offline) { await route.abort(); return; }
      await assertPublicUrl(u.href);
      const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
      try {
        const location = response.headers()['location'];
        if (location) await assertPublicUrl(new URL(location, u).href);
        await route.fulfill({ response });
      } finally { await response.dispose(); }
    } catch { await route.abort().catch(() => {}); }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
}
const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
/** Loopback-only static server. Unknown routes do not silently render home. */
export async function serve(root: string, aliases: Record<string, string> = {}, sourceMode = false, staticSnapshot = false) {
  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      const rel = Object.hasOwn(aliases, path) ? aliases[path] : path.replace(/^\//, '');
      if (!rel || rel.split('/').some(p => p.startsWith('.'))) { res.writeHead(404).end(); return; }
      const file = await inside(root, rel), extension = extname(file).toLowerCase();
      if (!MIME[extension] || (await stat(file)).size > 25_000_000) { res.writeHead(415).end(); return; }
      let body = await readFile(file);
      if (sourceMode && /\.html?$/.test(extension)) {
        const directory = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
        const base = '/' + directory.split('/').map(encodeURIComponent).join('/');
        let html = body.toString('utf8').replace(/<base\b[^>]*>/gi, '');
        if(staticSnapshot){
          // Hybrid fallback is a visual evidence snapshot, not a second live execution environment.
          // Strip executable/navigation primitives so a retained SingleFile page cannot redirect the
          // fallback browser back to the unavailable public route.
          html=html
            .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,'')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'')
            .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'');
        }
        const tag = `<base href="${base}">`;
        html = /<head\b/i.test(html) ? html.replace(/<head\b[^>]*>/i, m => m + tag) : tag + html;
        body = Buffer.from(html);
      }
      res.writeHead(200, { 'content-type': MIME[extension], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}
export async function command(cwd: string, executable: string, args: string[], signal: AbortSignal): Promise<{ ok: boolean; log: string }> {
  signal.throwIfAborted();
  return new Promise(resolve => {
    let log = '', settled = false;
    const child = spawn(executable, args, { cwd, env: safeEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const finish = (ok: boolean, reason = '') => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      resolve({ ok, log: (log + reason).slice(-24000) });
    };
    const abort = () => { stop(); finish(false, '\nCommand cancelled or timed out'); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', d => { log = (log + d).slice(-24000); });
    child.stderr.on('data', d => { log = (log + d).slice(-24000); });
    child.once('error', e => finish(false, e.message));
    child.once('close', code => finish(code === 0));
  });
}
export async function prepareToolchain(outDir: string): Promise<void> {
  const deps = resolve(process.env.MOLT_RENDER_DEPS ?? '/opt/molt-render/node_modules');
  await access(join(deps, 'vite/bin/vite.js'));
  await mkdir(outDir, { recursive: true });
  const [lockRaw,packageRaw]=await Promise.all([readFile(resolve(deps,'..','package-lock.json'),'utf8'),readFile(join(outDir,'package.json'),'utf8')]);
  const lock=JSON.parse(lockRaw),pkg=JSON.parse(packageRaw);
  if(!lock||Number(lock.lockfileVersion)<2||!lock.packages?.[''])throw new Error('Trusted render toolchain lockfile is missing or invalid');
  const root=lock.packages[''];
  const normalized=(value:any)=>Object.fromEntries(Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b)));
  const same=(a:unknown,b:unknown)=>JSON.stringify(normalized(a))===JSON.stringify(normalized(b));
  if(!same(root.dependencies,pkg.dependencies)||!same(root.devDependencies,pkg.devDependencies))throw new Error('Generated package dependencies do not match the trusted render toolchain lockfile');
  lock.name=pkg.name;root.name=pkg.name;root.private=true;
  await writeFile(join(outDir,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
  const destination = join(outDir, 'node_modules');
  try {
    await access(destination);
    if (await realpath(destination) !== await realpath(deps)) throw new Error('Unexpected output toolchain');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await symlink(deps, destination, 'dir');
  }
}
/** Engine-owned build configuration only. No model-authored dependency installation. */
export const build = (outDir: string, signal: AbortSignal) => command(outDir, process.execPath, [join(outDir, 'node_modules/vite/bin/vite.js'), 'build'], signal);
