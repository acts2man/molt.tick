import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../src/reconstruct/capture.js';
import { compare, referenceImages } from '../src/reconstruct/images.js';
import { runReconstruction } from '../src/reconstruct/agent.js';
import type { Model } from '../src/reconstruct/types.js';

const CSS=`*{box-sizing:border-box}body{margin:0;line-height:1.5;font-family:Arial,sans-serif;background:#101114;color:#efeee8}header{height:80px;padding:24px 6%;display:flex;gap:24px;align-items:center;border-bottom:1px solid #393939}a{color:inherit;text-decoration:none}main{padding:64px 6%;max-width:1000px}h1{font-size:48px;line-height:1.1;font-weight:700;margin:0 0 24px}p{font-size:18px;line-height:1.6;margin:0 0 24px}.accent{color:#dbad6b}footer{padding:24px 6%;border-top:1px solid #393939}details{margin-top:28px;border-top:1px solid #393939;padding-top:18px}summary{cursor:pointer;font-weight:700}details p{margin:14px 0 0}img{display:block;width:36px;height:36px}@media(max-width:600px){header{height:72px;padding:18px 6%}main{padding:40px 6%}h1{font-size:34px}}`;
const title=(route:string)=>route==='/'?'A quieter kind of studio.':'Made with intention.';
const text=(route:string)=>route==='/'?'Considered spaces. Clear ideas. Everything in its place.':'We build spaces around the people who use them.';
const html=(route:string)=>`<!doctype html><html><head><meta charset="utf-8"><title>Studio</title><style>${CSS}</style></head><body><header><img src="logo.svg" alt="Studio mark"><a href="/">Studio</a><a href="/about">About</a></header><main><h1>${title(route)}</h1><p>${text(route)}</p><a class="accent" href="/about">Explore our work</a><details><summary>Project notes</summary><p>Hidden until opened.</p></details></main><footer>Studio, thoughtfully made.</footer></body></html>`;
async function fixture(fn:(dir:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'molt-browser-'));
  try{
    await mkdir(join(dir,'bundle'));
    await writeFile(join(dir,'bundle/logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect x="4" y="4" width="28" height="28" rx="8" fill="#dbad6b"/></svg>');
    for(const route of ['/','/about'])await writeFile(join(dir,'bundle',route==='/'?'home.html':'about.html'),html(route));
    await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'},{route:'/about',file:'about.html'}]}));
    await fn(dir);
  }finally{if(process.env.MOLT_KEEP_TEST_ARTIFACTS==='1')console.log(`Test artifacts: ${dir}`);else await rm(dir,{recursive:true,force:true});}
}
test('real browser captures two imported pages at all three viewports and localizes assets',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'evidence'),signal:AbortSignal.timeout(60000)});
  assert.equal(evidence.pages.length,2);assert.equal(evidence.pages[0].views.length,3);assert.equal(evidence.blockers.length,0);
  assert.ok(evidence.assets.length>0);assert.equal(evidence.pages[0].views[2].viewport.width,390);
  const view=evidence.pages[0].views[0];const metrics=await compare(view.screenshot,view.screenshot,join(dir,'self.diff.png'));
  assert.equal(metrics.score,100);assert.equal(metrics.worstBand,100);
  const images=await referenceImages(evidence.pages[0].views);assert.ok(images.length>=6&&images.length<=9);
  assert.ok(view.geometry.elements.find(e=>e.tag==='h1'&&e.width>0));
  assert.equal(view.interactions?.length,1);assert.equal(view.interactions?.[0].trigger.kind,'details');assert.equal(view.interactions?.[0].trigger.name,'Project notes');
}));
test('full agent builds real React, detects a deliberate mismatch, repairs it and verifies every viewport',{skip:process.env.MOLT_RUN_FULL_AGENT_TESTS!=='1'},()=>fixture(async dir=>{
  let generation=0,repair=0;
  const model:Model={usage:{calls:0,inputTokens:0,outputTokens:0},async complete(request){
    this.usage.calls++;
    const ctx=JSON.parse(request.prompt);const route=ctx.reference.route;
    if(String(ctx.task).startsWith('Repair round')){repair++;return {summary:'Correct heading scale without changing routes',files:[{path:'src/site.css',content:CSS}]};}
    generation++;
    const asset=ctx.assets.find((a:{original:string})=>a.original.endsWith('logo.svg')).path;
    const file=ctx.routeMap.find((p:{route:string})=>p.route===route).file;
    return {summary:'Build fixture page with a deliberately incorrect desktop heading',files:[{path:file,content:`export default function Page(){return <><header><img src="${asset}" alt="Studio mark"/><a href="/">Studio</a><a href="/about">About</a></header><main><h1>${title(route)}</h1><p>${text(route)}</p><a className="accent" href="/about">Explore our work</a><details><summary>Project notes</summary><p>Hidden until opened.</p></details></main><footer>Studio, thoughtfully made.</footer></>}`},{path:'src/site.css',content:CSS.replace('font-size:48px','font-size:24px')}]};
  }};
  const result=await runReconstruction({bundleDir:join(dir,'bundle'),workDir:join(dir,'runs'),model,maxRepairs:2,signal:AbortSignal.timeout(120000)});
  assert.equal(generation,2);assert.equal(repair,1);assert.equal(result.status,'review',JSON.stringify(result.evaluation));
  assert.equal(result.evaluation.views.length,6);assert.ok(result.evaluation.views.every(v=>v.pass&&v.score!==null));
  assert.ok(result.evaluation.views.every(v=>v.interactions?.length===1&&v.interactions[0].pass));
  assert.equal(result.attempts[0].evaluation.pass,false);assert.equal(result.attempts[1].accepted,true);
  assert.ok((await readFile(join(result.outDir,'src/site.css'),'utf8')).includes('font-size:48px'));
  assert.equal(JSON.parse(await readFile(result.reportPath,'utf8')).status,'review');
}));
