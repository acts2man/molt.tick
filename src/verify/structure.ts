/**
 * Static output-contract checks. These are not browser click-through tests.
 * Accept the current src/pages scaffold and the legacy src/routes scaffold.
 * Actual compilation, runtime behavior and responsive fidelity need separate tests.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationPlan } from '../ir/types.js';

export interface RouteCheck {
  route: string;
  fileExists: boolean;
  internalLinks: number;
  deadLinks: string[];
  componentsUsed: string[];
  componentsUnimported: string[];
}

export interface VerifyReport {
  routeChecks: { passed: number; total: number };
  scaffold: { file: string; present: boolean }[];
  routes: RouteCheck[];
  deadLinkTotal: number;
  unimportedTotal: number;
  flagsRepresented: { kind: string; page: string; found: boolean }[];
  integrityIssues: string[];
  pass: boolean;
}

function fileForRoute(route: string): string {
  if (!route.startsWith('/') || route.startsWith('//') || /[\\?#\0]/.test(route)
    || route.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid route: ${route}`);
  }
  return route === '/' ? 'index' : route.slice(1).replace(/\/$/, '').replace(/\//g, '.');
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function sourcesUnder(directory: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await sourcesUnder(path));
    else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) results.push(path);
  }
  return results;
}

function cleanRoute(route: string): string {
  return route.replace(/\/+$/, '') || '/';
}

export async function verifyStructure(siteDir: string, plan: MigrationPlan): Promise<VerifyReport> {
  const issues: string[] = [];
  const current = await exists(join(siteDir, 'src/main.tsx'));
  const routeDir = current ? 'src/pages' : 'src/routes';
  const known = new Set(plan.routes.map((r) => cleanRoute(r.route)));
  if (!plan.routes.length) issues.push('No planned routes');
  if (known.size !== plan.routes.length) issues.push('Duplicate normalized routes');
  const names = new Set<string>();
  const routes: RouteCheck[] = [];
  let output: { mode?: string; routes?: string[]; pagesFailed?: number } = {};
  try {
    output = JSON.parse(await readFile(join(siteDir, 'MOLT_OUTPUT.json'), 'utf8'));
    if (!Array.isArray(output.routes) || output.routes.some((r) => typeof r !== 'string')
      || output.routes.length !== known.size || new Set(output.routes.map(cleanRoute)).size !== known.size
      || output.routes.some((r) => !known.has(cleanRoute(r)))) {
      issues.push('Output manifest does not cover the planned routes exactly');
    }
    if (typeof output.pagesFailed === 'number' && output.pagesFailed > 0) issues.push('Output records failed pages');
    if (output.mode === 'faithful-visual') issues.push('A captured HTML snapshot is not an independent React rebuild');
  } catch { issues.push('Missing or invalid MOLT_OUTPUT.json'); }

  for (const r of plan.routes) {
    let file = '';
    try { file = fileForRoute(r.route); } catch (e) { issues.push((e as Error).message); }
    if (file && names.has(file)) issues.push(`Route filename collision: ${r.route}`);
    names.add(file);
    const fileExists = !!file && await exists(join(siteDir, routeDir, `${file}.tsx`));
    const check: RouteCheck = { route: r.route, fileExists, internalLinks: 0, deadLinks: [], componentsUsed: [], componentsUnimported: [] };
    if (fileExists) {
      const src = await readFile(join(siteDir, routeDir, `${file}.tsx`), 'utf8');
      if (!src.trim()) issues.push(`Empty route component: ${r.route}`);
      if (/Page could not be rebuilt\./.test(src)) issues.push(`Failure placeholder: ${r.route}`);
      for (const match of src.matchAll(/href\s*=\s*(?:\{\s*)?["'](\/[^"']*)["']/g)) {
        if (match[1].startsWith('//')) continue; // External protocol-relative link.
        const href = cleanRoute(match[1].split(/[?#]/)[0]);
        check.internalLinks++;
        if (!known.has(href)) check.deadLinks.push(match[1]);
      }
    }
    routes.push(check);
  }

  // A deliberately conservative independence guard, not an XSS sanitizer.
  // Rich text/SVG exceptions require an explicit future contract, not silent raw-page injection.
  for (const path of await sourcesUnder(join(siteDir, 'src'))) {
    const src = await readFile(path, 'utf8');
    if (/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML\s*\(|\.html\?raw/.test(src)) {
      issues.push(`Captured/raw HTML injection in ${path.slice(siteDir.length + 1)}`);
    }
    // Check relative module imports in their OWN module, not against imports in a different file.
    for (const match of src.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const modulePath = match[1].split('?')[0];
      const base = join(path, '..', modulePath);
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.css'].map((ext) => base + ext), join(base, 'index.ts'), join(base, 'index.tsx')];
      if (!(await Promise.all(candidates.map(exists))).some(Boolean)) {
        issues.push(`Unresolved relative import ${match[1]} in ${path.slice(siteDir.length + 1)}`);
      }
    }
  }
  const required = current
    ? ['package.json', 'vite.config.ts', 'index.html', 'src/main.tsx', 'src/index.css', 'tailwind.config.js', 'postcss.config.js']
    : ['package.json', 'vite.config.ts', 'tailwind.config.js', 'src/index.css', 'src/components/SiteLayout.tsx'];
  const scaffold = await Promise.all(required.map(async (file) => ({ file, present: await exists(join(siteDir, file)) })));
  const passed = routes.filter((r) => r.fileExists && !r.deadLinks.length).length;
  const deadLinkTotal = routes.reduce((n, r) => n + r.deadLinks.length, 0);
  return {
    routeChecks: { passed, total: routes.length }, scaffold, routes, deadLinkTotal,
    unimportedTotal: issues.filter((i) => i.startsWith('Unresolved relative import')).length,
    // A recorded flag is not proof that its missing backend or widget was implemented.
    flagsRepresented: plan.flags.map((f) => ({ kind: f.kind, page: f.page, found: false })),
    integrityIssues: issues,
    pass: routes.length > 0 && passed === routes.length && scaffold.every((s) => s.present) && issues.length === 0,
  };
}
