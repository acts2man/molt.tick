/**
 * Molt Stage 5b — Render + pixel-diff.
 *
 * The synthesizer emits route components but no runnable entry point (TanStack
 * file-routes need codegen). To actually SEE Molt's output and measure fidelity,
 * this harness wraps the emitted components in a minimal runnable Vite app,
 * builds it, screenshots each route with headless Chromium, and pixel-compares
 * against the crawler's original capture.
 *
 * Honest scope: the numbers this produces are REAL. They start low because the
 * synthesizer's library components are still stubs and styles over-inherit —
 * this is the measurement that quantifies exactly that gap, page by page.
 */

import { chromium } from 'playwright-core';
import { mkdir, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { comparePixels } from './pixel.js';

const CHROME_ENV = process.env.MOLT_CHROME;
const DEV_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = CHROME_ENV ?? (existsSync(DEV_CHROME) ? DEV_CHROME : undefined);

export interface RenderResult {
  route: string;
  slug: string;
  pixelMatch: number | null;
  rendered: boolean;
  note?: string;
}

const routeToComp = (route: string) =>
  route === '/' ? 'Home' : route.slice(1).split(/[-/]/).map((s) => s[0]?.toUpperCase() + s.slice(1)).join('');
const routeToFile = (route: string) =>
  route === '/' ? 'index' : route.slice(1).replace(/\/$/, '').replace(/\//g, '.');

/**
 * Build a minimal runnable app around the synth output: a real entry point and
 * a tiny hash router that renders one route component per screen. We strip the
 * TanStack createFileRoute wrapper and import the raw component functions.
 */
async function scaffoldRunnable(siteDir: string, routes: { route: string; slug: string }[]): Promise<void> {
  // Faithful output is ALREADY a complete runnable app (src/main.tsx + real
  // router). Don't rescaffold it — just make sure its entry exists.
  if (existsSync(join(siteDir, 'src', 'main.tsx'))) {
    return; // faithful mode — app is runnable as-is
  }
  // index.html entry
  await writeFile(join(siteDir, 'index.html'),
`<!doctype html><html><head><meta charset="utf-8"><title>Molt preview</title></head>
<body><div id="root"></div><script type="module" src="/src/preview-main.tsx"></script></body></html>`);

  // rewrite each route file to export its component plainly (drop createFileRoute,
  // which needs the router runtime we're not booting).
  const imports: string[] = [];
  const cases: string[] = [];
  for (const r of routes) {
    const file = routeToFile(r.route);
    const comp = routeToComp(r.route);
    const src = await readFile(join(siteDir, 'src/routes', file + '.tsx'), 'utf-8');
    // strip the createFileRoute import + Route export; keep the component fn
    let stripped = src
      .replace(/import\s*\{\s*createFileRoute\s*\}\s*from\s*'@tanstack\/react-router';\n?/, '')
      .replace(/export const Route[^;]*;\n?/s, '')
      .replace(/function\s+/, 'export function '); // export the component
    await writeFile(join(siteDir, 'src/routes', file + '.preview.tsx'), stripped);
    imports.push(`import { ${comp} } from './routes/${file}.preview';`);
    cases.push(`    '${r.slug}': <${comp} />,`);
  }

  // preview entry: pick the route from ?route=<slug>, render that component
  await writeFile(join(siteDir, 'src/preview-main.tsx'),
`import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
${imports.join('\n')}

const screens: Record<string, React.ReactNode> = {
${cases.join('\n')}
};

const slug = new URLSearchParams(location.search).get('route') ?? '${routes[0]?.slug ?? 'home'}';
createRoot(document.getElementById('root')!).render(screens[slug] ?? <div>unknown route</div>);
`);

  // ensure deps present for a build — versions PINNED to the pre-baked
  // toolchain (render-toolchain/package.json) so the symlinked node_modules
  // resolves cleanly with no install.
  const pkgPath = join(siteDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  pkg.dependencies = { ...pkg.dependencies, react: '18.3.1', 'react-dom': '18.3.1' };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    '@vitejs/plugin-react': '4.3.3', vite: '5.4.10',
    tailwindcss: '3.4.14', autoprefixer: '10.4.20', postcss: '8.4.47',
    '@types/react': '18.3.12', '@types/react-dom': '18.3.1',
  };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  // tailwind must scan the preview files too
  await writeFile(join(siteDir, 'tailwind.config.js'),
`export default { content: ['./src/**/*.{ts,tsx}','./index.html'], theme: { extend: {} }, plugins: [] };`);
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: -1, out: out + '\n[timeout]' }); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out }); });
  });
}

/** Poll a URL until it responds or times out. */
async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** All-dashes result (used whenever rendering can't run — never fails a migration). */
function dashes(routes: { route: string; slug: string }[], note: string): RenderResult[] {
  return routes.map((r) => ({ ...r, pixelMatch: null, rendered: false, note }));
}

export async function renderAndDiff(
  siteDir: string,
  captureDir: string,
  routes: { route: string; slug: string }[],
  opts: { budgetMs?: number; concurrency?: number } = {},
): Promise<RenderResult[]> {
  const budgetMs = opts.budgetMs ?? Number(process.env.MOLT_RENDER_BUDGET_MS ?? 120000); // 2 min default
  const concurrency = opts.concurrency ?? Number(process.env.MOLT_RENDER_CONCURRENCY ?? 1);
  const deadline = Date.now() + budgetMs;

  // Top-level guard: rendering must NEVER throw out of here — worst case it
  // returns dashes so the migration still completes.
  // memory safety: on large sites, rendering every page can exhaust a small
  // container. Render up to a cap; the rest get dashes (still a real sample).
  const maxRender = Number(process.env.MOLT_RENDER_MAX ?? 12);
  const toRender = routes.slice(0, maxRender);
  const overflow = routes.slice(maxRender).map((r) => ({ ...r, pixelMatch: null, rendered: false, note: 'beyond render cap' }));
  try {
    await scaffoldRunnable(siteDir, toRender);

    // Dependencies: pre-baked toolchain (zero install), else install fallback.
    const prebaked = process.env.MOLT_RENDER_DEPS ?? '/opt/molt-render/node_modules';
    const localNodeModules = join(siteDir, 'node_modules');
    let viteBin = 'npx';
    let viteBaseArgs: string[] = ['vite'];
    if (existsSync(prebaked)) {
      try {
        if (!existsSync(localNodeModules)) {
          await import('node:fs/promises').then((fs) => fs.symlink(prebaked, localNodeModules, 'dir'));
        }
        viteBin = join(prebaked, '.bin', 'vite');
        viteBaseArgs = [];
        console.log(`[render] using pre-baked deps at ${prebaked}`);
      } catch (e) { console.error('[render] symlink failed, will npm install:', (e as Error).message); }
    } else {
      console.log(`[render] no pre-baked deps at ${prebaked} — falling back to npm install`);
    }
    if (viteBin === 'npx') {
      const inst = await run('npm', ['install', '--no-audit', '--no-fund'], siteDir, 120000);
      if (inst.code !== 0) { console.error('[render] npm install FAILED:', inst.out.slice(-400)); return dashes(routes, 'npm install failed'); }
    }

    // DEV server — no production build. Starts fast; serves routes on demand.
    const port = 4173 + Math.floor(Math.random() * 400); // avoid collisions across runs
    const server = spawn(viteBin, [...viteBaseArgs, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
      { cwd: siteDir, env: process.env });

    const results: RenderResult[] = [];
    try {
      const ready = await waitForServer(`http://127.0.0.1:${port}/`, Math.min(30000, deadline - Date.now()));
      if (!ready) { console.error('[render] dev server did not become ready in time'); return dashes(routes, 'dev server did not start in time'); }
      console.log(`[render] dev server ready on ${port}`);

      const browser = await chromium.launch({
        ...(CHROME ? { executablePath: CHROME } : {}),
        // NOTE: do NOT add --single-process / --no-zygote here — they crash
        // Chromium in the Railway container ("Target ... has been closed").
        // These give big faithful pages (300KB+ HTML) enough headroom not to crash.
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-software-rasterizer',
          '--js-flags=--max-old-space-size=512',
        ],
      });
      await mkdir(join(siteDir, 'renders'), { recursive: true });

      const faithful = existsSync(join(siteDir, 'src', 'main.tsx'));
      // shoot one route, fully guarded — any failure → dash for that route only
      const shoot = async (r: { route: string; slug: string }): Promise<RenderResult> => {
        try {
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          const consoleErrors: string[] = [];
          page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
          page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 200)));
          try {
            const url = faithful
              ? `http://127.0.0.1:${port}${r.route}`      // faithful: real router path
              : `http://127.0.0.1:${port}/?route=${r.slug}`; // old preview scaffold
            // 'load' waits for stylesheets/images too (not just DOM). Big CSS on
            // a container parses slowly — screenshotting too early = blank page
            // = the low pixel scores. Wait for real load + fonts + a settle.
            await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(async () => {
              // if full load stalls, fall back to domcontentloaded so we still shoot
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            });
            // wait for webfonts to be ready and for stylesheets to have applied
            await page.evaluate(`(async () => {
              try { await (document).fonts.ready; } catch (e) {}
              // force layout so background-images/CSS are computed
              document.body && document.body.getBoundingClientRect();
            })()`).catch(() => {});
            await page.waitForTimeout(2500); // settle: CSS paint, lazy backgrounds
            // DIAGNOSTIC: capture what the rendered DOM actually contains, so we
            // can see (in logs) whether it's blank/broken vs real. This ends the
            // guessing about why scores are low.
            const diag = await page.evaluate(`(() => {
              const b = document.body;
              const text = (b?.innerText || '').replace(/\\s+/g,' ').trim();
              const bg = getComputedStyle(b).backgroundColor;
              return {
                h: document.documentElement.scrollHeight,
                textLen: text.length,
                textSample: text.slice(0, 80),
                imgs: document.querySelectorAll('img').length,
                sections: document.querySelectorAll('section, [class*="elementor"], [class*="section"]').length,
                bg,
              };
            })()`).catch(() => null) as { h: number; textLen: number; textSample: string; imgs: number; sections: number; bg: string } | null;
            if (diag) {
              console.log(`[render] ${r.route} DOM: height=${diag.h}px text=${diag.textLen}chars imgs=${diag.imgs} sections=${diag.sections} bg=${diag.bg} · "${diag.textSample}"`);
            }
            if (consoleErrors.length) {
              console.error(`[render] ${r.route} JS ERRORS: ${consoleErrors.slice(0, 3).join(' || ')}`);
            }
            const shot = join(siteDir, 'renders', `${r.slug}.png`);
            const renderH = await page.evaluate(`document.documentElement.scrollHeight`).catch(() => 900) as number;
            await page.setViewportSize({ width: 1440, height: Math.min(renderH || 900, 20000) });
            await page.waitForTimeout(200);
            await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 1440, height: Math.min(renderH || 900, 20000) } });
            const original = join(captureDir, r.slug, 'original.png');
            const pixelMatch = existsSync(original) ? (await comparePixels(original, shot)).matchPct : null;
            console.log(`[render] ${r.route} → pixel ${pixelMatch}% (render ${diag?.h ?? '?'}px)`);
            return { ...r, pixelMatch, rendered: true };
          } finally {
            await page.close().catch(() => {});
          }
        } catch (e) {
          return { ...r, pixelMatch: null, rendered: false, note: (e as Error).message };
        }
      };

      // parallel in batches; stop starting new batches once the budget is spent
      for (let i = 0; i < toRender.length; i += concurrency) {
        if (Date.now() > deadline) {
          for (const r of toRender.slice(i)) results.push({ ...r, pixelMatch: null, rendered: false, note: 'render budget reached' });
          break;
        }
        const batch = toRender.slice(i, i + concurrency);
        results.push(...await Promise.all(batch.map(shoot)));
      }
      await browser.close().catch(() => {});
    } finally {
      server.kill('SIGKILL');
    }
    return [...results, ...overflow];
  } catch (e) {
    return dashes(routes, 'render error: ' + (e as Error).message);
  }
}
