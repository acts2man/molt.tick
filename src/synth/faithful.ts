/**
 * Molt — Faithful visual reproduction.
 *
 * Philosophy (per product direction): Molt reproduces what a page LOOKS LIKE,
 * not what its plugins DO. Functionality is added later via Lovable. So instead
 * of re-deriving clean Tailwind from a computed-style sidecar (lossy — misses
 * backgrounds, gradients, pseudo-elements, fonts, hover states), we reproduce
 * the page from its ORIGINAL DOM + ORIGINAL CSS. That's the same HTML and the
 * same styles, so it renders pixel-accurate.
 *
 * Output stays Lovable-editable: a React/Vite project, one route per page, each
 * rendering its captured markup with the original stylesheets applied. Scripts
 * are stripped (visual only). Asset/font URLs are absolutized so they load.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureManifest, PageCapture } from '../ir/types.js';

export interface FaithfulInput {
  captureDir: string;
  manifest: CaptureManifest;
  outDir: string;
  projectName?: string;
  routes: { route: string; slug: string }[]; // which pages to emit
}

const routeToComp = (route: string) =>
  route === '/' ? 'Home' : route.slice(1).split(/[-/]/).map((s) => (s[0]?.toUpperCase() ?? '') + s.slice(1)).join('') || 'Page';
const routeToFile = (route: string) =>
  route === '/' ? 'index' : route.slice(1).replace(/\/$/, '').replace(/\//g, '.');

function absolutize(url: string, origin: string): string {
  if (!url || /^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return url;
  try { return new URL(url, origin).toString(); } catch { return url; }
}

/** Rewrite src/href/srcset/style-url asset refs in the DOM to absolute URLs. */
function absolutizeAssets(root: HTMLElement, origin: string): void {
  for (const el of root.querySelectorAll('[src]')) {
    const v = el.getAttribute('src'); if (v) el.setAttribute('src', absolutize(v, origin));
  }
  for (const el of root.querySelectorAll('[href]')) {
    const v = el.getAttribute('href'); if (v && !v.startsWith('#')) el.setAttribute('href', absolutize(v, origin));
  }
  for (const el of root.querySelectorAll('[srcset]')) {
    const v = el.getAttribute('srcset');
    if (v) el.setAttribute('srcset', v.split(',').map((part) => {
      const [u, d] = part.trim().split(/\s+/);
      return `${absolutize(u, origin)}${d ? ' ' + d : ''}`;
    }).join(', '));
  }
  // inline style="background-image:url(...)"
  for (const el of root.querySelectorAll('[style]')) {
    const v = el.getAttribute('style');
    if (v && /url\(/i.test(v)) {
      el.setAttribute('style', v.replace(/url\((['"]?)([^'")]+)\1\)/gi, (_m, q, u) => `url(${q}${absolutize(u, origin)}${q})`));
    }
  }
}

/** Rewrite same-origin internal page links to the React routes we emitted. */
function rewriteInternalLinks(root: HTMLElement, origin: string, routeSet: Set<string>): void {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href'); if (!href) continue;
    try {
      const u = new URL(href, origin);
      if (u.origin !== origin) continue; // external — leave
      const path = u.pathname.replace(/\/$/, '') || '/';
      if (routeSet.has(path)) a.setAttribute('href', path); // point at the SPA route
    } catch { /* leave */ }
  }
}

export async function synthesizeFaithful(input: FaithfulInput): Promise<{ files: string[] }> {
  const { captureDir, manifest, outDir, projectName = 'migrated-site', routes } = input;
  const origin = manifest.site;
  const routeSet = new Set(routes.map((r) => r.route));
  const written: string[] = [];
  const write = async (rel: string, body: string) => {
    const full = join(outDir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
    written.push(rel);
  };

  // ---- scaffold (Lovable-editable Vite React) ----
  await write('package.json', JSON.stringify({
    name: projectName, private: true, type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1', 'react-router-dom': '6.26.2' },
    devDependencies: { '@vitejs/plugin-react': '4.3.3', vite: '5.4.10' },
  }, null, 2));
  await write('vite.config.ts', `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`);
  await write('index.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);

  const pageMeta: { route: string; comp: string; file: string; bodyClass: string; cssRel: string }[] = [];

  // ---- per page: original DOM + original CSS ----
  for (const r of routes) {
    const cap = manifest.pages.find((p) => p.route === r.route);
    if (!cap) continue;
    const slug = cap.files.dom.split('/')[0];
    const rawHtml = await readFile(join(captureDir, cap.files.dom), 'utf-8');
    const doc = parse(rawHtml, { comment: false });

    // strip nodes that break in-app rendering or trigger external fetches/hangs:
    // scripts, the original stylesheet <link>s and <style> blocks (CSS is bundled
    // separately), preloads, and http-equiv metas.
    for (const s of doc.querySelectorAll(
      'script, noscript, link[rel="stylesheet"], link[rel="preload"], link[rel="dns-prefetch"], link[rel="preconnect"], style, meta[http-equiv]'
    )) s.remove();

    const body = doc.querySelector('body');
    const bodyClass = body?.getAttribute('class') ?? '';
    const bodyInner = body ? body.innerHTML : rawHtml;

    // rebuild a fragment to run asset/link rewrites over
    const frag = parse(bodyInner);
    absolutizeAssets(frag, origin);
    rewriteInternalLinks(frag, origin, routeSet);
    const cleanBody = frag.toString();

    // bundle this page's captured stylesheets into one CSS file
    let css = '';
    for (const sheet of cap.files.stylesheets) {
      try {
        let s = await readFile(join(captureDir, sheet), 'utf-8');
        // absolutize url(...) refs inside CSS (fonts, background images)
        s = s.replace(/url\((['"]?)([^'")]+)\1\)/gi, (_m, q, u) =>
          /^(https?:|data:|#)/i.test(u) ? `url(${q}${u}${q})` : `url(${q}${absolutize(u, origin)}${q})`);
        css += `\n/* ${sheet} */\n` + s;
      } catch { /* skip missing sheet */ }
    }
    const cssRel = `styles/${slug}.css`;
    await write(`src/${cssRel}`, css);

    const comp = routeToComp(r.route);
    const file = routeToFile(r.route);
    // the page component: apply the original body class to a wrapper, inject markup
    await write(`src/pages/${file}.tsx`,
`import './../${cssRel}';

/** Faithful reproduction of ${r.route} — original markup + original CSS. */
export default function ${comp}() {
  return (
    <div className=${JSON.stringify(bodyClass)} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(cleanBody)} }} />
  );
}
`);
    pageMeta.push({ route: r.route, comp, file, bodyClass, cssRel });
  }

  // ---- router entry ----
  const imports = pageMeta.map((p) => `import ${p.comp} from './pages/${p.file}';`).join('\n');
  const routeEls = pageMeta.map((p) => `        <Route path=${JSON.stringify(p.route)} element={<${p.comp} />} />`).join('\n');
  await write('src/main.tsx',
`import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
${imports}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
${routeEls}
    </Routes>
  </BrowserRouter>
);
`);

  await write('MOLT_OUTPUT.json', JSON.stringify({
    project: projectName, mode: 'faithful-visual',
    routes: pageMeta.map((p) => p.route),
    note: 'Faithful visual reproduction: original DOM + original CSS per page. Scripts stripped; add functionality via Lovable.',
  }, null, 2));

  return { files: written };
}
