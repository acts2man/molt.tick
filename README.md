# Molt — WordPress → React migration engine

**WordPress in. React out.** Molt crawls a live WordPress site, rebuilds it as a
modern React codebase (TanStack + Tailwind, Lovable-editable shape), and pushes
it to a repo — pixel-verified, page by page.

Pipeline: **Crawl → Normalize → Plan → Synthesize → Verify → Ship**

## Status (v0.1)

| Stage | State | Notes |
|---|---|---|
| 1 Crawl | ✅ built + validated | discovery (sitemap + nav-BFS), full per-page capture |
| 2 Normalize | ✅ built + validated | Elementor → IR, deterministic, no AI |
| 3 Plan | ◻ next | shared-chrome detection, widget classification, flags |
| 4 Synthesize | ◻ | IR → React/TanStack; seeded by the proven S2S component library |
| 5 Verify | ◻ | pixel diff + real route click-throughs |
| 6 Ship | ◻ | GitHub App push to the user's Lovable-born repo |

## What the crawler captures (per page)

1. **Rendered DOM** — post-JS, what the site actually shows
2. **Every stylesheet** — static CSS survives intact (465 KB on the reference
   homepage vs. the ~14 KB a SingleFile capture kept)
3. **Computed-style sidecar** — `getComputedStyle` per element, keyed by a
   stable path + Elementor id. Catches styles applied by JS at runtime — the
   `rotateY(30°) translateZ(-1344px)` class of problem no static capture sees.
4. **Assets in DOM order** — order is sacred (galleries). Lightbox full-size
   URLs recovered from `href` or decoded from `data-e-action-hash`.
5. **Iframe manifest** — provider-detected (src → title → frame-content sniff)
6. **Full-page screenshot** — ground truth for Stage 5 pixel-diff

## Validation (against the completed Soul2Souls reference migration)

Run on a local reconstruction of the site built from its real captures:

- **7/7 pages** discovered (nav-BFS) and captured; 404s correctly skipped
- **Gallery order: 89/89 photos position-for-position identical** to the
  hand-verified ground truth (`IMG_4867` → `SNRX5420`)
- **Podcasts: 15/15 iframes identified as Mixcloud**
- Sidecar: 2,610 styled elements on the homepage, 171 with Elementor ids,
  162 elements carrying live transform matrices site-wide
- Normalizer reproduced the prior proof-of-concept's exact hero benchmarks:
  heading `b940335` text + tag, button `f5cc07e` text + href, images
  `01ab8f1`/`9c6e656` with exact dimensions — **plus** live computed styles
  resolved per element, which the old PoC could not do
- Unknown plugin widgets flagged by name on every page:
  `sr-e-menu · sr-offcanvas · music-player · social-icons · icon-box` — the
  exact set that became the proven React component library in the reference
  migration. The identical flag signature across pages is the Stage-3
  shared-chrome signal.

## Run it

```bash
npm install

# crawl a live site
npm run crawl -- https://example.com --out capture --max 50

# normalize a captured page → IR
npm run normalize -- capture home

# local validation harness (serves a reconstructed site in-process, crawls it)
npx tsx test/local-crawl.ts /path/to/site-dir /tmp/molt-capture /about/
```

Chromium path defaults to the dev container's install; override with
`MOLT_CHROME=/path/to/chrome`.

## Known v0 gaps (deliberate)

- `spacer` / `divider` widgets are skipped (pure spacing; layout fidelity
  comes from the sidecar) — revisit in Synthesize
- Static-CSS → IR merge (parsing captured stylesheets per element id) is a
  planned pass; the sidecar carries the load meanwhile
- Sitemap discovery is unit-level tested; nav-BFS is E2E tested (the local
  fixture has no sitemap — most live WP sites do)
- In-page `evaluate` blocks are **string-form on purpose**: tsx/esbuild
  injects a `__name` helper into transformed arrow functions that doesn't
  exist in the browser. Keep them strings.

## Architecture decisions of record

- **Lovable is one-way** (export-only; it can't import an existing repo).
  Output repos must be *born from Lovable*, then Molt pushes into them via a
  scoped GitHub App. Push to `main` by default; PR path opt-in **with guided
  merge instructions** for non-Git users.
- Output shape must stay Lovable-editable: React/Vite or TanStack Start,
  single root `package.json`, working dev script, Tailwind, no monorepo.
- Lovable is the primary destination, not a lock-in — the same output deploys
  to Vercel/Netlify or ships as a download.
