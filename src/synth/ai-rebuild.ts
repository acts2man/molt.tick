/**
 * Molt — AI-powered visual reconstruction.
 *
 * The model receives TWO kinds of evidence:
 *   1. semantic/content evidence distilled from the captured DOM
 *   2. the original page screenshot as visual ground truth
 *
 * The screenshot is the authority for composition, spacing, typography, crop,
 * hierarchy and visual rhythm. The DOM brief is the authority for exact copy,
 * links and asset URLs. This is intentionally a reconstruction task, not a
 * redesign task.
 */

import { readFile } from 'node:fs/promises';
import { parse, HTMLElement } from 'node-html-parser';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export interface RebuildInput {
  route: string;
  title: string;
  brief: string;
  /** Original source screenshot captured by Molt. PNG is preferred. */
  referenceImagePath?: string;
  /** Measured/computed evidence that supplements what vision can see. */
  visualEvidence?: string;
  apiKey?: string;
  model?: string;
}

export interface RebuildResult {
  ok: boolean;
  code?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Distill the captured page HTML into a compact, readable brief for the model —
 * meaningful content, images, links and document order, not hundreds of KB of
 * WordPress/page-builder markup.
 */
export function buildBriefFromHtml(html: string, title: string, route: string, origin: string): string {
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  for (const el of root.querySelectorAll('script, style, noscript, link, meta, svg')) el.remove();

  const lines: string[] = [];
  lines.push(`PAGE: ${title} (route ${route})`);
  lines.push('');
  lines.push('CONTENT (in document order — reproduce exactly):');

  const abs = (u: string) => { try { return new URL(u, origin).toString(); } catch { return u; } };
  const seenText = new Set<string>();
  let count = 0;
  const MAX = 500;

  const walk = (node: HTMLElement, depth = 0): void => {
    if (count >= MAX) return;
    const tag = node.rawTagName?.toLowerCase();
    if (!tag) return;

    if (/^h[1-6]$/.test(tag)) {
      const t = node.text.replace(/\s+/g, ' ').trim();
      if (t && !seenText.has(t)) {
        lines.push(`${'  '.repeat(Math.min(depth, 4))}[${tag}] ${t.slice(0, 300)}`);
        seenText.add(t); count++;
      }
      return;
    }

    if (tag === 'p' || tag === 'li' || tag === 'blockquote') {
      const t = node.text.replace(/\s+/g, ' ').trim();
      if (t.length > 2 && !seenText.has(t)) {
        lines.push(`${'  '.repeat(Math.min(depth, 4))}[text] ${t.slice(0, 500)}`);
        seenText.add(t); count++;
      }
      return;
    }

    if (tag === 'img') {
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      const altAttr = node.getAttribute('alt') || '';
      if (src && !src.startsWith('data:')) {
        lines.push(`${'  '.repeat(Math.min(depth, 4))}[image] ${abs(src)}${altAttr ? ` (alt: ${altAttr})` : ''}`);
        count++;
      }
      return;
    }

    if (tag === 'a') {
      const t = node.text.replace(/\s+/g, ' ').trim();
      const href = node.getAttribute('href') || '';
      if (t && href && !seenText.has(t + href)) {
        lines.push(`${'  '.repeat(Math.min(depth, 4))}[link] "${t.slice(0, 120)}" → ${href}`);
        seenText.add(t + href); count++;
      }
    }

    const style = node.getAttribute('style') || '';
    const bgMatch = style.match(/background-image:\s*url\(["']?([^"')]+)/i);
    if (bgMatch) {
      lines.push(`${'  '.repeat(Math.min(depth, 4))}[bg-image] ${abs(bgMatch[1])}`);
      count++;
    }

    if (tag === 'section' || tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'main') {
      lines.push(`\n${'  '.repeat(Math.min(depth, 4))}<${tag}>`);
    }
    for (const child of node.childNodes) if (child instanceof HTMLElement) walk(child, depth + 1);
  };

  walk(root.querySelector('body') ?? root);
  return lines.join('\n');
}

/** Legacy IR-based brief retained for reference fixtures. */
export function buildBrief(ir: any): string {
  const lines: string[] = [];
  lines.push(`PAGE: ${ir.title ?? ''} (route ${ir.route ?? '/'})`);
  lines.push(`Builder: ${ir.builder ?? 'unknown'}. ${(ir.sections ?? []).length} sections.`);
  lines.push('');
  lines.push('STRUCTURE (top to bottom):');
  let n = 1;
  const describe = (node: any, indent = '  '): void => {
    if (!node || typeof node !== 'object') return;
    const kind = node.kind || node.type || node.widgetType || 'block';
    const bits: string[] = [];
    if (node.text) bits.push(`text: "${String(node.text).replace(/\s+/g, ' ').trim().slice(0, 200)}"`);
    if (node.tag) bits.push(`tag: ${node.tag}`);
    if (node.src || node.image) bits.push(`image: ${node.src || node.image}`);
    if (node.href) bits.push(`link: ${node.href}`);
    if (node.bg || node.background) bits.push(`bg: ${node.bg || node.background}`);
    lines.push(`${indent}- ${kind}${bits.length ? `: ${bits.join(' | ')}` : ''}`);
    const children = node.columns || node.widgets || node.children || node.items || [];
    for (const c of children) describe(c, indent + '  ');
  };
  for (const section of ir.sections ?? []) {
    lines.push(`\nSection ${n++} (${section.kind || 'section'}):`);
    for (const col of section.columns ?? [section]) describe(col);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are the reconstruction engineer inside Molt, a system that converts existing websites into clean React implementations.

This is NOT a redesign task. Your job is to reproduce the supplied website page as faithfully as possible while removing WordPress/page-builder runtime dependencies.

Evidence hierarchy:
1. The supplied source screenshot is VISUAL GROUND TRUTH for composition, section heights, spacing, alignment, typography scale, image crop/position, colors and visual hierarchy.
2. The measured/computed visual evidence is authoritative for values that are difficult to infer from pixels.
3. The DOM/content brief is authoritative for exact text, links, images and document order.

Rules:
- Reproduce all visible source content exactly. Do not summarize or rewrite copy.
- Use the exact supplied image URLs/assets. Do not invent substitute imagery.
- Match the source screenshot; do not improve, modernize or reinterpret the design.
- Preserve full-width vs contained sections, overlap, layering, crop and whitespace.
- Use semantic React and responsive CSS/Tailwind rather than Elementor wrappers.
- Prefer CSS Grid/Flexbox and reusable local patterns over absolute positioning, except where the source genuinely overlaps/layers content.
- Do not add WordPress, Elementor, Divi or page-builder runtime classes/scripts.
- Do not fake backend behavior. Visual form shells are fine when backend behavior is not provided.
- Output ONLY one valid React functional component named Page, default exported. No markdown fences or commentary.`;

async function imageBlock(path: string): Promise<any> {
  const bytes = await readFile(path);
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: bytes.toString('base64'),
    },
  };
}

export async function rebuildPageWithAI(input: RebuildInput): Promise<RebuildResult> {
  const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };

  try {
    const content: any[] = [];
    if (input.referenceImagePath) {
      try { content.push(await imageBlock(input.referenceImagePath)); }
      catch (e) { console.warn(`[molt] could not attach source screenshot: ${(e as Error).message}`); }
    }

    content.push({
      type: 'text',
      text:
`Reconstruct this page as React + Tailwind.

${input.visualEvidence ? `MEASURED / COMPUTED VISUAL EVIDENCE:\n${input.visualEvidence}\n\n` : ''}${input.brief}`,
    });

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model ?? process.env.MOLT_AI_MODEL ?? 'claude-sonnet-4-5',
        max_tokens: Number(process.env.MOLT_AI_MAX_TOKENS ?? 12000),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await res.json();
    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${data.error?.message ?? JSON.stringify(data)}` };
    let code = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    code = code.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    return { ok: true, code, usage: data.usage };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
