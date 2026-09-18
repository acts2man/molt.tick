import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { browser } from '../src/reconstruct/runtime.js';

const origin = 'https://moltick.netlify.app';
const out = 'studio-live-output';
await mkdir(out, { recursive: true });
const deadline = Date.now() + 6 * 60_000;
let session: any = null;
// Netlify's connected build can finish after the GitHub workflow starts.
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${origin}/api/molt/session`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (r.ok && r.headers.get('content-type')?.includes('application/json')) {
      session = await r.json();
      if (session.serverReady === true) {const home=await fetch(origin+'/plans',{signal:AbortSignal.timeout(10000)});if(home.ok){const html=await home.text();if(html.includes('Your next creative chapter'))break;}}
    }
  } catch { /* Deployment may still be starting. */ }
  await new Promise(r => setTimeout(r, 10_000));
}
assert.equal(session?.serverReady, true, 'Netlify must serve the real configured Studio API');
assert.equal(session.authenticated, false, 'An anonymous visitor must not inherit a Molt account session');
assert.equal(session.connected, false, 'An anonymous visitor must not inherit the owner GitHub integration');
const privateResponse = await fetch(`${origin}/api/molt/jobs`, { signal: AbortSignal.timeout(15_000) });
assert.equal(privateResponse.status, 401, 'Private job data must require authentication');
const engine = await browser();
const errors: string[] = [];
try {
  for (const width of [1440, 768, 390]) {
    const ctx = await engine.newContext({ viewport: { width, height: 1000 } });
    try {
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(e.message));
      for (const route of ['/', '/plans', '/how-it-works', '/migration-guide', '/login']) {
        const response = await page.goto(origin + route, { waitUntil: 'networkidle', timeout: 30_000 });
        assert.equal(response?.status(), 200, `Live route ${route}`);
        await page.locator('main h1').waitFor();
        assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'), false, `${route} at ${width}: no horizontal overflow`);
        await page.screenshot({ path: `${out}/${route === '/' ? 'landing' : route.slice(1)}-${width}.png`, fullPage: true });
      }
      for (const route of ['/studio','/connections','/activity','/guide','/usage']) {
        await page.goto(origin + route, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForURL(/\/login\?return=/,{timeout:15_000});
        await page.getByLabel('Email').waitFor();
        assert.match(page.url(),/\/login\?return=/,`Private route ${route} must redirect to Molt sign-in`);
      }
    } finally { await ctx.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/live-check.json`, JSON.stringify({
    passed: true, origin, session, privateJobsStatus: privateResponse.status,
    viewports: [1440, 768, 390], publicRoutes: ['/', '/plans', '/how-it-works', '/migration-guide', '/login'], privateRoutes: ['/studio','/connections','/activity','/guide','/usage'],
    boundary: 'Read-only deployed checks. Anonymous visitors must be redirected to account sign-in for private Studio routes. No credentials, paid model calls, or client reconstructions were used.',
  }, null, 2));
} finally { await engine.close(); }
