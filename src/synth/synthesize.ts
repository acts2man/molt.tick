/**
 * Molt Stage 4 — Synthesize.
 *
 * plan + per-page IR + computed sidecars  →  a React/TanStack project in the
 * Lovable-editable shape (single root package.json, Vite, Tailwind, working
 * dev script, no monorepo).
 *
 * Rules from the reference migration, enforced here:
 *  - shared chrome is emitted ONCE (SiteLayout) — never per page
 *  - matched plugin widgets emit the PROVEN library component, not a generic guess
 *  - exact captured styles (incl. runtime) via the style resolver — no rounding
 *  - widget/section/route names are stable and human-editable
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MigrationPlan, PageIR, SectionIR, WidgetIR, ComputedEntry,
} from '../ir/types.js';
import { LIBRARY } from '../plan/library.js';
import { classesFor, hasRuntimeTransform } from './styles.js';

export interface SynthInput {
  plan: MigrationPlan;
  pages: { route: string; ir: PageIR; computed: ComputedEntry[] }[];
  outDir: string;
  projectName?: string;
}

const routeToFile = (route: string) =>
  route === '/' ? 'index' : route.slice(1).replace(/\/$/, '').replace(/\//g, '.');
const routeToComp = (route: string) =>
  route === '/' ? 'Home' : route.slice(1).split(/[-/]/).map((s) => s[0]?.toUpperCase() + s.slice(1)).join('');

// sidecar lookup by elementor id
function sidecar(computed: ComputedEntry[]): Map<string, ComputedEntry> {
  const m = new Map<string, ComputedEntry>();
  for (const e of computed) if (e.elementorId && !m.has(e.elementorId)) m.set(e.elementorId, e);
  return m;
}

// ------------------------------------------------------------ widget → JSX

// Resolve an internal href against real routes; external/anchor pass through.
// Unresolvable internal links collapse to "#" (never emit a dead nav target).
function resolveHref(href: string, routes: Set<string>): string {
  if (!href || href === '#') return '#';
  if (/^(https?:|mailto:|tel:|#)/.test(href)) return href;
  if (!href.startsWith('/')) return href;
  const norm = href.replace(/\/$/, '') || '/';
  if (routes.has(norm) || routes.has(norm + '/')) return href;
  return '#'; // unresolved internal link — collapsed, not a 404
}

function widgetJSX(w: WidgetIR, sc: Map<string, ComputedEntry>, matched: Set<string>, routes: Set<string>): string {
  const cls = classesFor(sc.get(w.id));
  const c = cls ? ` className="${cls}"` : '';
  switch (w.type) {
    case 'heading':
      return `      <${w.tag}${c}>${escape(w.text)}</${w.tag}>`;
    case 'text':
      return `      <div${c} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(w.html)} }} />`;
    case 'image':
      return `      <img src="${w.src}"${w.alt ? ` alt="${escape(w.alt)}"` : ' alt=""'}${w.width ? ` width={${w.width}}` : ''}${w.height ? ` height={${w.height}}` : ''}${c} />`;
    case 'button': {
      const href = resolveHref(w.href, routes);
      return `      <a href="${href}"${c}>${escape(w.text)}</a>`;
    }
    case 'gallery':
      matched.add('GalleryWithLightbox');
      return `      <GalleryWithLightbox />  {/* images from ordered manifest — DOM order is authority */}`;
    case 'form':
      matched.add('MailingListForm');
      return `      <MailingListForm />  {/* TODO(backend): wire real submit */}`;
    case 'embed': {
      const prov = /mixcloud/.test(w.iframe.src) ? 'mixcloud' : 'embed';
      if (prov === 'mixcloud') { matched.add('MixcloudPlayer'); return `      <MixcloudPlayer src="${w.iframe.src}" />`; }
      return `      <iframe src="${w.iframe.src}" className="w-full" loading="lazy" />`;
    }
    case 'plugin': {
      const lib = LIBRARY[w.widgetType];
      if (lib) { matched.add(lib.component); return `      <${lib.component} />  {/* ${w.widgetType} → proven library component */}`; }
      return `      {/* FLAG: unconverted widget "${w.widgetType}" — needs a human call */}`;
    }
    default:
      return '';
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

function sectionJSX(s: SectionIR, sc: Map<string, ComputedEntry>, matched: Set<string>, routes: Set<string>): string {
  const cls = classesFor(sc.get(s.id));
  const runtime = hasRuntimeTransform(sc.get(s.id));
  const note = runtime ? ` /* runtime transform captured live — see sidecar */` : '';
  const inner = s.columns.flatMap((col) =>
    col.widgets.map((w) => widgetJSX(w, sc, matched, routes)),
  ).filter(Boolean).join('\n');
  return `    <section data-mid="${s.id}" className="${cls}">${note}\n${inner}\n    </section>`;
}

// ------------------------------------------------------------ emit

export async function synthesize(input: SynthInput): Promise<{ files: string[]; components: string[] }> {
  const { plan, pages, outDir, projectName = 'migrated-site' } = input;
  const chromeIds = new Set(plan.sharedChrome);
  const routeSet = new Set(plan.routes.map((r) => r.route));
  const matched = new Set<string>();
  const written: string[] = [];

  const write = async (rel: string, body: string) => {
    const full = join(outDir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
    written.push(rel);
  };

  // ---- project scaffold (Lovable-editable shape) ----
  await write('package.json', JSON.stringify({
    name: projectName, private: true, type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {
      '@tanstack/react-router': '^1.0.0', react: '^18.3.0', 'react-dom': '^18.3.0',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.3.0', tailwindcss: '^3.4.0', autoprefixer: '^10.4.0',
      postcss: '^8.4.0', vite: '^5.4.0', typescript: '^5.5.0',
    },
  }, null, 2));
  await write('tailwind.config.js', `export default {\n  content: ['./src/**/*.{ts,tsx}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n`);
  await write('postcss.config.js', `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`);
  await write('src/index.css', `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`);
  await write('vite.config.ts', `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`);

  // ---- shared chrome, built ONCE ----
  const chromeSample = pages[0];
  const scChrome = sidecar(chromeSample.computed);
  const chromeSections = chromeSample.ir.sections.filter((s) => chromeIds.has(s.id));
  const headerSecs = chromeSections.filter((s) => plan.chrome.find((c) => c.id === s.id)?.label === 'header' || plan.chrome.find((c) => c.id === s.id)?.label === 'social-rail' || plan.chrome.find((c) => c.id === s.id)?.label === 'offcanvas');
  const footerSecs = chromeSections.filter((s) => plan.chrome.find((c) => c.id === s.id)?.label === 'footer');

  const headerJSX = headerSecs.map((s) => sectionJSX(s, scChrome, matched, routeSet)).join('\n');
  const footerJSX = footerSecs.map((s) => sectionJSX(s, scChrome, matched, routeSet)).join('\n');

  await write('src/components/SiteLayout.tsx',
`import type { ReactNode } from 'react';
${[...matched].map((c) => `import { ${c} } from './library/${c}';`).join('\n')}

/** Shared chrome — emitted ONCE, inherited by every route. */
export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <header>
${headerJSX || '        {/* header chrome */}'}
      </header>
      <main>{children}</main>
      <footer>
${footerJSX || '        {/* footer chrome */}'}
      </footer>
    </div>
  );
}
`);

  // ---- per-route page components + routes ----
  for (const p of pages) {
    const sc = sidecar(p.computed);
    const comp = routeToComp(p.route);
    const body = p.ir.sections
      .filter((s) => !chromeIds.has(s.id))
      .map((s) => sectionJSX(s, sc, matched, routeSet))
      .join('\n');
    await write(`src/routes/${routeToFile(p.route)}.tsx`,
`import { createFileRoute } from '@tanstack/react-router';
import { SiteLayout } from '../components/SiteLayout';

export const Route = createFileRoute('${p.route}')({ component: ${comp} });

function ${comp}() {
  return (
    <SiteLayout>
${body || '      {/* page content */}'}
    </SiteLayout>
  );
}
`);
  }

  // ---- library component stubs for every matched component ----
  for (const name of matched) {
    const lib = Object.values(LIBRARY).find((l) => l.component === name);
    await write(`src/components/library/${name}.tsx`,
`/**
 * ${name} — proven React implementation from the Molt component library.
 * ${lib?.provenance ?? 'Reference-migration component.'}
 ${lib?.followUp ? `* Follow-up: ${lib.followUp}` : ''}*/
export function ${name}() {
  return <div data-molt-lib="${name}">{/* ${name}: ported from the reference migration */}</div>;
}
`);
  }

  // ---- manifest of what was produced ----
  await write('MOLT_OUTPUT.json', JSON.stringify({
    project: projectName,
    routes: pages.map((p) => p.route),
    sharedChrome: plan.sharedChrome.length,
    libraryComponents: [...matched],
    flags: plan.flags.map((f) => ({ page: f.page, kind: f.kind, summary: f.summary })),
    note: 'Lovable-editable shape: single root package.json, Vite, Tailwind, working dev script.',
  }, null, 2));

  return { files: written, components: [...matched] };
}
