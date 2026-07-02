/**
 * Molt Stage 2 — Normalizer (Elementor).
 *
 * Deterministic, no AI: walks the crawler's captured DOM and emits PageIR —
 * sections → columns → widgets with real content extracted, each element
 * linked to its computed-style sidecar entry, and every widget the engine
 * can't classify flagged BY NAME (never silently dropped — the sr-offcanvas
 * lesson from the reference migration).
 */

import { parse, type HTMLElement } from 'node-html-parser';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  PageIR, SectionIR, ColumnIR, WidgetIR, FormField, ComputedEntry, Builder,
} from '../ir/types.js';

// widget types the deterministic engine converts directly
const CONVERTIBLE = new Set([
  'heading', 'image', 'text-editor', 'button', 'image-gallery',
  'video', 'html', 'divider', 'spacer', 'icon', 'icon-list', 'shortcode',
]);

function widgetType(el: HTMLElement): string {
  const t = el.getAttribute('data-widget_type') ?? '';
  return t.split('.')[0]; // "heading.default" → "heading"
}

function elementorId(el: HTMLElement): string {
  return el.getAttribute('data-id') ?? 'anon';
}

function detectBuilder(root: HTMLElement): Builder {
  if (root.querySelector('[data-element_type]')) return 'elementor';
  if (root.querySelector('.wp-block-group, .wp-block-columns')) return 'gutenberg';
  if (root.querySelector('.et_pb_section')) return 'divi';
  return 'generic';
}

// ------------------------------------------------------------ widget extract

function extractWidget(
  el: HTMLElement,
  computedById: Map<string, string>,
  unknown: string[],
): WidgetIR | null {
  const type = widgetType(el);
  const id = elementorId(el);
  const computedRef = computedById.get(id);

  switch (type) {
    case 'heading': {
      const h = el.querySelector('.elementor-heading-title');
      if (!h) return null;
      return { type: 'heading', id, text: h.text.trim(), tag: h.tagName.toLowerCase(), computedRef };
    }
    case 'image': {
      const img = el.querySelector('img');
      if (!img) return null;
      return {
        type: 'image', id,
        src: img.getAttribute('src') ?? '',
        width: Number(img.getAttribute('width')) || undefined,
        height: Number(img.getAttribute('height')) || undefined,
        alt: img.getAttribute('alt') || undefined,
        computedRef,
      };
    }
    case 'text-editor': {
      const c = el.querySelector('.elementor-widget-container') ?? el;
      return { type: 'text', id, html: c.innerHTML.trim(), computedRef };
    }
    case 'button': {
      const a = el.querySelector('a');
      if (!a) return null;
      return { type: 'button', id, text: a.text.trim(), href: a.getAttribute('href') ?? '#', computedRef };
    }
    case 'image-gallery':
    case 'shortcode': {
      // classic WP [gallery] renders inside shortcode/image-gallery widgets;
      // order authority is the crawler's assets.json — here we mark presence.
      const links = el.querySelectorAll('a[data-elementor-open-lightbox], .gallery-item a');
      if (links.length > 1) {
        return { type: 'gallery', id, images: [], computedRef }; // images filled from assets.json by route
      }
      if (type === 'shortcode') {
        const c = el.querySelector('.elementor-widget-container') ?? el;
        return { type: 'text', id, html: c.innerHTML.trim(), computedRef };
      }
      return { type: 'gallery', id, images: [], computedRef };
    }
    default: {
      // forms (any builder's form plugin renders a real <form>)
      const form = el.querySelector('form');
      if (form) {
        const fields: FormField[] = form
          .querySelectorAll('input, textarea, select')
          .filter((f) => !['hidden', 'submit'].includes(f.getAttribute('type') ?? ''))
          .map((f) => ({
            name: f.getAttribute('name') ?? '',
            inputType: f.tagName.toLowerCase() === 'input' ? (f.getAttribute('type') ?? 'text') : f.tagName.toLowerCase(),
            required: f.hasAttribute('required') || /wpcf7-validates-as-required|elementor-field-required/.test(f.getAttribute('class') ?? ''),
            placeholder: f.getAttribute('placeholder') || undefined,
          }));
        return { type: 'form', id, fields, action: form.getAttribute('action') || undefined, computedRef };
      }
      // embeds
      const iframe = el.querySelector('iframe');
      if (iframe) {
        return {
          type: 'embed', id,
          iframe: { index: -1, src: iframe.getAttribute('src') ?? '', provider: 'unknown', path: '' },
          computedRef,
        };
      }
      // genuinely unknown plugin widget — flag by name, never drop
      if (type && !CONVERTIBLE.has(type)) {
        if (!unknown.includes(type)) unknown.push(type);
        return { type: 'plugin', id, widgetType: type, note: `plugin widget "${type}" needs a library match or a human call`, computedRef };
      }
      return null;
    }
  }
}

// ------------------------------------------------------------ tree walk

function extractColumn(
  col: HTMLElement,
  computedById: Map<string, string>,
  unknown: string[],
): ColumnIR {
  const widgets: WidgetIR[] = [];
  for (const w of col.querySelectorAll('[data-element_type="widget"]')) {
    // only widgets whose nearest column ancestor is THIS column (avoid double-count in nested sections)
    let a = w.parentNode as HTMLElement | null;
    let owner: HTMLElement | null = null;
    while (a) {
      if (a.getAttribute?.('data-element_type') === 'column') { owner = a; break; }
      a = a.parentNode as HTMLElement | null;
    }
    if (owner !== col) continue;
    const ir = extractWidget(w, computedById, unknown);
    if (ir) widgets.push(ir);
  }
  // width from inline size classes if present (elementor-col-NN)
  const m = /elementor-col-(\d+)/.exec(col.getAttribute('class') ?? '');
  return { id: elementorId(col), widthPct: m ? Number(m[1]) : undefined, widgets };
}

export async function normalizePage(domPath: string, computedPath?: string): Promise<PageIR> {
  const html = await readFile(domPath, 'utf-8');
  const root = parse(html);

  // sidecar index: elementorId → path key
  const computedById = new Map<string, string>();
  if (computedPath) {
    try {
      const entries = JSON.parse(await readFile(computedPath, 'utf-8')) as ComputedEntry[];
      for (const e of entries) if (e.elementorId && !computedById.has(e.elementorId)) {
        computedById.set(e.elementorId, e.path);
      }
    } catch { /* sidecar optional */ }
  }

  const builder = detectBuilder(root);
  const unknown: string[] = [];
  const sections: SectionIR[] = [];

  for (const sec of root.querySelectorAll('[data-element_type="section"], [data-element_type="container"]')) {
    const kind = sec.getAttribute('data-element_type') === 'container' ? 'container' : 'section';
    const id = elementorId(sec);
    const columns: ColumnIR[] = [];
    for (const col of sec.querySelectorAll('[data-element_type="column"]')) {
      // nearest section ancestor must be THIS section
      let a = col.parentNode as HTMLElement | null;
      let owner: HTMLElement | null = null;
      while (a) {
        const t = a.getAttribute?.('data-element_type');
        if (t === 'section' || t === 'container') { owner = a; break; }
        a = a.parentNode as HTMLElement | null;
      }
      if (owner !== sec) continue;
      columns.push(extractColumn(col, computedById, unknown));
    }
    sections.push({
      id, kind,
      staticStyle: {}, // static-CSS merge is a later pass (stylesheet parser)
      computedRef: computedById.get(id),
      columns,
    });
  }

  const title = root.querySelector('title')?.text.trim() ?? '';
  return { route: '', title, builder, sections, unknownWidgets: unknown };
}

export function irStats(ir: PageIR) {
  let widgets = 0;
  const byType: Record<string, number> = {};
  for (const s of ir.sections) for (const c of s.columns) for (const w of c.widgets) {
    widgets++;
    const k = w.type === 'plugin' ? `plugin:${w.widgetType}` : w.type;
    byType[k] = (byType[k] ?? 0) + 1;
  }
  return { sections: ir.sections.length, columns: ir.sections.reduce((n, s) => n + s.columns.length, 0), widgets, byType };
}
