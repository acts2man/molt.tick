import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve,browser } from '../src/reconstruct/runtime.js';
const out=resolve('studio-test-output');await mkdir(out,{recursive:true});
const host=await serve(resolve('studio/dist'),{'/':'index.html','/connections':'index.html','/activity':'index.html','/guide':'index.html'});
const engine=await browser();const errors:string[]=[];
try{
  for(const width of [1440,390]){
    const ctx=await engine.newContext({viewport:{width,height:1000}});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
    await ctx.route('**/api/molt/session',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({connected:false,login:null,serverReady:true,repository:'acts2man/molt.tick',branch:'main'})}));
    await page.goto(host.origin);await page.getByRole('heading',{name:/Keep the look/}).waitFor();
    assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth'),false,`No horizontal overflow at ${width}`);
    await page.screenshot({path:out+`/studio-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'Connect GitHub',exact:true}).click();await page.locator('dialog[open]').waitFor();
    assert.equal(await page.locator('dialog input').getAttribute('type'),'password');await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});
    await page.goto(host.origin+'/connections');await page.getByRole('heading',{name:'Your studio, configured.'}).waitFor();
    await page.screenshot({path:out+`/connections-${width}.png`,fullPage:true});
    assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await ctx.close();
  }
  assert.deepEqual(errors,[]);await writeFile(out+'/result.json',JSON.stringify({passed:true,viewports:[1440,390],checks:['real React build','deep route','no overflow','keyboard dialog close','password input'],boundary:'API session responses mocked; no real credentials, paid jobs, or production source quality are implied.'},null,2));
}finally{await engine.close();await host.close();}
