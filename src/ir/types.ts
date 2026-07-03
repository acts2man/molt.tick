/**
 * Molt IR — the intermediate representation every stage speaks.
 *
 * crawl  → CaptureManifest (what was captured, per page)
 * normalize → PageIR (builder-agnostic structure + content + style refs)
 * plan   → MigrationPlan (shared chrome, widget classification, flags)
 *
 * Design rules learned from the Soul2Souls reference migration:
 *  - DOM order is sacred (galleries, embeds). Every list in the IR is ordered.
 *  - Static CSS and runtime (JS-applied) styles are DIFFERENT sources; the IR
 *    keeps both and never conflates them (the rotateY(30°) lesson).
 *  - Widgets the engine can't convert are flagged BY NAME, never dropped.
 */

// ---------- capture (crawler output) ----------

export interface CaptureManifest {
  site: string;
  corePages?: string[];   // routes that came from the real nav menu (core, not blog posts)                 // origin, e.g. https://soul2soulsjazz.com
  crawledAt: string;            // ISO timestamp
  discovery: 'sitemap' | 'nav-bfs' | 'mixed';
  pages: PageCapture[];
}

export interface PageCapture {
  url: string;                  // absolute URL as crawled
  route: string;                // normalized path, e.g. "/", "/about"
  title: string;
  files: {
    dom: string;                // rendered post-JS HTML, relative path
    stylesheets: string[];      // captured CSS files, in document order
    computed: string;           // computed-style sidecar JSON
    assets: string;             // ordered asset manifest JSON
    iframes: string;            // iframe manifest JSON
    screenshot: string;         // full-page PNG for later pixel-diff
  };
  stats: {
    elements: number;
    styledElements: number;     // elements recorded in the sidecar
    assets: number;
    iframes: number;
    stylesheetBytes: number;
  };
}

/** One entry per meaningful element in the computed-style sidecar. */
export interface ComputedEntry {
  /** stable selector path, e.g. "div.elementor-element-5b343a3 > h2" */
  path: string;
  /** elementor element id if present (data-id / .elementor-element-XXXX) */
  elementorId?: string;
  tag: string;
  /** curated computed props (layout/typography/visual), post-JS */
  style: Record<string, string>;
}

export interface AssetRef {
  /** DOM order index — order is sacred */
  index: number;
  kind: 'img' | 'background' | 'lightbox-href' | 'source';
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  /** selector path of the owning element */
  path: string;
}

export interface IframeRef {
  index: number;
  src: string;
  title?: string;
  width?: string;
  height?: string;
  /** provider guess: mixcloud | youtube | vimeo | maps | unknown */
  provider: string;
  path: string;
}

// ---------- normalize (builder → IR) ----------

export type Builder = 'elementor' | 'gutenberg' | 'divi' | 'generic';

export interface PageIR {
  route: string;
  title: string;
  builder: Builder;
  sections: SectionIR[];
  /** widgets normalize could not classify — flagged, never dropped */
  unknownWidgets: string[];
}

export interface SectionIR {
  id: string;                   // elementor id or synthesized
  kind: 'section' | 'container';
  /** static CSS recovered from stylesheets for this element */
  staticStyle: Record<string, string>;
  /** runtime computed style from the sidecar (post-JS) */
  computedRef?: string;         // path key into the sidecar
  columns: ColumnIR[];
}

export interface ColumnIR {
  id: string;
  widthPct?: number;
  widgets: WidgetIR[];
}

export type WidgetIR =
  | { type: 'heading'; id: string; text: string; tag: string; computedRef?: string }
  | { type: 'text'; id: string; html: string; computedRef?: string }
  | { type: 'image'; id: string; src: string; width?: number; height?: number; alt?: string; computedRef?: string }
  | { type: 'button'; id: string; text: string; href: string; computedRef?: string }
  | { type: 'gallery'; id: string; images: AssetRef[]; computedRef?: string }   // ordered!
  | { type: 'embed'; id: string; iframe: IframeRef; computedRef?: string }
  | { type: 'form'; id: string; fields: FormField[]; action?: string; computedRef?: string }
  | { type: 'plugin'; id: string; widgetType: string; note: string; computedRef?: string }; // flagged

export interface FormField {
  name: string;
  inputType: string;
  required: boolean;
  placeholder?: string;
  label?: string;
}

// ---------- plan ----------

export interface MigrationPlan {
  routes: { route: string; title: string }[];
  chrome: ChromeGroup[];        // shared structure across pages — build once
  sharedChrome: string[];       // flat section-id list (all-pages chrome)
  library: LibraryMatch[];      // known plugin widgets matched to proven React impls
  flags: Flag[];                // needs a human call
  stats: {
    pages: number;
    chromeSections: number;     // sections built once instead of per page
    perPageSectionsSaved: number; // chrome sections × (pages − 1)
    pluginTypesMatched: number;
    pluginTypesUnmatched: number;
  };
}

export interface ChromeGroup {
  id: string;                   // section id (or fingerprint for id-less builders)
  matchedBy: 'id' | 'fingerprint';
  label: 'header' | 'social-rail' | 'offcanvas' | 'footer' | 'chrome';
  pages: string[];              // routes it appears on
  global: boolean;              // on every page
  instancesPerPage: number;     // >1 = breakpoint variants of the same template
  styleVariants: boolean;       // same structure, different computed styles per route
  widgets: string[];            // widget-type summary for the report
}

export interface LibraryMatch {
  widgetType: string;           // e.g. "sr-offcanvas"
  component: string;            // e.g. "OffcanvasMenu3D"
  confidence: 'exact' | 'probable';
}

export interface Flag {
  id: string;
  page: string;
  kind: 'no-backend' | 'runtime-style' | 'payment' | 'unknown-widget' | 'font-license';
  summary: string;
  detail: string;
}
