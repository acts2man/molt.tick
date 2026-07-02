/**
 * Molt Stage 5 — Pixel comparator.
 *
 * Compares a rebuilt page's screenshot against the crawler's original capture
 * and returns a match percentage. This is the metric behind the platform's
 * pixel_match column.
 *
 * Honest scope note: this produces meaningful numbers only once the synthesized
 * site RENDERS faithfully (real library components + the style-cascade pass).
 * The comparator itself is validated independently (self-diff = 100, cross-page
 * diff ≪ 100) so the metric is trustworthy the moment real renders exist.
 */

import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface PixelResult {
  matchPct: number;      // 100 = identical
  diffPixels: number;
  totalPixels: number;
  width: number;
  height: number;
}

async function loadPNG(path: string): Promise<PNG> {
  return PNG.sync.read(await readFile(path));
}

/** Resize by cropping/padding to a common canvas (top-left anchored). */
function fit(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  out.data.fill(0);
  for (let y = 0; y < Math.min(h, src.height); y++) {
    for (let x = 0; x < Math.min(w, src.width); x++) {
      const si = (src.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

export async function comparePixels(
  originalPath: string,
  candidatePath: string,
  opts: { threshold?: number } = {},
): Promise<PixelResult> {
  const a = await loadPNG(originalPath);
  const b = await loadPNG(candidatePath);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const A = fit(a, w, h);
  const B = fit(b, w, h);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(A.data, B.data, diff.data, w, h, { threshold: opts.threshold ?? 0.1 });
  const totalPixels = w * h;
  const matchPct = Math.round((1 - diffPixels / totalPixels) * 1000) / 10;
  return { matchPct, diffPixels, totalPixels, width: w, height: h };
}
