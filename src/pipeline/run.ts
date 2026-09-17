/** Crawl -> normalize -> plan -> AI rebuild -> real render -> acceptance gate. */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crawl, normalizeStartUrl, type CrawlScope } from '../crawl/crawler.js';
import { normalizePage } from '../normalize/elementor.js';
import { buildPlan, type PlanInput } from '../plan/plan.js';
import { synthesizeWithAI } from '../synth/synthesize-ai.js';
import { verifyStructure } from '../verify/structure.js';
import { renderAndDiff } from '../verify/render.js';
import { verifyProductionBuild } from '../verify/build.js';
import { assessQuality, pixelThreshold, type QualityReport } from '../verify/quality.js';
import { shipToNewRepo } from '../ship/ship.js';
import type { CaptureManifest, ComputedEntry, PageIR } from '../ir/types.js';

export type Stage = 'crawl' | 'normalize' | 'plan' | 'synthesize' | 'verify' | 'ship';
export type MigrationStatus = 'crawling' | 'normalizing' | 'planning' | 'synthesizing' | 'verifying' | 'shipping' | 'review' | 'shipped' | 'error';
export interface ProgressEvent {
  stage: Stage;
  status: MigrationStatus;
  message: string;
  pages?: PageResult[];
  flags?: FlagResult[];
}
export interface PageResult {
  route: string;
  title: string;
  section_count: number;
  widget_count: number;
  pixel_match: number | null;
  status: 'pending' | 'verified' | 'flagged';
  /** Generated output ONLY. Never substitute an original-source screenshot. */
  screenshot_path?: string;
  /** Preserved as local evidence; existing workers ignore this optional field. */
  source_screenshot_path?: string;
  slug?: string;
}
export interface FlagResult {
  page_route: string;
  kind: string;
  summary: string;
  detail: string;
}
export interface PipelineResult {
  status: MigrationStatus;
  site_url: string;
  output_repo: string;
  elapsed_seconds: number;
  pages: PageResult[];
  flags: FlagResult[];
  assets: number;
  routeChecks: { passed: number; total: number };
  outDir: string;
  verification?: QualityReport;
  error?: string;
}
export interface PipelineOptions {
  siteUrl: string;
  workDir: string;
  outputRepo?: string;
  maxPages?: number;
  reuseCaptureDir?: string;
  scope?: CrawlScope;
  urls?: string[];
  /** Existing ship implementation creates a NEW repo; this is its name, not an import target. */
  shipRepo?: string;
  onProgress?: (e: ProgressEvent) => void | Promise<void>;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  let stage: Stage = 'synthesize';
  let siteUrl = opts.siteUrl;
  let outputRepo = opts.outputRepo ?? 'migrated-site';
  let outDir = join(opts.workDir, 'site');
  const captureDir = opts.reuseCaptureDir ?? join(opts.workDir, 'capture');
  let pages: PageResult[] = [];
  let flags: FlagResult[] = [];
  let assets = 0;
  let routeChecks = { passed: 0, total: 0 };
  let verification: QualityReport | undefined;
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  const emit = async (e: ProgressEvent) => { stage = e.stage; await opts.onProgress?.(e); };

  try {
    // A missing model/key is configuration failure, NOT permission to ship captured HTML.
    if (process.env.MOLT_AI_REBUILD !== '1' || !process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error('Reconstruction requires MOLT_AI_REBUILD=1 and ANTHROPIC_API_KEY on the engine worker. Raw WordPress snapshot fallback is disabled.');
    }
    const threshold = pixelThreshold(process.env.MOLT_MIN_PIXEL_MATCH);
    stage = 'crawl';
    siteUrl = normalizeStartUrl(opts.siteUrl);
    outputRepo = opts.outputRepo ?? deriveRepo(siteUrl);
    await mkdir(opts.workDir, { recursive: true });
    // A failed earlier run must not supply stale page files or screenshots to a retry.
    outDir = await mkdtemp(join(opts.workDir, 'site-'));
    let manifest: CaptureManifest;
    if (opts.reuseCaptureDir) {
      manifest = JSON.parse(await readFile(join(captureDir, 'manifest.json'), 'utf8'));
      await emit({ stage, status: 'crawling', message: `Using supplied capture (${manifest.pages.length} pages)` });
    } else {
      await emit({ stage, status: 'crawling', message: `Capturing ${siteUrl}` });
      manifest = await crawl({ startUrl: siteUrl, outDir: captureDir, maxPages: opts.maxPages ?? 50, scope: opts.scope ?? 'core', urls: opts.urls });
    }
    if (!manifest.pages.length) throw new Error('No pages were captured. Check source access or supply a complete capture.');
    assets = manifest.pages.reduce((n, p) => n + p.stats.assets, 0);

    await emit({ stage: 'normalize', status: 'normalizing', message: 'Reading page structure and visual evidence' });
    const inputs: PlanInput[] = [];
    const irByRoute = new Map<string, PageIR>();
    for (const p of manifest.pages) {
      const ir = await normalizePage(join(captureDir, p.files.dom), join(captureDir, p.files.computed));
      ir.route = p.route;
      const dom = await readFile(join(captureDir, p.files.dom), 'utf8');
      const computed = JSON.parse(await readFile(join(captureDir, p.files.computed), 'utf8')) as ComputedEntry[];
      inputs.push({ route: p.route, ir, dom, computed });
      irByRoute.set(p.route, ir);
    }
    pages = manifest.pages.map((p) => {
      const ir = irByRoute.get(p.route)!;
      const source = join(captureDir, p.files.screenshot);
      return {
        route: p.route, title: p.title,
        section_count: ir.sections.length,
        widget_count: ir.sections.reduce((n, s) => n + s.columns.reduce((m, c) => m + c.widgets.length, 0), 0),
        pixel_match: null, status: 'pending' as const,
        source_screenshot_path: existsSync(source) ? source : undefined,
        slug: p.files.dom.split('/')[0],
      };
    });
    await emit({ stage: 'plan', status: 'planning', message: 'Planning shared components and required decisions' });
    const plan = buildPlan(inputs);
    flags = plan.flags.map((f) => ({ page_route: f.page, kind: f.kind, summary: f.summary, detail: f.detail }));
    await emit({ stage: 'plan', status: 'planning', message: `${plan.stats.chromeSections} shared sections; ${flags.length} decisions`, flags });

    const routes = pages.map((p) => ({ route: p.route, slug: p.slug! }));
    await emit({ stage: 'synthesize', status: 'synthesizing', message: 'Reconstructing pages from visual evidence' });
    const ai = await synthesizeWithAI({ captureDir, manifest, outDir, projectName: outputRepo, routes });
    if (!ai.ok || ai.pagesFailed !== 0 || ai.pagesRebuilt !== routes.length) {
      throw new Error(`Reconstruction incomplete: ${ai.pagesRebuilt}/${routes.length} pages; ${ai.pagesFailed} failed. ${ai.error ?? ''}`.trim());
    }

    await emit({ stage: 'verify', status: 'verifying', message: 'Checking the generated project' });
    const structure = await verifyStructure(outDir, plan);
    routeChecks = structure.routeChecks;
    if (!structure.pass) {
      await writeFile(join(outDir, 'MOLT_VERIFICATION.json'), JSON.stringify({ structure }, null, 2));
      throw new Error(`Generated project failed structural checks: ${structure.integrityIssues.join('; ') || 'missing routes, scaffold or invalid links'}`);
    }
    await emit({ stage: 'verify', status: 'verifying', message: 'Rendering the generated React pages and measuring visual differences' });
    const rendered = await renderAndDiff(outDir, captureDir, routes);
    // A renderer result must also point to an actual NEW screenshot in this run.
    const measurements = rendered.map((r) => {
      const hasScreenshot = existsSync(join(outDir, 'renders', `${r.slug}.png`));
      return hasScreenshot ? r : { ...r, rendered: false, pixelMatch: null, note: 'Generated screenshot is missing' };
    });
    const build = await verifyProductionBuild(outDir);
    verification = assessQuality(routes.map((r) => r.route), measurements, structure.pass, threshold);
    if (!build.ok) {
      verification.pass = false;
      verification.issues.push(build.error ?? 'Production build failed');
    }
    const flaggedRoutes = new Set(flags.map((f) => f.page_route.split(' ')[0]));
    pages = pages.map((p) => {
      const check = verification!.checks.find((c) => c.route === p.route)!;
      const result = measurements.find((r) => r.route === p.route);
      const candidate = join(outDir, 'renders', `${p.slug}.png`);
      return {
        ...p, pixel_match: check.score,
        status: build.ok && check.pass && !flaggedRoutes.has(p.route) ? 'verified' : 'flagged',
        screenshot_path: result?.rendered && existsSync(candidate) ? candidate : undefined,
      };
    });
    await writeFile(join(outDir, 'MOLT_VERIFICATION.json'), JSON.stringify({
      scope: 'production compilation and desktop screenshot comparison; not a guarantee of interaction or mobile fidelity',
      build, structure, verification,
      pages: pages.map((p) => ({ route: p.route, source: p.source_screenshot_path, generated: p.screenshot_path })),
    }, null, 2));
    await emit({ stage: 'verify', status: 'verifying', message: `${verification.checks.filter((c) => c.pass).length}/${pages.length} pages passed the measured threshold`, pages });
    if (!verification.pass) {
      throw new Error(`Visual acceptance failed. Automatic export blocked. ${[...verification.issues, ...verification.checks.filter((c) => !c.pass).map((c) => `${c.route}: ${c.reason}`)].join('; ')}`);
    }

    const shouldShip = opts.shipRepo ?? process.env.MOLT_SHIP_REPO;
    // Detecting a backend/plugin decision is not resolving it. Never auto-export unresolved work.
    if (shouldShip && flags.length === 0) {
      await emit({ stage: 'ship', status: 'shipping', message: 'Exporting the verified reconstruction to a new repository' });
      const shipped = await shipToNewRepo({ outDir, repoName: shouldShip === '1' ? outputRepo : shouldShip, commitMessage: `Molt reconstruction of ${siteUrl}` });
      if (!shipped.pushed) throw new Error(`Repository export failed: ${shipped.error ?? 'unknown error'}`);
      outputRepo = shipped.repoUrl || outputRepo;
      await emit({ stage: 'ship', status: 'shipped', message: `Repository created: ${outputRepo}`, pages, flags });
      return { status: 'shipped', site_url: siteUrl, output_repo: outputRepo, elapsed_seconds: elapsed(), pages, flags, assets, routeChecks, outDir, verification };
    }
    await emit({ stage: 'verify', status: 'review', message: flags.length
      ? 'Visual checks passed. Manual decisions remain; automatic export blocked.'
      : 'Visual checks passed. Ready for manual review.', pages, flags });
    return { status: 'review', site_url: siteUrl, output_repo: outputRepo, elapsed_seconds: elapsed(), pages, flags, assets, routeChecks, outDir, verification };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never relabel a verification/export failure as a crawl failure or discard its evidence.
    try { await emit({ stage, status: 'error', message, pages, flags }); }
    catch (progressError) { console.error('[pipeline] could not report failure', progressError); }
    return { status: 'error', site_url: siteUrl, output_repo: outputRepo, elapsed_seconds: elapsed(), pages, flags, assets, routeChecks, outDir, verification, error: message };
  }
}

function deriveRepo(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '').split('.')[0] + '-react';
}
