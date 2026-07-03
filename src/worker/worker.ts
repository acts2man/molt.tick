/**
 * Molt — Supabase worker.
 *
 * The wire between engine and platform. Polls the shared `migrations` table for
 * new rows the platform created, claims one, runs the pipeline, and streams the
 * result back into `migrations` / `pages` / `flags` — the same tables the
 * dashboard reads, so the UI fills in live.
 *
 * Env:
 *   SUPABASE_URL          project url
 *   SUPABASE_SERVICE_KEY  service-role key (server-side only; bypasses RLS)
 *   MOLT_WORKDIR          scratch dir for captures/output (default /tmp/molt-work)
 *   MOLT_POLL_MS          poll interval (default 4000)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runPipeline, type ProgressEvent, type PageResult, type FlagResult } from '../pipeline/run.js';

export interface WorkerConfig {
  supabaseUrl: string;
  serviceKey: string;
  workDir: string;
  pollMs: number;
}

export function configFromEnv(): WorkerConfig {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }
  return {
    supabaseUrl, serviceKey,
    workDir: process.env.MOLT_WORKDIR ?? '/tmp/molt-work',
    pollMs: Number(process.env.MOLT_POLL_MS ?? 4000),
  };
}

/** A migration row as the platform writes it. */
interface MigrationRow {
  id: string;
  site_url: string;
  output_repo: string | null;
  status: string;
  scope: string | null;   // core | all | posts (from the platform)
  page_urls: string | null;   // explicit newline/comma-separated page list
}

/**
 * Claim one queued migration atomically: flip status crawling→normalizing only
 * if it's still 'crawling', so two workers never grab the same row.
 * (The platform inserts new migrations with status='crawling'.)
 */
async function claimNext(db: SupabaseClient): Promise<MigrationRow | null> {
  const { data: candidates, error } = await db
    .from('migrations')
    .select('id, site_url, output_repo, status, scope, page_urls')
    .eq('status', 'crawling')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  if (!candidates || candidates.length === 0) return null;

  const row = candidates[0] as MigrationRow;
  // atomic claim: only succeeds if still 'crawling'
  const { data: claimed, error: claimErr } = await db
    .from('migrations')
    .update({ status: 'normalizing' })
    .eq('id', row.id)
    .eq('status', 'crawling')
    .select('id, site_url, output_repo, status, scope, page_urls');
  if (claimErr) throw claimErr;
  if (!claimed || claimed.length === 0) return null; // another worker won the race
  return row;
}

/** Write a progress event through to the platform's tables. */
async function applyProgress(db: SupabaseClient, migrationId: string, e: ProgressEvent): Promise<void> {
  // advance the migration status so the stage rail moves
  await db.from('migrations').update({ status: e.status }).eq('id', migrationId);

  // upsert pages when the event carries them (verify stage)
  if (e.pages?.length) {
    await db.from('pages').delete().eq('migration_id', migrationId); // idempotent re-write

    // upload each page's original screenshot to Supabase Storage, collect URLs
    const rows = [];
    for (const p of e.pages as PageResult[]) {
      let screenshot_url: string | null = null;
      if (p.screenshot_path) {
        try {
          const bytes = await readFile(p.screenshot_path);
          const key = `${migrationId}/${p.slug ?? p.route.replace(/\W+/g, '_')}.png`;
          const up = await db.storage.from('screenshots').upload(key, bytes, {
            contentType: 'image/png', upsert: true,
          });
          if (!up.error) {
            const { data } = db.storage.from('screenshots').getPublicUrl(key);
            screenshot_url = data.publicUrl;
          } else {
            console.error(`[worker] screenshot upload failed for ${p.route}: ${up.error.message}`);
          }
        } catch (err) {
          console.error(`[worker] screenshot read/upload error for ${p.route}: ${(err as Error).message}`);
        }
      }
      rows.push({
        migration_id: migrationId,
        route: p.route, title: p.title,
        section_count: p.section_count, widget_count: p.widget_count,
        pixel_match: p.pixel_match, status: p.status,
        screenshot_url,
      });
    }
    await db.from('pages').insert(rows);
  }

  // upsert flags when the event carries them (plan stage)
  if (e.flags?.length) {
    await db.from('flags').delete().eq('migration_id', migrationId);
    await db.from('flags').insert(e.flags.map((f: FlagResult) => ({
      migration_id: migrationId,
      page_route: f.page_route, kind: f.kind, summary: f.summary, detail: f.detail,
      approved: false,
    })));
  }
}

/** Process one migration end to end. */
export async function processMigration(db: SupabaseClient, row: MigrationRow, cfg: WorkerConfig): Promise<void> {
  const workDir = join(cfg.workDir, row.id);
  console.log(`[worker] processing ${row.id} · ${row.site_url}`);

  const result = await runPipeline({
    siteUrl: row.site_url,
    workDir,
    outputRepo: row.output_repo ?? undefined,
    scope: (row.scope as 'core' | 'all' | 'posts' | null) ?? 'core',
    urls: row.page_urls ? row.page_urls.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean) : undefined,
    reuseCaptureDir: process.env.MOLT_REUSE_CAPTURE || undefined,
    onProgress: (e) => applyProgress(db, row.id, e),
  });

  // finalize
  await db.from('migrations').update({
    status: result.status,
    output_repo: result.output_repo,
    elapsed_seconds: result.elapsed_seconds,
  }).eq('id', row.id);

  console.log(`[worker] ${row.id} → ${result.status} (${result.elapsed_seconds}s, ${result.pages.length} pages, ${result.flags.length} flags)`);
  if (result.status === 'error') {
    console.error(`[worker] ERROR REASON for ${row.id}: ${result.error ?? '(no message captured)'}`);
  }
}

/** Main loop: poll, claim, process, repeat. */
export async function runWorker(cfg: WorkerConfig, opts: { once?: boolean } = {}): Promise<void> {
  const db = createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false } });
  console.log(`[worker] up · polling every ${cfg.pollMs}ms · workdir ${cfg.workDir}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const row = await claimNext(db);
      if (row) {
        await processMigration(db, row, cfg).catch(async (err) => {
          const msg = (err as Error)?.message ?? String(err);
          console.error(`[worker] migration ${row.id} FAILED: ${msg}`);
          console.error((err as Error)?.stack ?? '(no stack)');
          await db.from('migrations').update({ status: 'error' }).eq('id', row.id);
        });
      } else if (opts.once) {
        console.log('[worker] no queued migrations; exiting (once mode)');
        return;
      }
    } catch (err) {
      console.error('[worker] poll error:', err);
    }
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}
