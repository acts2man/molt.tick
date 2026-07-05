/**
 * Molt — AI-powered page rebuild (proof of concept).
 *
 * Instead of mechanically copying HTML/CSS, this sends a DISTILLED brief of the
 * page (structured IR: sections, text, images, layout — ~24KB, not the raw
 * 329KB HTML) to Claude, which authors a clean, faithful React + Tailwind
 * component the way a skilled developer would. Intelligent rebuild, not copy.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export interface RebuildInput {
  route: string;
  title: string;
  brief: string;
  apiKey?: string;
  model?: string;
}

export interface RebuildResult {
  ok: boolean;
  code?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

import { parse, HTMLElement } from 'node-html-parser';

/**
 * Distill the captured page HTML into a compact, readable brief for Claude —
 * the meaningful content (headings, text, images, links, section structure),
 * NOT the raw 300KB markup. Small enough to reason over, complete enough to
 * rebuild faithfully. Built from page.html (what the crawler actually produces).
 */
export function buildBriefFromHtml(html: string, title: string, route: string, origin: string): string {
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  // strip noise
  for (const el of root.querySelectorAll('script, style, noscript, link, meta, svg')) el.remove();

  const lines: string[] = [];
  lines.push(`PAGE: ${title} (route ${route})`);
  lines.push('');
  lines.push('CONTENT (in document order — reproduce faithfully):');

  const abs = (u: string) => { try { return new URL(u, origin).toString(); } catch { return u; } };
  const seenText = new Set<string>();
  let count = 0;
  const MAX = 400; // cap items so the brief stays reasonable

  const walk = (node: HTMLElement, depth = 0): void => {
    if (count >= MAX) return;
    const tag = node.rawTagName?.toLowerCase();
    if (!tag) return;
    // headings
    if (/^h[1-6]$/.test(tag)) {
      const t = node.text.replace(/\s+/g, ' ').trim();
      if (t && !seenText.has(t)) { lines.push(`${'  '.repeat(Math.min(depth, 4))}[${tag}] ${t.slice(0, 200)}`); seenText.add(t); count++; }
      return;
    }
    // paragraphs / meaningful text blocks
    if (tag === 'p' || tag === 'li' || tag === 'blockquote') {
      const t = node.text.replace(/\s+/g, ' ').trim();
      if (t.length > 2 && !seenText.has(t)) { lines.push(`${'  '.repeat(Math.min(depth, 4))}[text] ${t.slice(0, 300)}`); seenText.add(t); count++; }
      return;
    }
    // images
    if (tag === 'img') {
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      const altAttr = node.getAttribute('alt') || '';
      if (src && !src.startsWith('data:')) { lines.push(`${'  '.repeat(Math.min(depth, 4))}[image] ${abs(src)}${altAttr ? ` (alt: ${altAttr})` : ''}`); count++; }
      return;
    }
    // links / buttons
    if (tag === 'a') {
      const t = node.text.replace(/\s+/g, ' ').trim();
      const href = node.getAttribute('href') || '';
      if (t && href && !seenText.has(t + href)) { lines.push(`${'  '.repeat(Math.min(depth, 4))}[link] "${t.slice(0, 80)}" → ${href}`); seenText.add(t + href); count++; }
      // still descend (links can wrap images)
    }
    // background images on inline style
    const style = node.getAttribute('style') || '';
    const bgMatch = style.match(/background-image:\s*url\(["']?([^"')]+)/i);
    if (bgMatch) { lines.push(`${'  '.repeat(Math.min(depth, 4))}[bg-image] ${abs(bgMatch[1])}`); count++; }
    // section markers for structure
    if (tag === 'section' || tag === 'header' || tag === 'footer' || tag === 'nav') {
      lines.push(`\n${'  '.repeat(Math.min(depth, 4))}<${tag}>`);
    }
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement) walk(child, depth + 1);
    }
  };
  const body = root.querySelector('body') ?? root;
  walk(body);

  return lines.join('\n');
}

/** Legacy IR-based brief (kept for the reference test data). */
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
    if (bits.length) lines.push(`${indent}- ${kind}: ${bits.join(' | ')}`);
    else lines.push(`${indent}- ${kind}`);
    const children = node.columns || node.widgets || node.children || node.items || [];
    for (const c of children) describe(c, indent + '  ');
  };
  for (const section of ir.sections ?? []) {
    lines.push(`\nSection ${n++} (${section.kind || 'section'}):`);
    for (const col of section.columns ?? [section]) describe(col);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are an expert React developer recreating a website page faithfully.
You will receive a structured brief describing a page's sections, text, images, and layout.
Produce a single clean React functional component (default export) using Tailwind CSS that
faithfully recreates the page's appearance and structure.

Rules:
- Reproduce ALL text content exactly as given.
- Use the exact image URLs provided (absolute URLs).
- Recreate the visual hierarchy and layout (hero, sections, columns, galleries, footers).
- Use semantic, responsive Tailwind. Full-width heroes should be full-width.
- Do NOT invent content not in the brief. Do NOT add placeholder lorem ipsum.
- Output ONLY the component code, no explanation, no markdown fences.
- Component name: Page. Default export it.`;

export async function rebuildPageWithAI(input: RebuildInput): Promise<RebuildResult> {
  const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model ?? process.env.MOLT_AI_MODEL ?? 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Recreate this page as a React + Tailwind component.\n\n${input.brief}` }],
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
