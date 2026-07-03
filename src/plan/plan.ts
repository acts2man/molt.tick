/**
 * Molt Stage 3 — Plan.
 *
 * Input: every page's IR (+ optional raw DOM and computed sidecar for signals).
 * Output: MigrationPlan — what to build once (chrome), what maps to the proven
 * component library, and what needs a human call (flags).
 *
 * Detection is data-driven, learned from the reference migration:
 *  - Elementor theme templates reuse the SAME section ids on every page →
 *    id-equality finds chrome directly. Sites without templates fall back to a
 *    structural fingerprint (widget-type sequence + heading texts).
 *  - The same chrome id can appear MULTIPLE times per page (breakpoint
 *    variants of one template — the three-toggle-group header lesson).
 *  - Same chrome can render with different styles per route (home dark header
 *    vs interior light header share ids) → styleVariants, resolved per page
 *    from the computed sidecar, never hardcoded.
 */

import { createHash } from 'node:crypto';
import type {
  PageIR, SectionIR, MigrationPlan, ChromeGroup, LibraryMatch, Flag, ComputedEntry,
} from '../ir/types.js';
import { matchLibrary, LIBRARY } from './library.js';

export interface PlanInput {
  route: string;
  ir: PageIR;
  /** raw page HTML — enables signal sniffing (woocommerce, cf7, mailchimp) */
  dom?: string;
  /** computed sidecar — enables runtime-style flags */
  computed?: ComputedEntry[];
}

// ------------------------------------------------------------ fingerprint

function fingerprint(s: SectionIR): string {
  const sig = s.columns.map((c) =>
    c.widgets.map((w) => {
      if (w.type === 'heading') return `h:${w.text.slice(0, 40)}`;
      if (w.type === 'plugin') return `p:${w.widgetType}`;
      if (w.type === 'image') return `i:${(w.src ?? '').split('/').pop()}`;
      return w.type;
    }).join('|'),
  ).join('||');
  return createHash('sha1').update(s.kind + '::' + sig).digest('hex').slice(0, 12);
}

function widgetSummary(s: SectionIR): string[] {
  const out: string[] = [];
  for (const c of s.columns) for (const w of c.widgets) {
    out.push(w.type === 'plugin' ? `plugin:${w.widgetType}` : w.type);
  }
  return out;
}

function labelChrome(widgets: string[], texts: string[], relPos: number): ChromeGroup['label'] {
  const t = texts.join(' ').toLowerCase();
  if (widgets.includes('plugin:sr-offcanvas') || /subscribe\s*&\s*follow/.test(t)) return 'offcanvas';
  if (widgets.includes('plugin:social-icons') || /follow us/.test(t)) return 'social-rail';
  if (widgets.includes('form') || /©|copyright|mailing list/.test(t) || relPos > 0.75) return 'footer';
  if (widgets.includes('plugin:sr-e-menu') || relPos < 0.4) return 'header';
  return 'chrome';
}

function headingTexts(s: SectionIR): string[] {
  const out: string[] = [];
  for (const c of s.columns) for (const w of c.widgets) {
    if (w.type === 'heading') out.push(w.text);
  }
  return out;
}

// ------------------------------------------------------------ plan

export function buildPlan(pages: PlanInput[]): MigrationPlan {
  const nPages = pages.length;

  // ---- chrome detection ----
  // key → { pages: Set<route>, instances per page, sample section, positions }
  interface Bucket {
    key: string; matchedBy: 'id' | 'fingerprint';
    routes: Map<string, number>;          // route → instance count
    sample: SectionIR; relPosSum: number; occurrences: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const p of pages) {
    const secs = p.ir.sections;
    secs.forEach((s, i) => {
      const byId = s.id && s.id !== 'anon';
      const key = byId ? `id:${s.id}` : `fp:${fingerprint(s)}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          key, matchedBy: byId ? 'id' : 'fingerprint',
          routes: new Map(), sample: s, relPosSum: 0, occurrences: 0,
        };
        buckets.set(key, b);
      }
      b.routes.set(p.route, (b.routes.get(p.route) ?? 0) + 1);
      b.relPosSum += secs.length > 1 ? i / (secs.length - 1) : 0;
      b.occurrences++;
    });
  }

  const chrome: ChromeGroup[] = [];
  for (const b of buckets.values()) {
    if (b.routes.size < 2) continue;                    // one page → content, not chrome
    const widgets = widgetSummary(b.sample);
    const texts = headingTexts(b.sample);
    const relPos = b.relPosSum / b.occurrences;
    const maxInstances = Math.max(...b.routes.values());
    chrome.push({
      id: b.key.replace(/^(id|fp):/, ''),
      matchedBy: b.matchedBy,
      label: labelChrome(widgets, texts, relPos),
      pages: [...b.routes.keys()],
      global: b.routes.size === nPages,
      instancesPerPage: maxInstances,
      styleVariants: b.routes.size === nPages && nPages > 1, // resolved per-route from sidecar
      widgets,
    });
  }
  // stable order: headers first, then rails/offcanvas, footer last
  const rank = { header: 0, 'social-rail': 1, offcanvas: 2, chrome: 3, footer: 4 } as const;
  chrome.sort((a, b) => rank[a.label] - rank[b.label] || a.id.localeCompare(b.id));

  // ---- library matching ----
  const pluginPages = new Map<string, Set<string>>();
  for (const p of pages) {
    for (const s of p.ir.sections) for (const c of s.columns) for (const w of c.widgets) {
      if (w.type === 'plugin') {
        if (!pluginPages.has(w.widgetType)) pluginPages.set(w.widgetType, new Set());
        pluginPages.get(w.widgetType)!.add(p.route);
      }
    }
  }
  const library: LibraryMatch[] = [];
  const flags: Flag[] = [];
  let fi = 1;
  const flag = (page: string, kind: Flag['kind'], summary: string, detail: string) =>
    flags.push({ id: `F${fi++}`, page, kind, summary, detail });

  for (const [wtype, routes] of pluginPages) {
    const hit = matchLibrary(wtype);
    if (hit) {
      library.push({ widgetType: wtype, component: hit.component, confidence: hit.confidence });
    }
    // NOTE: no 'unknown-widget' flag. Molt does FAITHFUL VISUAL reproduction —
    // every widget is reproduced from its original HTML+CSS regardless of type,
    // so "no library match" is meaningless noise. We don't rebuild widgets.
  }

  // ---- signal-based matches + flags (dom sniffing) ----
  // WP loads plugin CSS/classes globally, so weak signals fire on every page.
  // Use strong content markers and attribute each flag to the page where the
  // signal is densest — the page that actually carries the feature.
  const strongest = (re: RegExp): { route: string; hits: number } => {
    let best = { route: '', hits: 0 };
    for (const p of pages) {
      const hits = (p.dom?.match(re) ?? []).length;
      if (hits > best.hits) best = { route: p.route, hits };
    }
    return best;
  };
  const sniffed = new Set<string>();
  {
    const woo = strongest(/add-to-cart|woocommerce-loop|class="?products\b|type-product/g);
    if (woo.hits > 0) {
      library.push({ widgetType: 'woocommerce-shop', component: LIBRARY['woocommerce-shop'].component, confidence: 'exact' });
      flag(woo.route, 'payment',
        'WooCommerce shop detected — rebuilds without a payment processor',
        LIBRARY['woocommerce-shop'].provenance);
    }
  }
  for (const p of pages) {
    const dom = p.dom ?? '';
    if (/wpcf7-form|wpcf7-field|data-wpcf7/.test(dom) && !sniffed.has('cf7')) {
      sniffed.add('cf7');
      library.push({ widgetType: 'wpcf7-form', component: LIBRARY['wpcf7-form'].component, confidence: 'exact' });
      flag(p.route, 'no-backend',
        'Contact Form 7 sends server-side — rebuilt form needs a backend decision',
        'Ships with validation + mailto: handoff and a TODO(backend) seam (Resend / Supabase edge function). Never fakes a send.');
    }
    if (/mailchimp/i.test(dom) && !sniffed.has('mailchimp')) {
      sniffed.add('mailchimp');
      library.push({ widgetType: 'mailchimp-form', component: LIBRARY['mailchimp-form'].component, confidence: 'exact' });
      flag(p.route + ' (site-wide footer)', 'no-backend',
        'Mailchimp list form — signup needs a backend decision',
        'Rebuilt with validation + TODO(backend) seam for the list-subscribe call.');
    }
    // gallery behavior: any page with a gallery widget in IR
    const hasGallery = p.ir.sections.some((s) => s.columns.some((c) => c.widgets.some((w) => w.type === 'gallery')));
    if (hasGallery && !sniffed.has('gallery')) {
      sniffed.add('gallery');
      library.push({ widgetType: 'gallery-lightbox', component: LIBRARY['gallery-lightbox'].component, confidence: 'exact' });
    }
    // runtime styles: live 3D/perspective matrices in the sidecar
    if (p.computed) {
      const live = p.computed.filter((e) => {
        const t = e.style['transform'] ?? 'none';
        const persp = e.style['perspective'] ?? 'none';
        return t.startsWith('matrix3d(') || persp !== 'none';
      });
    // (runtime-style flag removed: faithful mode uses the original CSS, so
    // JS-applied transforms are preserved as-is — nothing to flag.)
    }
  }

  const chromeSections = chrome.filter((c) => c.global).length;
  return {
    routes: pages.map((p) => ({ route: p.route, title: p.ir.title })),
    chrome,
    sharedChrome: chrome.filter((c) => c.global).map((c) => c.id),
    library,
    flags,
    stats: {
      pages: nPages,
      chromeSections,
      perPageSectionsSaved: chromeSections * (nPages - 1),
      pluginTypesMatched: library.length,
      pluginTypesUnmatched: flags.filter((f) => f.kind === 'unknown-widget').length,
    },
  };
}
