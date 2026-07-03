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
import { mkdir, writeFile } from 'node:fs/promises';
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
    const resp = await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (resp && resp.status() >= 400) return [];
    // prefer links inside <nav>/<header>/menu containers — the actual site menu
    const hrefs: string[] = await page.evaluate(
      `(() => {
        const sel = 'header a[href], nav a[href], [class*="menu"] a[href], [class*="nav"] a[href]';
        const menu = Array.from(document.querySelectorAll(sel)).map(a => a.href);
        return menu.length ? menu : Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
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

  // scroll the full page so lazy content loads, then return to top
  // (string-form evaluate — see __name note in discoverViaNav)
  await page.evaluate(`new Promise(done => {
    let y = 0;
    const step = () => {
      y += 900;
      window.scrollTo(0, y);
      if (y < document.body.scrollHeight) setTimeout(step, 80);
      else { window.scrollTo(0, 0); setTimeout(done, 200); }
    };
    step();
  })`);

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

  await writeFile(join(dir, 'page.html'), dom);
  await writeFile(join(dir, 'computed.json'), JSON.stringify(extract.computed, null, 1));
  await writeFile(join(dir, 'assets.json'), JSON.stringify(extract.assets, null, 1));
  await writeFile(join(dir, 'iframes.json'), JSON.stringify(extract.iframes, null, 1));
  await page.screenshot({ path: join(dir, 'original.png'), fullPage: true });
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
  const { startUrl: rawUrl, outDir, maxPages = 25, settleMs = 600 } = opts;
  const startUrl = normalizeStartUrl(rawUrl);
  const origin = new URL(startUrl).origin;
  await mkdir(outDir, { recursive: true });

  // overall time budget — a large/slow site must never hang the worker forever
  const budgetMs = Number(process.env.MOLT_CRAWL_BUDGET_MS ?? 240000); // 4 min default
  const deadline = Date.now() + budgetMs;

  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', // hides navigator.webdriver
    ],
  });
  // a context that looks like a real Chrome on macOS — the default headless UA
  // ("HeadlessChrome") is an instant bot flag that triggers 403s.
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });
  const probe = await context.newPage();

  // 1) the real navigation menu = the pages a human considers "the site"
  const menuPages = await discoverViaMenu(probe, origin, startUrl);
  // 2) BFS one level from those to catch real sub-pages they link to
  const navPages = await discoverViaNav(probe, origin, startUrl, maxPages, menuPages);
  // 3) sitemap only to SUPPLEMENT — filtered, and only if we have budget left
  const sitemapPages = await discoverViaSitemap(probe, origin);
  await probe.close();

  // rank: menu/nav pages first (real content), then shallow sitemap pages.
  // junk was already filtered by normalizeUrl; KEEP_LISTINGS survive.
  const menuSet = new Set([...menuPages, ...navPages]);
  const ranked = [
    ...[...menuSet].sort((a, b) => pageScore(new URL(a).pathname) - pageScore(new URL(b).pathname)),
    ...sitemapPages
      .filter((u) => !menuSet.has(u))
      .sort((a, b) => pageScore(new URL(a).pathname) - pageScore(new URL(b).pathname)),
  ];
  const discovery: CaptureManifest['discovery'] = menuSet.size > 0 ? 'nav-bfs' : 'sitemap';
  const urls = [...new Set(ranked)].slice(0, maxPages);

  console.log(`[molt] discovery: ${discovery} · ${menuSet.size} nav + ${sitemapPages.length} sitemap → ${urls.length} page(s) (junk filtered)`);

  const pages: PageCapture[] = [];
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
        if (attempt === 1 && /crash|Target closed|detached/i.test(msg)) {
          process.stdout.write(`(retry after crash) `);
          await new Promise((r) => setTimeout(r, 1500));
          continue; // one more try with a fresh page
        }
        console.log(`FAILED: ${msg}`);
      }
    }
    await new Promise((r) => setTimeout(r, 800)); // pace requests — avoid tripping rate limits
  }
  await context.close();
  await browser.close();

  // core = pages that came from the real nav menu (routes normalized).
  const coreRouteSet = new Set<string>();
  for (const u of menuSet) {
    try { coreRouteSet.add(new URL(u).pathname.replace(/\/$/, '') || '/'); } catch { /* skip */ }
  }
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
