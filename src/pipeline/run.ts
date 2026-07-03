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
import { crawl, normalizeStartUrl, type CrawlScope } from '../crawl/crawler.js';
import { normalizePage } from '../normalize/elementor.js';
import { buildPlan, type PlanInput } from '../plan/plan.js';
import { synthesizeFaithful } from '../synth/faithful.js';
import { verifyStructure } from '../verify/structure.js';
import { renderAndDiff, type RenderResult } from '../verify/render.js';
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
  scope?: CrawlScope;   // core | all | posts
  urls?: string[];      // explicit page list (skips discovery)
  onProgress?: (e: ProgressEvent) => void | Promise<void>;
}

const STATUS_FOR: Record<Stage, MigrationStatus> = {
  crawl: 'crawling', normalize: 'normalizing', plan: 'planning',
  synthesize: 'synthesizing', verify: 'verifying', ship: 'review',
};

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const {
    siteUrl: rawSiteUrl, workDir, outputRepo: rawOutputRepo, scope = 'core', urls: explicitUrls,
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
      manifest = await crawl({ startUrl: siteUrl, outDir: captureDir, maxPages, scope, urls: explicitUrls });
      await emit({ stage: 'crawl', status: 'crawling', message: `Captured ${manifest.pages.length} pages` });
    }

    // ---- Stage 2: normalize ----
    if (manifest.pages.length === 0) {
      throw new Error('No pages could be captured — the site may have blocked the crawler, or the page crashed during capture. Try again, or check that the URL loads in a browser.');
    }
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

    // ---- Stage 4: synthesize (FAITHFUL visual reproduction) ----
    // Original DOM + original CSS per page — reproduces what the page LOOKS like,
    // not what its plugins do. Functionality is added later via Lovable.
    await emit({ stage: 'synthesize', status: 'synthesizing', message: 'Reproducing pages (original DOM + CSS)…' });
    const faithfulRoutes = manifest.pages.map((p) => ({ route: p.route, slug: p.files.dom.split('/')[0] }));
    await synthesizeFaithful({ captureDir, manifest, outDir, projectName: outputRepo, routes: faithfulRoutes });
    await emit({ stage: 'synthesize', status: 'synthesizing', message: 'Pages reproduced' });

    // ---- Stage 5: verify ----
    await emit({ stage: 'verify', status: 'verifying', message: 'Verifying output…' });
    const structure = await verifyStructure(outDir, plan);

    // ---- Stage 5b: render + pixel-diff (heavy but resilient; never fails the run) ----
    // On by default; set MOLT_SKIP_RENDER=1 to disable. renderAndDiff is wrapped
    // so any failure returns dashes rather than throwing.
    // TIERING: only pixel-render CORE pages (the site's real nav pages), not
    // every blog post — faster, focused, and avoids blog posts bogging the build.
    const pixelBySlug = new Map<string, number | null>();
    let renderDiagnostic: FlagResult | null = null;
    if (process.env.MOLT_SKIP_RENDER !== '1') {
      await emit({ stage: 'verify', status: 'verifying', message: 'Rendering core pages for pixel-diff…' });
      try {
        const coreRoutes = new Set(manifest.corePages ?? manifest.pages.map((p) => p.route));
        const renderRoutes = manifest.pages
          .filter((p) => coreRoutes.has(p.route))
          .map((p) => ({ route: p.route, slug: p.files.dom.split('/')[0] }));
        console.log(`[pipeline] pixel-rendering ${renderRoutes.length} core page(s) of ${manifest.pages.length} total`);
        // HARD wall-clock cap on the whole render step — it can never hang the
        // migration. If it exceeds this, we take dashes and move on.
        const RENDER_WALL_MS = Number(process.env.MOLT_RENDER_WALL_MS ?? 180000); // 3 min
        const timeoutDashes: RenderResult[] = renderRoutes.map((r) => ({ ...r, pixelMatch: null, rendered: false, note: 'render wall-clock timeout' }));
        const rendered = await Promise.race([
          renderAndDiff(outDir, captureDir, renderRoutes),
          new Promise<RenderResult[]>((resolve) => setTimeout(() => resolve(timeoutDashes), RENDER_WALL_MS)),
        ]);
        for (const r of rendered) pixelBySlug.set(r.slug, r.pixelMatch);
        const scored = rendered.filter((r) => r.pixelMatch !== null).length;
        const reasons = [...new Set(rendered.map((r) => r.note).filter(Boolean))] as string[];
        if (scored === 0 && rendered.length > 0) {
          const detail = reasons.length ? reasons.join(' | ') : '(no reason captured)';
          console.error(`[pipeline] PIXEL RENDER PRODUCED 0 SCORES. reason(s): ${detail}`);
          // SURFACE TO DASHBOARD: appears in "Needs your call" so the reason is visible in-app.
          renderDiagnostic = {
            page_route: '(pixel render)', kind: 'render-diagnostic',
            summary: `Pixel render produced no scores (${rendered.length} core pages tried)`,
            detail: `Reason(s): ${detail}`,
          };
        } else {
          console.log(`[pipeline] pixel-diff: ${scored}/${rendered.length} core pages scored`);
          if (scored < rendered.length && reasons.length) {
            renderDiagnostic = {
              page_route: '(pixel render)', kind: 'render-diagnostic',
              summary: `Pixel render partial: ${scored}/${rendered.length} core pages scored`,
              detail: `Some pages didn't score. Reason(s): ${reasons.join(' | ')}`,
            };
          }
        }
        await emit({ stage: 'verify', status: 'verifying', message: `Pixel-diff: ${scored}/${renderRoutes.length} core pages scored` });
      } catch (e) {
        const detail = `${(e as Error).message}`;
        console.error('[pipeline] render step threw (unexpected):', detail, (e as Error).stack);
        renderDiagnostic = {
          page_route: '(pixel render)', kind: 'render-diagnostic',
          summary: 'Pixel render crashed unexpectedly',
          detail,
        };
      }
    }
    // fold the diagnostic into the flag list shown on the dashboard
    if (renderDiagnostic) flags.push(renderDiagnostic);

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
