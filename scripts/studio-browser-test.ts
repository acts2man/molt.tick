import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve, browser } from '../src/reconstruct/runtime.js';
const out = resolve('studio-test-output');
await mkdir(out, { recursive: true });
const host = await serve(resolve('studio/dist'), {'/':'index.html','/connections':'index.html','/activity':'index.html','/guide':'index.html'});
const engine = await browser();
const errors: string[] = [], failures: string[] = [];
async function inspect(page: any, name: string, width: number) {
  await page.screenshot({path: `${out}/${name}-${width}.png`, fullPage: true});
  const layout = await page.evaluate(`(() => ({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,cls:e.className,x:r.x,y:r.y,width:r.width,right:r.right,position:s.position,display:s.display,text:(e.textContent||'').slice(0,80)}}).filter(e=>e.right>innerWidth+1||e.x< -1).slice(0,30)}))()`);
  await writeFile(`${out}/${name}-${width}-layout.json`, JSON.stringify(layout, null, 2));
  if (layout.scrollWidth > width + 1) failures.push(`${name}: horizontal overflow at ${width} (${layout.scrollWidth})`);
}
try {
  for (const width of [1440, 768, 390]) {
    const ctx = await engine.newContext({viewport:{width,height:1000}});
    try {
      const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
      await ctx.route('**/api/molt/session',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({connected:false,login:null,serverReady:true,repository:'acts2man/molt.tick',branch:'main'})}));
      await page.goto(host.origin);await page.getByRole('heading',{name:/Keep the look/}).waitFor();
      await inspect(page, 'studio', width);
      await page.getByRole('button',{name:'Connect GitHub',exact:true}).click();await page.locator('dialog[open]').waitFor();
      await page.screenshot({path:`${out}/connection-dialog-${width}.png`,fullPage:true});
      assert.equal(await page.locator('dialog input').getAttribute('type'),'password');
      await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});
      for (const path of ['connections','activity','guide']) {
        await page.goto(host.origin+'/'+path);await page.locator('main h1').waitFor();
        await inspect(page,path,width);
      }
    } catch (e) { failures.push(`${width}: ${(e as Error).message}`); }
    finally { await ctx.close(); }
  }
  await writeFile(out+'/result.json',JSON.stringify({passed:!failures.length&&!errors.length,viewports:[1440,768,390],failures,errors,checks:['real React build','deep routes','no overflow','keyboard dialog close','password input'],boundary:'API session responses mocked; no real credentials, paid jobs, or production source quality are implied.'},null,2));
  assert.deepEqual([...failures,...errors],[]);
} finally { await engine.close();await host.close(); }
