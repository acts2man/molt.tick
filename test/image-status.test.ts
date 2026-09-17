import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browser } from '../src/reconstruct/runtime.js';
import { geometry } from '../src/reconstruct/capture.js';

test('image diagnostics distinguish decoded and off-screen images from real visible failures', {skip: process.env.MOLT_RUN_BROWSER_TESTS !== '1'}, async () => {
  const engine = await browser();
  try {
    const page = await engine.newPage({viewport: {width: 800, height: 600}});
    await page.setContent('<html><body><img id="loaded" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22%3E%3C/svg%3E"><img id="deferred" width="20" height="20" style="position:absolute;left:5000px" src="data:image/png;base64,AAAA"></body></html>');
    await page.evaluate("document.getElementById('loaded').decode()");
    await page.evaluate("Object.defineProperty(document.getElementById('loaded'),'complete',{get:()=>false})");
    assert.equal((await geometry(page)).brokenImages, 0, 'decoded image with incomplete flag and off-screen slide are not missing images');
    await page.evaluate("document.getElementById('deferred').style.left='100px'");
    assert.equal((await geometry(page)).brokenImages, 1, 'visible image without decoded dimensions is still reported');
  } finally { await engine.close(); }
});
