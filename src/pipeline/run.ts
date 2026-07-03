/**
 * Molt — Pipeline orchestrator.
 *
 * One entry point that runs the whole engine for a single site:
 *   crawl → normalize → plan → synthesize → verify
 *
 * Emits a progress event as each stage begins/ends so a caller (the Supabase
 * worker) can stream live status into the platform's dashboard. Returns a
 * result shaped exactly like the platform's tables (migrations / pages / flags)
 * so the worker just writes it straight through.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { crawl, normalizeStartUrl } from '../crawl/crawler.js';
import { normalizePage } from '../normalize/elementor.js';
import { buildPlan, type PlanInput } from '../plan/plan.js';
import { synthesize } from '../synth/synthesize.js';
import { verifyStructure } from '../verify/structure.js';
import { renderAndDiff } from '../verify/render.js';
import { comparePixels } from '../verify/pixel.js';
import type {
  CaptureManifest, ComputedEntry, PageIR, MigrationPlan,
} from '../ir/types.js';

export type Stage = 'crawl' | 'normalize' | 'plan' | 'synthesize' | 'verify' | 'ship';
export type MigrationStatus =
  | 'crawling' | 'normalizing' | 'planning' | 'synthesizing' | 'verifying' | 'review' | 'shipped' | 'error';

export interface ProgressEvent {
  stage: Stage;
  status: MigrationStatus;
  message: string;
  /** incremental page/flag data as it becomes known */
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
}

export interface FlagResult {
  page_route: string;
  kind: string;
  summary: string;
  detail: string;
}

export interface PipelineResult {
  status: MigrationStatus;      // 'review' on success, 'error' on failure
  site_url: string;
  output_repo: string;
  elapsed_seconds: number;
  pages: PageResult[];
  flags: FlagResult[];
  assets: number;
  routeChecks: { passed: number; total: number };
  outDir: string;               // where the synthesized project was written
  error?: string;
}

export interface PipelineOptions {
  siteUrl: string;
  workDir: string;              // scratch dir for capture + output
  outputRepo?: string;
  maxPages?: number;
  /** when set, skip crawl and reuse an existing capture dir (validation/dev) */
  reuseCaptureDir?: string;
  onProgress?: (e: ProgressEvent) => void | Promise<void>;
}

const STATUS_FOR: Record<Stage, MigrationStatus> = {
  crawl: 'crawling', normalize: 'normalizing', plan: 'planning',
  synthesize: 'synthesizing', verify: 'verifying', ship: 'review',
};

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const {
    siteUrl: rawSiteUrl, workDir, outputRepo: rawOutputRepo,
    maxPages = 50, reuseCaptureDir, onProgress,
  } = opts;
  const siteUrl = normalizeStartUrl(rawSiteUrl);
  const outputRepo = rawOutputRepo ?? deriveRepo(siteUrl);
  const started = Date.now();
  const captureDir = reuseCaptureDir ?? join(workDir, 'capture');
  const outDir = join(workDir, 'site');
  const emit = async (e: ProgressEvent) => { if (onProgress) await onProgress(e); };

  try {
    // ---- Stage 1: crawl ----
    let manifest: CaptureManifest;
    if (reuseCaptureDir) {
      manifest = JSON.parse(await readFile(join(captureDir, 'manifest.json'), 'utf-8'));
      await emit({ stage: 'crawl', status: 'crawling', message: `Reusing capture (${manifest.pages.length} pages)` });
    } else {
      await emit({ stage: 'crawl', status: 'crawling', message: `Crawling ${siteUrl}…` });
      manifest = await crawl({ startUrl: siteUrl, outDir: captureDir, maxPages });
      await emit({ stage: 'crawl', status: 'crawling', message: `Captured ${manifest.pages.length} pages` });
    }

    // ---- Stage 2: normalize ----
    await emit({ stage: 'normalize', status: 'normalizing', message: 'Normalizing pages to IR…' });
    const planInputs: PlanInput[] = [];
    const irByRoute = new Map<string, PageIR>();
    const computedByRoute = new Map<string, ComputedEntry[]>();
    const domByRoute = new Map<string, string>();
    for (const p of manifest.pages) {
      const slug = p.files.dom.split('/')[0];
      const ir = await normalizePage(join(captureDir, slug, 'page.html'), join(captureDir, slug, 'computed.json'));
      ir.route = p.route;
      const dom = await readFile(join(captureDir, slug, 'page.html'), 'utf-8');
      const computed = JSON.parse(await readFile(join(captureDir, slug, 'computed.json'), 'utf-8')) as ComputedEntry[];
      planInputs.push({ route: p.route, ir, dom, computed });
      irByRoute.set(p.route, ir);
      computedByRoute.set(p.route, computed);
      domByRoute.set(p.route, dom);
    }
    await emit({ stage: 'normalize', status: 'normalizing', message: `Normalized ${planInputs.length} pages` });

    // ---- Stage 3: plan ----
    await emit({ stage: 'plan', status: 'planning', message: 'Planning migration…' });
    const plan: MigrationPlan = buildPlan(planInputs);
    const flags: FlagResult[] = plan.flags.map((f) => ({
      page_route: f.page, kind: f.kind, summary: f.summary, detail: f.detail,
    }));
    await emit({
      stage: 'plan', status: 'planning',
      message: `${plan.stats.chromeSections} shared sections · ${plan.library.length} components matched · ${plan.flags.length} flags`,
      flags,
    });

    // ---- Stage 4: synthesize ----
    await emit({ stage: 'synthesize', status: 'synthesizing', message: 'Synthesizing React project…' });
    const synthPages = manifest.pages.map((p) => ({
      route: p.route, ir: irByRoute.get(p.route)!, computed: computedByRoute.get(p.route)!, dom: domByRoute.get(p.route),
    }));
    await synthesize({ plan, pages: synthPages, outDir, projectName: outputRepo, siteUrl });
    await emit({ stage: 'synthesize', status: 'synthesizing', message: 'React project emitted' });

    // ---- Stage 5: verify ----
    await emit({ stage: 'verify', status: 'verifying', message: 'Verifying output…' });
    const structure = await verifyStructure(outDir, plan);

    // ---- Stage 5b: render + pixel-diff (heavy but resilient; never fails the run) ----
    // On by default; set MOLT_SKIP_RENDER=1 to disable. renderAndDiff is wrapped
    // so any failure returns dashes rather than throwing.
    const pixelBySlug = new Map<string, number | null>();
    if (process.env.MOLT_SKIP_RENDER !== '1') {
      await emit({ stage: 'verify', status: 'verifying', message: 'Rendering pages for pixel-diff…' });
      try {
        const renderRoutes = manifest.pages.map((p) => ({ route: p.route, slug: p.files.dom.split('/')[0] }));
        const rendered = await renderAndDiff(outDir, captureDir, renderRoutes);
        for (const r of rendered) pixelBySlug.set(r.slug, r.pixelMatch);
        const scored = rendered.filter((r) => r.pixelMatch !== null).length;
        await emit({ stage: 'verify', status: 'verifying', message: `Pixel-diff: ${scored}/${rendered.length} pages scored` });
      } catch (e) {
        // belt-and-suspenders: renderAndDiff already never throws, but guard anyway
        console.error('[pipeline] render step skipped:', (e as Error).message);
      }
    }

    // build per-page results; pixel_match from the render step (or null → "—")
    const flaggedRoutes = new Set(plan.flags.map((f) => f.page.split(' ')[0]));
    const pages: PageResult[] = [];
    for (const p of manifest.pages) {
      const ir = irByRoute.get(p.route)!;
      const slug = p.files.dom.split('/')[0];
      const sectionCount = ir.sections.length;
      const widgetCount = ir.sections.reduce((n, s) => n + s.columns.reduce((m, c) => m + c.widgets.length, 0), 0);
      const pixel = pixelBySlug.has(slug) ? pixelBySlug.get(slug)! : await tryPixel(captureDir, outDir, slug);
      pages.push({
        route: p.route, title: ir.title,
        section_count: sectionCount, widget_count: widgetCount,
        pixel_match: pixel,
        status: flaggedRoutes.has(p.route) ? 'flagged' : 'verified',
      });
    }
    await emit({ stage: 'verify', status: 'verifying', message: `Route checks ${structure.routeChecks.passed}/${structure.routeChecks.total}`, pages });

    // ---- done → review ----
    const assets = manifest.pages.reduce((n, p) => n + p.stats.assets, 0);
    const elapsed = Math.round((Date.now() - started) / 1000);
    await emit({ stage: 'ship', status: 'review', message: 'Ready for review', pages, flags });

    return {
      status: 'review', site_url: siteUrl, output_repo: outputRepo,
      elapsed_seconds: elapsed, pages, flags, assets,
      routeChecks: structure.routeChecks, outDir,
    };
  } catch (err) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const detail = `${(err as Error)?.message ?? String(err)}\n${(err as Error)?.stack ?? ''}`;
    console.error('[pipeline] FAILED:', detail);
    await emit({ stage: 'crawl', status: 'error', message: (err as Error)?.message ?? String(err) });
    return {
      status: 'error', site_url: siteUrl, output_repo: outputRepo,
      elapsed_seconds: elapsed, pages: [], flags: [], assets: 0,
      routeChecks: { passed: 0, total: 0 }, outDir, error: detail,
    };
  }
}

// pixel_match is only meaningful once a rendered screenshot of the synth output
// exists at <outDir>/renders/<slug>.png. Until the render step lands, return null
// (the platform shows "—") rather than a fabricated number.
async function tryPixel(captureDir: string, outDir: string, slug: string): Promise<number | null> {
  try {
    const original = join(captureDir, slug, 'original.png');
    const rendered = join(outDir, 'renders', `${slug}.png`);
    await readFile(rendered); // throws if not present
    const res = await comparePixels(original, rendered);
    return res.matchPct;
  } catch {
    return null;
  }
}

function deriveRepo(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.split('.')[0] + '-react';
  } catch {
    return 'migrated-site';
  }
}
