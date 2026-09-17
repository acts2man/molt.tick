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
      if (session.serverReady === true) break;
    }
  } catch { /* Deployment may still be starting. */ }
  await new Promise(r => setTimeout(r, 10_000));
}
assert.equal(session?.serverReady, true, 'Netlify must serve the real configured Studio API');
assert.equal(session.connected, false, 'An anonymous visitor must not inherit a workspace session');
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
      for (const route of ['/', '/connections', '/activity', '/guide']) {
        const response = await page.goto(origin + route, { waitUntil: 'networkidle', timeout: 30_000 });
        assert.equal(response?.status(), 200, `Live route ${route}`);
        await page.locator('main h1').waitFor();
        assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'), false, `${route} at ${width}: no horizontal overflow`);
        await page.screenshot({ path: `${out}/${route === '/' ? 'studio' : route.slice(1)}-${width}.png`, fullPage: true });
      }
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await page.locator('dialog[open]').waitFor();
      assert.equal(await page.locator('dialog input').getAttribute('type'), 'password');
      await page.keyboard.press('Escape');
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    } finally { await ctx.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/live-check.json`, JSON.stringify({
    passed: true, origin, session, privateJobsStatus: privateResponse.status,
    viewports: [1440, 768, 390], routes: ['/', '/connections', '/activity', '/guide'],
    boundary: 'Read-only deployed checks. No authentication bypass, credentials, paid model calls, or client reconstructions were used.',
  }, null, 2));
} finally { await engine.close(); }
