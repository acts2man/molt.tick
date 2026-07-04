/**
 * Molt Stage 1 — Crawler.
 *
 * Replaces the manual per-page browser-extension capture with one command:
 * discover every page of a site, and for each page capture everything the
 * downstream stages need:
 *
 *   1. rendered DOM        (post-JS — what the site actually shows)
 *   2. every stylesheet    (static CSS survives, unlike SingleFile)
 *   3. computed sidecar    (getComputedStyle per element — catches styles
 *                           applied by JS at runtime; the rotateY(30°) lesson)
 *   4. assets in DOM order (order is sacred — the 89-photo gallery lesson)
 *   5. iframe manifest     (embeds like Mixcloud are iframes; the player lesson)
 *   6. full-page screenshot (ground truth for Stage 5 pixel-diff)
 */

import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureManifest, PageCapture } from '../ir/types.js';

// Chrome resolution: explicit MOLT_CHROME wins; otherwise let playwright-core
// find its own installed browser (the deploy image installs it in the default
// location). Only fall back to the dev-container path if that path exists.
import { existsSync } from 'node:fs';
const DEV_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME =
  process.env.MOLT_CHROME ?? (existsSync(DEV_CHROME) ? DEV_CHROME : undefined);

export interface CrawlOptions {
  startUrl: string;
  outDir: string;
  maxPages?: number;
  settleMs?: number; // extra wait after load for JS-applied styles to land
  scope?: CrawlScope; // core | all | posts — which pages to auto-capture
  urls?: string[];    // EXPLICIT page list — when set, skip discovery, crawl exactly these
}

/** Accept a bare domain or full URL; always return a valid absolute URL. */
export function normalizeStartUrl(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) throw new Error('empty site URL');
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
  return new URL(withScheme).toString(); // validates + canonicalizes
}

// ---------------------------------------------------------------- discovery

// Auto-generated WordPress archive/taxonomy URLs that aren't real content pages.
// These are the pages that flooded the treetestprep crawl (author/tag/category
// archives, trashed drafts, individual lesson/CPT items rendered by plugins).
const JUNK_PATTERNS: RegExp[] = [
  /\/author\//i,
  /\/category\//i,
  /\/tag\//i,
  /\/course-tag\//i,
  /\/course-category\//i,
  /\/product-tag\//i,
  /\/product-category\//i,
  /\/lesson\//i,          // individual LearnDash lessons
  /\/topic\//i,
  /\/quizzes?\//i,
  /__trashed/i,
  /\/\d{4}\/\d{2}\//,     // date archives /2024/06/
  /\/page\/\d+\/?$/i,     // pagination /page/2/
  /\/feed\/?$/i,
];

function isJunk(pathname: string): boolean {
  return JUNK_PATTERNS.some((re) => re.test(pathname));
}

// "Real" listing pages worth keeping even though they're indexes.
const KEEP_LISTINGS = /^\/(blog|shop|store|courses|events|services|portfolio|gallery|news|products?)\/?$/i;

// A page is "post-like" (a blog article) when its slug reads like prose: many
// hyphenated words. Real pages are short (/about, /contact, /shop); blog posts
// are long sentence-slugs (/how-to-upgrade-your-old-house-roof-in-time).
function isPostLike(pathname: string): boolean {
  const seg = pathname.replace(/^\/|\/$/g, '');
  if (!seg || seg.includes('/')) return false;      // home or nested → not a top-level post
  const words = seg.split('-').length;
  return words >= 4;                                  // 4+ hyphenated words = prose slug = post
}

export type CrawlScope = 'core' | 'all' | 'posts';

// theme demo / layout-variant pages that aren't real content (blog-standard,
// portfolio-grid, portfolio-metro, typography, elements, etc.)
const DEMO_PATTERNS = /^\/(blog|portfolio|shop|team|service|about|contact|home)?-?(standard|list|grid|metro|masonry|classic|modern|v\d|variant|layout|full-?width|sidebar|left|right|two|three|four|column|typography|elements?|shortcodes?|icons?|buttons?|popups?|newsletter|subscribe)\b/i;

function isDemoPage(pathname: string): boolean {
  return DEMO_PATTERNS.test(pathname);
}

/** Does a route pass the chosen scope filter? (nav-menu pages always count as core.) */
function inScope(route: string, scope: CrawlScope, coreRoutes: Set<string>, haveNav: boolean): boolean {
  const post = isPostLike(route);
  const demo = isDemoPage(route);
  // when the real nav menu is known, "core" = exactly those pages.
  // when nav is unknown (haveNav=false), fall back to a STRICT heuristic:
  //   home + short real slugs, excluding posts and theme-demo pages.
  const isCore = coreRoutes.has(route)
    || route === '/'
    || (!post && !demo && (KEEP_LISTINGS.test(route) || route.replace(/^\/|\/$/g, '').split('-').length <= 2));

  if (scope === 'all') return true;
  if (scope === 'posts') return post;
  // scope === 'core'
  if (haveNav) return coreRoutes.has(route) || route === '/';  // nav known → trust it exactly
  return isCore && !demo;                                       // no nav → strict heuristic
}

/**
 * Score a URL by how likely it is to be a page a human considers part of the
 * site. Lower = more important. Nav-menu pages get the strongest boost (applied
 * by the caller); this ranks by URL shape.
 */
function pageScore(pathname: string): number {
  if (pathname === '/') return 0;                    // home first
  const depth = pathname.split('/').filter(Boolean).length;
  let score = depth * 10;                             // shallower = better
  if (KEEP_LISTINGS.test(pathname)) score -= 5;       // real listing pages
  return score;
}

function normalizeUrl(raw: string, origin: string, allowJunk = false): string | null {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return null;               // same-origin only
    u.hash = '';
    u.search = '';
    let p = u.pathname;
    // skip obvious non-pages
    if (/\.(jpe?g|png|webp|gif|svg|css|js|pdf|zip|mp3|mp4|ico|woff2?)$/i.test(p)) return null;
    if (/\/(wp-admin|wp-login|wp-json|feed|xmlrpc)\b/.test(p)) return null;
    if (!p.endsWith('/')) p += '/';
    if (!allowJunk && isJunk(p) && !KEEP_LISTINGS.test(p)) return null; // drop taxonomy/archive junk
    return u.origin + p;
  } catch {
    return null;
  }
}

/** Extract the real navigation menu links from the homepage header/nav. */
async function discoverViaMenu(page: Page, origin: string, startUrl: string): Promise<string[]> {
  try {
    const resp = await page.goto(startUrl, { waitUntil: 'load', timeout: 25000 });
    if (resp && resp.status() >= 400) return [];
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(800); // let menu JS populate

    // Grab links from real menu containers. Covers standard nav, WordPress menu
    // classes, and off-canvas/hamburger menus (elementskit, etc.) that are in the
    // DOM even when visually collapsed. Score each container by how "menu-like"
    // it is and take links from the best one, so we don't grab every page link.
    const hrefs: string[] = await page.evaluate(
      `(() => {
        const SELECTORS = [
          'nav[class*="menu"] a[href]', 'nav a[href]',
          '[class*="main-menu"] a[href]', '[class*="primary-menu"] a[href]',
          '[class*="nav-menu"] a[href]', 'ul[class*="menu"] a[href]',
          '[class*="offcanvas"] a[href]', '[class*="off-canvas"] a[href]',
          '[id*="menu"] a[href]', 'header nav a[href]', 'header a[href]',
        ];
        for (const sel of SELECTORS) {
          const links = Array.from(document.querySelectorAll(sel))
            .map(a => a.href)
            .filter(h => h && !h.startsWith('javascript:') && !h.startsWith('#'));
          // a real menu has a handful of links, not the whole site and not just one
          const uniq = Array.from(new Set(links));
          if (uniq.length >= 2 && uniq.length <= 25) return uniq;
        }
        return []; // no clear menu found — caller falls back to sitemap
      })()`,
    ) as string[];

    const out: string[] = [];
    for (const h of hrefs) {
      const n = normalizeUrl(h, origin);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

async function discoverViaSitemap(page: Page, origin: string): Promise<string[]> {
  try {
    const res = await page.request.get(origin + '/sitemap.xml', { timeout: 8000 });
    if (!res.ok()) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
    // sitemap index → fetch one level of child sitemaps
    const pages: string[] = [];
    for (const loc of locs) {
      if (/\.xml(\?|$)/.test(loc)) {
        try {
          const child = await page.request.get(loc, { timeout: 8000 });
          if (child.ok()) {
            const cxml = await child.text();
            for (const m of cxml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) pages.push(m[1]);
          }
        } catch { /* skip child */ }
      } else {
        pages.push(loc);
      }
    }
    return pages
      .map((u) => normalizeUrl(u, origin))
      .filter((u): u is string => !!u);
  } catch {
    return [];
  }
}

/** BFS over real (non-junk) same-origin links, seeded from the nav menu. */
async function discoverViaNav(
  page: Page,
  origin: string,
  startUrl: string,
  maxPages: number,
  seeds: string[] = [],
): Promise<string[]> {
  const home = normalizeUrl(startUrl, origin)!;
  const seen = new Set<string>([home, ...seeds]);
  const queue = [home, ...seeds];
  const found: string[] = [...seen];
  while (queue.length && found.length < maxPages * 2) {
    const url = queue.shift()!;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (resp && resp.status() >= 400) { // error page — drop from results, don't follow
        const i = found.indexOf(url);
        if (i >= 0) found.splice(i, 1);
        continue;
      }
      // NOTE: string-form evaluate on purpose — tsx/esbuild injects a __name
      // helper into transformed arrow fns that doesn't exist in the browser.
      const hrefs: string[] = await page.evaluate(
        `Array.from(document.querySelectorAll('a[href]')).map(a => a.href)`,
      ) as string[];
      for (const h of hrefs) {
        const n = normalizeUrl(h, origin); // junk already filtered here
        if (n && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
          found.push(n);
        }
      }
    } catch { /* unreachable page — skip */ }
  }
  return found;
}

// ---------------------------------------------------------------- capture

/** Everything read out of the live page in one evaluate pass. */
const IN_PAGE_EXTRACT = `(() => {
  const PROPS = [
    'display','position','top','right','bottom','left','z-index',
    'flex-direction','flex-wrap','flex-grow','flex-basis','justify-content','align-items','gap',
    'grid-template-columns','grid-auto-flow',
    'width','height','max-width','min-height','box-sizing',
    'margin-top','margin-right','margin-bottom','margin-left',
    'padding-top','padding-right','padding-bottom','padding-left',
    'font-family','font-size','font-weight','font-style','line-height','letter-spacing',
    'text-align','text-transform','text-decoration-line','white-space',
    'color','background-color','background-image','background-size','background-position','background-repeat',
    'border-top-width','border-top-style','border-top-color','border-radius',
    'box-shadow','opacity','overflow','visibility','object-fit','cursor',
    'transform','transform-origin','perspective','transition-property','transition-duration'
  ];
  const DEFAULTS = { 'transform':'none','perspective':'none','box-shadow':'none','background-image':'none' };

  // stable unique path: nth-child chain from body
  function chain(el) {
    const idx = [];
    let n = el;
    while (n && n !== document.body && n.parentElement) {
      idx.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
      n = n.parentElement;
    }
    return idx.join('.');
  }
  function readable(el) {
    const cls = (el.classList && el.classList[0]) ? '.' + el.classList[0] : '';
    const id = el.id ? '#' + el.id : '';
    return el.tagName.toLowerCase() + id + cls;
  }
  function elementorId(el) {
    const d = el.getAttribute && el.getAttribute('data-id');
    if (d) return d;
    if (el.classList) for (const c of el.classList) {
      const m = /^elementor-element-([0-9a-f]{6,8})$/.exec(c);
      if (m) return m[1];
    }
    return undefined;
  }

  const all = Array.from(document.querySelectorAll('body *'));
  const computed = [];
  for (const el of all) {
    // record elements that carry meaning: elementor ids, classed elements, or semantic tags
    const eid = elementorId(el);
    const tag = el.tagName.toLowerCase();
    const semantic = /^(h[1-6]|p|a|img|button|section|header|footer|nav|ul|ol|li|form|input|textarea|select|iframe|figure|main|article|aside|span|div)$/.test(tag);
    if (!eid && !el.className && !semantic) continue;
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== DEFAULTS[p]) style[p] = v;
    }
    const entry = { path: chain(el), sel: readable(el), tag, style };
    if (eid) entry.elementorId = eid;
    computed.push(entry);
  }

  // assets, strictly in DOM order
  const assets = [];
  let ai = 0;
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const img = el;
      assets.push({ index: ai++, kind: 'img', url: img.currentSrc || img.src,
        width: img.naturalWidth || undefined, height: img.naturalHeight || undefined,
        alt: img.alt || undefined, path: chain(el) });
    } else if (tag === 'a' && (el.hasAttribute('data-elementor-open-lightbox') ||
               el.getAttributeNames().some(n => n.indexOf('data-elementor-lightbox') === 0))) {
      // full-size URL: prefer href; fall back to the base64 payload in data-e-action-hash
      let full = el.getAttribute('href') || '';
      if (!/\\.(jpe?g|png|webp|gif)(\\?|$)/i.test(full)) {
        try {
          const hash = decodeURIComponent(el.getAttribute('data-e-action-hash') || '');
          const b64 = (hash.split('settings=')[1] || '');
          const cfg = JSON.parse(atob(b64));
          if (cfg && cfg.url) full = cfg.url;
        } catch (e) { /* no decodable hash */ }
      }
      if (/\\.(jpe?g|png|webp|gif)(\\?|$)/i.test(full))
        assets.push({ index: ai++, kind: 'lightbox-href', url: full,
          alt: el.getAttribute('data-elementor-lightbox-title') || undefined, path: chain(el) });
    } else {
      const bg = getComputedStyle(el).getPropertyValue('background-image');
      const m = bg && /url\\(["']?([^"')]+)["']?\\)/.exec(bg);
      if (m && !/^data:/.test(m[1]))
        assets.push({ index: ai++, kind: 'background', url: m[1], path: chain(el) });
    }
  }

  // iframes, in DOM order, with provider detection
  const sniff = (s) =>
      /mixcloud/i.test(s) ? 'mixcloud' :
      /youtube|youtu\\.be/i.test(s) ? 'youtube' :
      /vimeo/i.test(s) ? 'vimeo' :
      /google\\.[a-z.]+\\/maps|maps\\.google/i.test(s) ? 'maps' : 'unknown';
  const iframes = Array.from(document.querySelectorAll('iframe')).map((f, i) => {
    const src = f.src || '';
    let provider = sniff(src);
    if (provider === 'unknown') provider = sniff(f.title || '');
    if (provider === 'unknown') {
      // localized/same-origin embed — sniff the inner document
      try {
        const doc = f.contentDocument;
        if (doc) provider = sniff((doc.title || '') + ' ' +
          (doc.documentElement ? doc.documentElement.innerHTML.slice(0, 8000) : ''));
      } catch (e) { /* cross-origin — leave unknown */ }
    }
    return { index: i, src, title: f.title || undefined,
      width: f.getAttribute('width') || undefined, height: f.getAttribute('height') || undefined,
      provider, path: chain(f) };
  });

  const inlineStyles = Array.from(document.querySelectorAll('style')).map(s => s.textContent || '');

  return {
    title: document.title,
    computed, assets, iframes, inlineStyles,
    totalElements: all.length,
  };
})()`;

async function capturePage(
  context: BrowserContext,
  url: string,
  origin: string,
  pagesRoot: string,
  settleMs: number,
): Promise<PageCapture> {
  const route = new URL(url).pathname.replace(/\/$/, '') || '/';
  const slug = route === '/' ? 'home' : route.slice(1).replace(/\//g, '__');
  const dir = join(pagesRoot, slug);
  await mkdir(join(dir, 'styles'), { recursive: true });

  const page = await context.newPage();

  // collect external stylesheets as they arrive
  const sheets: { url: string; body: string }[] = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (ct.includes('text/css') || /\.css(\?|$)/.test(res.url())) {
        sheets.push({ url: res.url(), body: await res.text() });
      }
    } catch { /* stream gone — skip */ }
  });

  let resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  // 403/429 are bot-detection / rate-limit blocks — wait and retry a couple times
  let tries = 0;
  while (resp && (resp.status() === 403 || resp.status() === 429) && tries < 2) {
    tries++;
    await page.waitForTimeout(2500 * tries); // back off
    resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  }
  if (resp && resp.status() >= 400) {
    await page.close();
    throw new Error(`HTTP ${resp.status()}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(settleMs); // let JS-applied styles land

  // scroll the full page so lazy content loads AND scroll-triggered animations fire
  // (string-form evaluate — see __name note in discoverViaNav)
  await page.evaluate(`new Promise(done => {
    let y = 0;
    const step = () => {
      y += 700;
      window.scrollTo(0, y);
      if (y < document.body.scrollHeight) setTimeout(step, 90);
      else { window.scrollTo(0, 0); setTimeout(done, 300); }
    };
    step();
  })`);

  // FINALIZE ANIMATIONS: Elementor & similar start elements hidden (opacity:0,
  // translated, clipped) and reveal them via JS on scroll. If we capture before
  // that completes, text/sections render frozen-hidden. Force everything to its
  // FINAL visible state so the reproduction looks like the finished page.
  await page.evaluate(`(() => {
    // 1. mark Elementor entrance animations as done (their CSS reveals on this class)
    document.querySelectorAll('.elementor-invisible').forEach(el => {
      el.classList.remove('elementor-invisible');
    });
    document.querySelectorAll('[class*="animated"], [data-settings*="animation"]').forEach(el => {
      el.classList.add('animated');
      el.style.opacity = '1';
      el.style.visibility = 'visible';
    });
    // 2. neutralize inline animation-hiding on ANY element left invisible
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      // only touch elements that are hidden BY animation (not intentionally display:none)
      if (cs.display !== 'none') {
        if (parseFloat(cs.opacity) === 0) el.style.opacity = '1';
        if (cs.visibility === 'hidden' && !el.hasAttribute('hidden')) el.style.visibility = 'visible';
        // undo common entrance transforms that leave content off-screen/clipped
        if (/translate|scale\(0|matrix/.test(cs.transform) && cs.transform !== 'none') {
          el.style.transform = 'none';
        }
        if (cs.clipPath && cs.clipPath !== 'none') el.style.clipPath = 'none';
      }
    });
    // 3. finish any running CSS animations at their end state
    document.getAnimations?.().forEach(a => { try { a.finish(); } catch(e) {} });
  })()`).catch(() => {});
  await page.waitForTimeout(400); // let the forced styles settle

  // REVOLUTION SLIDER extraction: revslider is JS-driven, so its slides are
  // inert markup after we strip scripts. Drive the slider through every slide
  // via its jQuery API, capture each slide's content, so we can bake all slides
  // in statically + write a rebuild spec. (No-op if the page has no revslider.)
  const sliderSpec = await page.evaluate(`(async () => {
    const results = [];
    const sliders = document.querySelectorAll('rs-module, .rev_slider, .tp-revslider-mainul, [id*="rev_slider"]');
    for (const container of sliders) {
      const root = container.closest('rs-module-wrap, .rev_slider_wrapper, .rev_slider') || container;
      const id = root.id || root.querySelector('[id]')?.id || 'slider';
      // find slide elements (revslider uses <rs-slide> in v6, <li> in v5)
      let slideEls = root.querySelectorAll('rs-slide');
      if (!slideEls.length) slideEls = root.querySelectorAll('.tp-revslider-mainul > li, ul > li[data-index]');
      const slides = [];
      for (const s of slideEls) {
        // main background image
        const bgEl = s.querySelector('rs-sbg, img.rev-slidebg, .tp-bgimg, img');
        const bg = bgEl ? (bgEl.getAttribute('src') || bgEl.getAttribute('data-lazyload') || bgEl.getAttribute('data-src') || '') : '';
        // text layers (headings, paragraphs, buttons)
        const layers = [];
        for (const layer of s.querySelectorAll('rs-layer, .tp-caption, [class*="rs-layer"]')) {
          const text = (layer.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text) layers.push({ text: text.slice(0, 300), tag: layer.tagName.toLowerCase() });
        }
        const links = [];
        for (const a of s.querySelectorAll('a')) { const h = a.getAttribute('href'); if (h) links.push({ text: (a.textContent||'').trim().slice(0,80), href: h }); }
        slides.push({ bg, layers, links });
      }
      if (slides.length) results.push({ id, slideCount: slides.length, slides });
    }
    return results;
  })()`).catch(() => []) as any[];
  if (sliderSpec.length) {
    const totalSlides = sliderSpec.reduce((n: number, s: any) => n + s.slideCount, 0);
    console.log(`[molt]   ↳ captured ${sliderSpec.length} slider(s), ${totalSlides} slide(s) total`);
  }

  const extract = await page.evaluate(IN_PAGE_EXTRACT) as {
    title: string;
    computed: unknown[]; assets: unknown[]; iframes: unknown[];
    inlineStyles: string[]; totalElements: number;
  };

  // enrich iframe provider from the Node side: in-page contentDocument is
  // blocked by frame isolation, but Playwright can read child frames directly.
  const sniff = (s: string) =>
    /mixcloud/i.test(s) ? 'mixcloud' :
    /youtube|youtu\.be/i.test(s) ? 'youtube' :
    /vimeo/i.test(s) ? 'vimeo' :
    /google\.[a-z.]+\/maps|maps\.google/i.test(s) ? 'maps' : 'unknown';
  const childFrames = page.frames().slice(1);
  const ifrList = extract.iframes as { src: string; provider: string }[];
  for (const fr of childFrames) {
    try {
      const target = ifrList.find((f) => f.provider === 'unknown' && f.src === fr.url());
      if (!target) continue;
      const p1 = sniff(fr.url());
      const p2 = p1 !== 'unknown' ? p1 : sniff((await fr.content()).slice(0, 12000));
      if (p2 !== 'unknown') target.provider = p2;
    } catch { /* frame gone or cross-origin-blocked — leave unknown */ }
  }

  const dom = await page.content();

  // write artifacts
  const styleFiles: string[] = [];
  let styleBytes = 0;
  let si = 0;
  for (const s of sheets) {
    const f = `styles/ext-${si++}.css`;
    await writeFile(join(dir, f), `/* ${s.url} */\n` + s.body);
    styleFiles.push(f);
    styleBytes += s.body.length;
  }
  extract.inlineStyles.forEach(async (css, i) => {
    if (!css.trim()) return;
    const f = `styles/inline-${i}.css`;
    await writeFile(join(dir, f), css);
    styleFiles.push(f);
    styleBytes += css.length;
  });

  // DOWNLOAD FONTS: the CSS references icon fonts (Fontello, trx_addons, etc.)
  // and web fonts by URL on the original server. If we only bundle the CSS, the
  // font files are missing → icons show as blank boxes. Download each font file
  // and rewrite the CSS to point at the local copy, so icons/fonts render.
  await mkdir(join(dir, 'fonts'), { recursive: true });
  const fontUrlMap = new Map<string, string>(); // original url → local path
  let fontIdx = 0;
  for (const f of styleFiles) {
    const cssPath = join(dir, f);
    let css = await readFile(cssPath, 'utf-8');
    const urls = new Set<string>();
    for (const m of css.matchAll(/url\((['"]?)([^'")]+\.(?:woff2?|ttf|otf|eot))(\?[^'")]*)?\1\)/gi)) {
      urls.add(m[2] + (m[3] ?? ''));
    }
    for (const rawUrl of urls) {
      try {
        const abs = new URL(rawUrl, origin).toString();
        if (!fontUrlMap.has(abs)) {
          const resp = await page.request.get(abs, { timeout: 12000 });
          if (resp.ok()) {
            const buf = await resp.body();
            const ext = (abs.split('?')[0].match(/\.(woff2?|ttf|otf|eot)$/i)?.[1]) ?? 'woff2';
            const local = `fonts/font-${fontIdx++}.${ext}`;
            await writeFile(join(dir, local), buf);
            fontUrlMap.set(abs, local);
          }
        }
        const local = fontUrlMap.get(abs);
        if (local) {
          // rewrite every occurrence of this url in the css to the local path
          css = css.split(rawUrl).join('./' + local.replace('fonts/', '../fonts/'));
        }
      } catch { /* font unreachable — leave original url */ }
    }
    await writeFile(cssPath, css);
  }
  if (fontIdx > 0) console.log(`[molt]   ↳ bundled ${fontIdx} font file(s)`);

  await writeFile(join(dir, 'page.html'), dom);
  await writeFile(join(dir, 'computed.json'), JSON.stringify(extract.computed, null, 1));
  await writeFile(join(dir, 'assets.json'), JSON.stringify(extract.assets, null, 1));
  await writeFile(join(dir, 'iframes.json'), JSON.stringify(extract.iframes, null, 1));
  await writeFile(join(dir, 'sliders.json'), JSON.stringify(sliderSpec, null, 2));
  // Screenshot at a LOCKED width. fullPage can expand to the widest element,
  // producing inconsistent widths per page — which wrecks the pixel comparison
  // (misaligned images score near-zero). Force width=1440 to match the render.
  const fullH = await page.evaluate(`document.documentElement.scrollHeight`).catch(() => 900) as number;
  await page.setViewportSize({ width: 1440, height: Math.min(fullH || 900, 20000) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(dir, 'original.png'), clip: { x: 0, y: 0, width: 1440, height: Math.min(fullH || 900, 20000) } });
  await page.close();

  return {
    url,
    route,
    title: extract.title,
    files: {
      dom: `${slug}/page.html`,
      stylesheets: styleFiles.map((f) => `${slug}/${f}`),
      computed: `${slug}/computed.json`,
      assets: `${slug}/assets.json`,
      iframes: `${slug}/iframes.json`,
      screenshot: `${slug}/original.png`,
      sliders: `${slug}/sliders.json`,
    },
    stats: {
      elements: extract.totalElements,
      styledElements: extract.computed.length,
      assets: extract.assets.length,
      iframes: extract.iframes.length,
      stylesheetBytes: styleBytes,
    },
  };
}

// ---------------------------------------------------------------- main

export async function crawl(opts: CrawlOptions): Promise<CaptureManifest> {
  const { startUrl: rawUrl, outDir, maxPages = 25, settleMs = 600, scope = 'core', urls: explicitUrls } = opts;
  const startUrl = normalizeStartUrl(rawUrl);
  const origin = new URL(startUrl).origin;
  await mkdir(outDir, { recursive: true });

  // overall time budget — a large/slow site must never hang the worker forever
  const budgetMs = Number(process.env.MOLT_CRAWL_BUDGET_MS ?? 240000); // 4 min default
  const deadline = Date.now() + budgetMs;

  let browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', // hides navigator.webdriver
    ],
  });
  // a context that looks like a real Chrome on macOS — the default headless UA
  // ("HeadlessChrome") is an instant bot flag that triggers 403s.
  let context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });
  const probe = await context.newPage();

  let urls: string[];
  let discovery: CaptureManifest['discovery'];
  let coreRouteSet = new Set<string>();

  if (explicitUrls && explicitUrls.length > 0) {
    // EXPLICIT LIST: the user told us exactly which pages to migrate. No guessing,
    // no discovery, no scope filter — resolve each entry against the site and use it.
    await probe.close();
    const resolved: string[] = [];
    for (const raw of explicitUrls) {
      const t = raw.trim();
      if (!t) continue;
      try {
        // accept full URLs, "/paths", or bare "slug"
        const u = /^https?:\/\//i.test(t) ? new URL(t) : new URL(t.replace(/^\/+/, '/').startsWith('/') ? t : '/' + t, origin);
        if (u.origin !== origin) continue;         // same site only
        u.hash = ''; u.search = '';
        let p = u.pathname; if (!p.endsWith('/')) p += '/';
        const full = u.origin + p;
        if (!resolved.includes(full)) resolved.push(full);
      } catch { /* skip unparseable entry */ }
    }
    urls = resolved.slice(0, maxPages);
    discovery = 'manual';
    for (const u of urls) { try { coreRouteSet.add(new URL(u).pathname.replace(/\/$/, '') || '/'); } catch { /* */ } }
    console.log(`[molt] discovery: manual · ${urls.length} page(s) chosen by user`);
  } else {
    // AUTO: discover pages (menu → nav → sitemap), rank, apply scope.
    const menuPages = await discoverViaMenu(probe, origin, startUrl);
    const navPages = await discoverViaNav(probe, origin, startUrl, maxPages, menuPages);
    const sitemapPages = await discoverViaSitemap(probe, origin);
    await probe.close();

    const menuSet = new Set([...menuPages, ...navPages]);
    const ranked = [
      ...[...menuSet].sort((a, b) => pageScore(new URL(a).pathname) - pageScore(new URL(b).pathname)),
      ...sitemapPages
        .filter((u) => !menuSet.has(u))
        .sort((a, b) => pageScore(new URL(a).pathname) - pageScore(new URL(b).pathname)),
    ];
    discovery = menuSet.size > 0 ? 'nav-bfs' : 'sitemap';
    for (const u of menuSet) {
      try { coreRouteSet.add(new URL(u).pathname.replace(/\/$/, '') || '/'); } catch { /* skip */ }
    }
    const scoped = ranked.filter((u) => {
      try { return inScope(new URL(u).pathname.replace(/\/$/, '') || '/', scope, coreRouteSet, menuSet.size > 0); }
      catch { return true; }
    });
    urls = [...new Set(scoped)].slice(0, maxPages);
    console.log(`[molt] discovery: ${discovery} · scope=${scope} · ${menuSet.size} nav + ${sitemapPages.length} sitemap → ${urls.length} page(s) after scope+junk filter`);
  }

  const pages: PageCapture[] = [];
  // launch helper so we can RELAUNCH the whole browser if it crashes (a dead
  // context makes every subsequent newPage() fail — the cascade we kept seeing).
  const launchArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
  ];
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  };
  const relaunch = async () => {
    try { await context.close(); } catch { /* already dead */ }
    try { await browser.close(); } catch { /* already dead */ }
    browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: launchArgs });
    context = await browser.newContext(ctxOpts);
  };

  for (const url of urls) {
    if (Date.now() > deadline) {
      console.log(`[molt] crawl budget reached — stopping at ${pages.length}/${urls.length} pages`);
      break;
    }
    process.stdout.write(`[molt] capture ${url} … `);
    let captured = false;
    for (let attempt = 1; attempt <= 2 && !captured; attempt++) {
      try {
        const cap = await capturePage(context, url, origin, outDir, settleMs);
        pages.push(cap);
        captured = true;
        console.log(
          `ok · ${cap.stats.elements} el · ${cap.stats.styledElements} styled · ` +
          `${cap.stats.assets} assets · ${cap.stats.iframes} iframes`,
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 1 && /crash|Target.*closed|context.*closed|detached|browser has been closed/i.test(msg)) {
          process.stdout.write(`(browser crashed — relaunching) `);
          await relaunch();                       // RELAUNCH, not just a new page
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        console.log(`FAILED: ${msg}`);
      }
    }
    await new Promise((r) => setTimeout(r, 800)); // pace requests
  }
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  // core = pages that came from the real nav menu (coreRouteSet built above).
  const corePages = pages.map((p) => p.route).filter((r) => coreRouteSet.has(r));

  const manifest: CaptureManifest = {
    site: origin,
    corePages: corePages.length ? corePages : undefined,
    crawledAt: new Date().toISOString(),
    discovery,
    pages,
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
