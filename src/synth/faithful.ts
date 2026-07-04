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
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
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

/**
 * Trim CSS to only the rules a page actually uses. Collects every class, id and
 * tag present in the page DOM, then drops rules whose selectors reference none
 * of them. Always keeps at-rules (@font-face, @media wrappers, keyframes),
 * :root, and html/body rules. Cuts a 480KB theme sheet to a small fraction with
 * no visual change — and small enough that Lovable won't truncate it.
 */
function trimCssToUsed(css: string, dom: HTMLElement): string {
  // gather the page's tokens
  const classes = new Set<string>();
  const ids = new Set<string>();
  const tags = new Set<string>();
  for (const el of dom.querySelectorAll('*')) {
    tags.add(el.rawTagName?.toLowerCase() ?? '');
    const c = el.getAttribute('class');
    if (c) for (const cls of c.split(/\s+/)) if (cls) classes.add(cls);
    const id = el.getAttribute('id');
    if (id) ids.add(id);
  }
  const ALWAYS_TAGS = new Set(['html', 'body', ':root', '*', 'a', 'p', 'div', 'span', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'section', 'header', 'footer', 'button', 'input', 'form']);

  // does a selector reference anything the page has?
  const selectorUsed = (sel: string): boolean => {
    const s = sel.trim();
    if (!s) return false;
    if (/^(:root|html|body|\*)/.test(s)) return true;
    // class tokens
    for (const m of s.matchAll(/\.([A-Za-z0-9_-]+)/g)) if (classes.has(m[1])) return true;
    // id tokens
    for (const m of s.matchAll(/#([A-Za-z0-9_-]+)/g)) if (ids.has(m[1])) return true;
    // bare tag selectors (no . or #) — keep if the tag is present or common
    if (!s.includes('.') && !s.includes('#')) {
      for (const m of s.matchAll(/\b([a-z][a-z0-9]*)\b/g)) {
        if (tags.has(m[1]) || ALWAYS_TAGS.has(m[1])) return true;
      }
    }
    return false;
  };

  // walk the CSS, keeping used rules and all at-rules. Simple brace matcher that
  // preserves @media/@supports/@font-face/@keyframes blocks intact.
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    // at-rule
    if (css[i] === '@') {
      const blockStart = css.indexOf('{', i);
      const semi = css.indexOf(';', i);
      if (blockStart === -1 || (semi !== -1 && semi < blockStart)) {
        // statement at-rule (@import, @charset) — keep
        const end = semi === -1 ? n : semi + 1;
        out += css.slice(i, end); i = end; continue;
      }
      // block at-rule — capture balanced braces
      let depth = 0, j = blockStart;
      for (; j < n; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } } }
      const atHeader = css.slice(i, blockStart).trim();
      if (/@font-face|@keyframes|@import|@charset|:root/i.test(atHeader)) {
        out += css.slice(i, j) + '\n';                 // always keep
      } else {
        // @media / @supports — recurse into inner rules, keep used ones
        const inner = css.slice(blockStart + 1, j - 1);
        const trimmedInner = trimCssToUsed(inner, dom);
        if (trimmedInner.trim()) out += `${atHeader} {\n${trimmedInner}\n}\n`;
      }
      i = j; continue;
    }
    // normal rule: selector { ... }
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    let depth = 0, j = brace;
    for (; j < n; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } } }
    const selectors = css.slice(i, brace);
    const keep = selectors.split(',').some((sel) => selectorUsed(sel));
    if (keep) out += css.slice(i, j) + '\n';
    i = j;
  }
  return out;
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
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
    devDependencies: { '@vitejs/plugin-react': '4.3.3', vite: '5.4.10' },
  }, null, 2));
  await write('vite.config.ts', `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`);
  await write('index.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);

  const pageMeta: { route: string; comp: string; file: string; bodyClass: string; cssRel: string; slug: string }[] = [];

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

    // bundle this page's captured stylesheets, then TRIM to only rules the page
    // actually uses. The full theme CSS is ~480KB (mostly unused) which Lovable
    // truncates/chokes on. Trimming to used rules drops it to a fraction and
    // keeps the visual result identical.
    let css = '';
    for (const sheet of cap.files.stylesheets) {
      try {
        let s = await readFile(join(captureDir, sheet), 'utf-8');
        s = s.replace(/url\((['"]?)([^'")]+)\1\)/gi, (_m, q, u) => {
          // leave already-local font paths (crawler rewrote fonts to ../fonts/…)
          if (u.startsWith('../fonts/') || u.startsWith('./')) return `url(${q}${u}${q})`;
          return /^(https?:|data:|#)/i.test(u) ? `url(${q}${u}${q})` : `url(${q}${absolutize(u, origin)}${q})`;
        });
        css += `\n/* ${sheet} */\n` + s;
      } catch { /* skip missing sheet */ }
    }
    css = trimCssToUsed(css, frag);
    const cssRel = `styles/${slug}.css`;
    await write(`src/${cssRel}`, css);

    // copy this page's downloaded font files into src/fonts/ so the CSS
    // ../fonts/… paths resolve in the built app.
    try {
      const fontsDir = join(captureDir, slug, 'fonts');
      const fontNames = await readdir(fontsDir).catch(() => [] as string[]);
      for (const fn of fontNames) {
        const buf = await readFile(join(fontsDir, fn));
        await mkdir(join(outDir, 'src', 'fonts'), { recursive: true });
        await writeFile(join(outDir, 'src', 'fonts', fn), buf);
      }
    } catch { /* no fonts for this page */ }

    const comp = routeToComp(r.route);
    const file = routeToFile(r.route);
    // Write the (large) HTML to a SEPARATE file imported as a raw string via
    // Vite's `?raw`. Embedding 300KB+ of live-site HTML directly in the .tsx
    // source breaks esbuild's transform (500 errors → blank pages). As a raw
    // import, the markup never goes through the JS parser, so it can't break it.
    const htmlRel = `html/${slug}.html`;
    await write(`src/${htmlRel}`, cleanBody);
    await write(`src/pages/${file}.tsx`,
`import { useEffect } from 'react';
import './../${cssRel}';
import html from './../${htmlRel}?raw';

/**
 * Faithful reproduction of ${r.route}. The original page's <body> classes are
 * applied to document.body (not a wrapper div) because the theme CSS targets
 * them as \`body.<class> .something\` — putting them on a div would silently
 * break hundreds of layout rules.
 */
const BODY_CLASSES = ${JSON.stringify(bodyClass)}.split(/\\s+/).filter(Boolean);

export default function ${comp}() {
  useEffect(() => {
    document.body.classList.add(...BODY_CLASSES);
    return () => document.body.classList.remove(...BODY_CLASSES);
  }, []);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
`);
    pageMeta.push({ route: r.route, comp, file, bodyClass, cssRel, slug });
  }

  // ---- entry: dependency-free routing ----
  // We deliberately DON'T use react-router-dom — relying on it being in the
  // pre-baked image is fragile (a missing module = blank page). Plain React +
  // a window.location.pathname switch needs only react/react-dom, which are
  // always present. The render harness navigates real paths; this matches them.
  const imports = pageMeta.map((p) => `import ${p.comp} from './pages/${p.file}';`).join('\n');
  const routeMap = pageMeta.map((p) => `  ${JSON.stringify(p.route)}: ${p.comp},`).join('\n');
  const firstComp = pageMeta[0]?.comp ?? 'null';
  await write('src/main.tsx',
`import React from 'react';
import { createRoot } from 'react-dom/client';
${imports}

const routes: Record<string, React.ComponentType> = {
${routeMap}
};

function App() {
  const path = (window.location.pathname.replace(/\\/$/, '') || '/');
  const Comp = routes[path] ?? routes[window.location.pathname] ?? ${firstComp};
  return Comp ? <Comp /> : <div>Not found</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
`);

  await write('MOLT_OUTPUT.json', JSON.stringify({
    project: projectName, mode: 'faithful-visual',
    routes: pageMeta.map((p) => p.route),
    // per-page metadata the ship step uses to generate TanStack Router files
    pages: pageMeta.map((p) => ({ route: p.route, slug: p.slug, bodyClass: p.bodyClass })),
    note: 'Faithful visual reproduction: original DOM + original CSS per page. Scripts stripped; add functionality via Lovable.',
  }, null, 2));

  return { files: written };
}
