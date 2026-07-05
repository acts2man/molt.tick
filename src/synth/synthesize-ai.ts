/**
 * Molt — AI synthesis stage.
 *
 * Rebuilds each captured page with Claude (intelligent recreation) instead of
 * mechanical HTML/CSS copy, then assembles a complete, buildable Vite+React+
 * Tailwind project. Wired into the pipeline; gated by MOLT_AI_REBUILD + an API
 * key. Falls back to faithful mechanical capture when unavailable.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureManifest } from '../ir/types.js';
import { buildBrief, rebuildPageWithAI } from './ai-rebuild.js';

export interface AiSynthInput {
  captureDir: string;
  manifest: CaptureManifest;
  outDir: string;
  projectName?: string;
  routes: { route: string; slug: string }[];
  onProgress?: (msg: string) => void;
}

export interface AiSynthResult {
  ok: boolean;
  pagesRebuilt: number;
  pagesFailed: number;
  totalTokens: number;
  error?: string;
}

const routeToComp = (route: string) =>
  route === '/' ? 'Home' : route.slice(1).split(/[-/]/).map((s) => (s[0]?.toUpperCase() ?? '') + s.slice(1)).join('') || 'Page';
const routeToFile = (route: string) =>
  route === '/' ? 'index' : route.slice(1).replace(/\/$/, '').replace(/\//g, '.');

export async function synthesizeWithAI(input: AiSynthInput): Promise<AiSynthResult> {
  const { captureDir, manifest, outDir, projectName = 'migrated-site', routes, onProgress } = input;
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, pagesRebuilt: 0, pagesFailed: 0, totalTokens: 0, error: 'ANTHROPIC_API_KEY not set' };

  const write = async (rel: string, body: string) => {
    const full = join(outDir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  };

  // scaffold a complete Vite + React + Tailwind project
  await write('package.json', JSON.stringify({
    name: projectName, private: true, type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
    devDependencies: { '@vitejs/plugin-react': '4.3.3', vite: '5.4.10', tailwindcss: '3.4.14', autoprefixer: '10.4.20', postcss: '8.4.47' },
  }, null, 2));
  await write('vite.config.ts', `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`);
  await write('tailwind.config.js', `export default { content: ['./index.html', './src/**/*.{ts,tsx}'], theme: { extend: {} }, plugins: [] };\n`);
  await write('postcss.config.js', `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`);
  await write('src/index.css', `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`);
  await write('index.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);

  const pageMeta: { route: string; comp: string; file: string }[] = [];
  let rebuilt = 0, failed = 0, totalTokens = 0;
  const errors: string[] = [];

  for (const r of routes) {
    const cap = manifest.pages.find((p) => p.route === r.route);
    if (!cap) continue;
    const slug = cap.files.dom.split('/')[0];
    onProgress?.(`AI-rebuilding ${r.route}…`);
    try {
      const irPath = join(captureDir, slug, 'page.ir.json');
      const ir = JSON.parse(await readFile(irPath, 'utf-8'));
      const brief = buildBrief(ir);
      const result = await rebuildPageWithAI({ route: r.route, title: ir.title ?? '', brief });
      const comp = routeToComp(r.route);
      const file = routeToFile(r.route);
      if (result.ok && result.code) {
        let code = result.code;
        if (!/export\s+default/.test(code)) code += `\n\nexport default Page;\n`;
        await write(`src/pages/${file}.tsx`, code);
        rebuilt++;
        totalTokens += (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
      } else {
        await write(`src/pages/${file}.tsx`, `export default function ${comp}() { return <div className="p-8">Page could not be rebuilt.</div>; }\n`);
        failed++;
        if (result.error) errors.push(`${r.route}: ${result.error}`);
      }
      pageMeta.push({ route: r.route, comp, file });
    } catch (e) {
      failed++;
      errors.push(`${r.route}: ${(e as Error).message}`);
    }
  }

  // dependency-free router (plain path switch — no react-router needed)
  const imports = pageMeta.map((p) => `import ${p.comp} from './pages/${p.file}';`).join('\n');
  const routeMap = pageMeta.map((p) => `  ${JSON.stringify(p.route)}: ${p.comp},`).join('\n');
  const first = pageMeta[0]?.comp ?? 'null';
  await write('src/main.tsx',
`import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
${imports}

const routes: Record<string, React.ComponentType> = {
${routeMap}
};

function App() {
  const path = (window.location.pathname.replace(/\\/$/, '') || '/');
  const Comp = routes[path] ?? routes[window.location.pathname] ?? ${first};
  return Comp ? <Comp /> : <div>Not found</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
`);

  await write('MOLT_OUTPUT.json', JSON.stringify({
    project: projectName, mode: 'ai-rebuild',
    routes: pageMeta.map((p) => p.route),
    pagesRebuilt: rebuilt, pagesFailed: failed,
  }, null, 2));

  return { ok: rebuilt > 0, pagesRebuilt: rebuilt, pagesFailed: failed, totalTokens, error: errors.length ? errors.slice(0, 3).join(' | ') : undefined };
}
