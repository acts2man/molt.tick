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

  // ensure deps present for a build
  const pkgPath = join(siteDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  pkg.dependencies = { ...pkg.dependencies, react: '^18.3.0', 'react-dom': '^18.3.0' };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    '@vitejs/plugin-react': '^4.3.0', vite: '^5.4.0',
    tailwindcss: '^3.4.0', autoprefixer: '^10.4.0', postcss: '^8.4.0',
    '@types/react': '^18.3.0', '@types/react-dom': '^18.3.0',
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

export async function renderAndDiff(
  siteDir: string,
  captureDir: string,
  routes: { route: string; slug: string }[],
): Promise<RenderResult[]> {
  await scaffoldRunnable(siteDir, routes);

  // install + build
  const inst = await run('npm', ['install', '--no-audit', '--no-fund'], siteDir, 180000);
  if (inst.code !== 0) return routes.map((r) => ({ ...r, pixelMatch: null, rendered: false, note: 'npm install failed' }));
  const build = await run('npx', ['vite', 'build'], siteDir, 180000);
  if (build.code !== 0) {
    return routes.map((r) => ({ ...r, pixelMatch: null, rendered: false, note: 'vite build failed: ' + build.out.slice(-300) }));
  }

  // serve the built app and screenshot each route
  const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: siteDir, env: process.env });
  await new Promise((r) => setTimeout(r, 3500)); // let preview boot

  const results: RenderResult[] = [];
  try {
    const browser = await chromium.launch({
      ...(CHROME ? { executablePath: CHROME } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    await mkdir(join(siteDir, 'renders'), { recursive: true });
    for (const r of routes) {
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.goto(`http://127.0.0.1:4173/?route=${r.slug}`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(500);
        const shot = join(siteDir, 'renders', `${r.slug}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        await page.close();
        const original = join(captureDir, r.slug, 'original.png');
        const pixelMatch = existsSync(original) ? (await comparePixels(original, shot)).matchPct : null;
        results.push({ ...r, pixelMatch, rendered: true });
      } catch (e) {
        results.push({ ...r, pixelMatch: null, rendered: false, note: (e as Error).message });
      }
    }
    await browser.close();
  } finally {
    preview.kill('SIGKILL');
  }
  return results;
}
