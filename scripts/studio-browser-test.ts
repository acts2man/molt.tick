import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve,browser} from '../src/reconstruct/runtime.js';
const out=resolve('studio-test-output');await mkdir(out,{recursive:true});
const routes=['/','/studio','/connections','/activity','/guide','/how-it-works','/migration-guide','/plans','/usage','/login'];
const host=await serve(resolve('studio/dist'),Object.fromEntries(routes.map(r=>[r,'index.html'])));
const engine=await browser(),errors:string[]=[];
try{
 for(const width of [1440,768,390]){
  const ctx=await engine.newContext({viewport:{width,height:1000}}),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await ctx.route('**/api/molt/session',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({connected:false,login:null,serverReady:true,repository:'acts2man/molt.tick',branch:'main'})}));
  for(const route of routes){
   await page.goto(host.origin+route);await page.locator('main h1').waitFor();
   await page.screenshot({path:out+`/${route==='/'?'landing':route.slice(1)}-${width}.png`,fullPage:true});
   assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth+1'),false,`No horizontal overflow on ${route} at ${width}`);
  }
  await page.goto(host.origin+'/login');await page.getByLabel('Email').waitFor();assert.equal(await page.getByLabel('Password').getAttribute('type'),'password');
  await page.goto(host.origin+'/studio');await page.getByRole('button',{name:'Connect GitHub',exact:true}).click();await page.locator('dialog[open]').waitFor();
  assert.equal(await page.locator('dialog input').getAttribute('type'),'password');await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Next: choose pages'}).click();await page.getByRole('button',{name:'Next: review the scope'}).click();
  await page.getByText('What to expect:',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Start development test'}).count(),0,'Anonymous visitors cannot submit jobs');
  await page.goto(host.origin+'/plans');await page.getByLabel('Estimate page count').fill('5');await page.getByLabel('Estimate complexity').selectOption('complex');
  assert.match(await page.locator('.credit-result strong').innerText(),/210/);
  await page.getByLabel('Estimate page count').fill('2.5');
  assert.equal(await page.getByLabel('Estimate page count').inputValue(),'2');
  assert.match(await page.locator('.credit-result strong').innerText(),/90/,'A fractional input cannot crash the planner');
  await page.goto(host.origin+'/migration-guide');await page.locator('.migration-check input').first().check();await page.reload();
  await page.waitForFunction("document.querySelector('.migration-check input')?.checked === true");
  assert.equal(await page.locator('.migration-check input').first().isChecked(),true,'Checklist persists only locally');
  await ctx.close();
 }
 const ctx=await engine.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage();
 await ctx.route('**/api/molt/session',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({connected:true,login:'acts2man',serverReady:true,repository:'acts2man/molt.tick',branch:'main'})}));
 await ctx.route('**/api/molt/settings',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({provider:'openai',model:'gpt-6-astra',keyPresent:false,modelConfigured:false,workflow:true,ready:false})}));
 await ctx.route('**/api/molt/jobs',r=>r.fulfill({contentType:'application/json',body:'{"jobs":[]}'}));
 await page.goto(host.origin+'/connections');await page.getByLabel('OpenAI model preset').waitFor();assert.equal(await page.getByLabel('Exact API model ID').inputValue(),'gpt-6-astra');
 await page.screenshot({path:out+'/owner-setup-1440.png',fullPage:true});await ctx.close();
 assert.deepEqual(errors,[]);await writeFile(out+'/result.json',JSON.stringify({passed:true,viewports:[1440,768,390],routes,checks:['public landing','model preset','owner-only wizard','credit calculator including decimal input','local migration checklist','no overflow','keyboard dialog','no runtime errors'],boundary:'API data mocked. No real authentication, model charges, subscription payments, or client reconstruction quality was tested.'},null,2));
}finally{await engine.close();await host.close();}
