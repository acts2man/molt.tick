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
test('capture observes entrance, sticky and library motion before freezing the page',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const page='<!doctype html><html><head><style>body{margin:0;height:2600px}.hero{height:900px}.rise{animation:rise 1.2s linear both}.sticky{position:sticky;top:0;height:60px;background:#222;color:white}@keyframes rise{from{opacity:0;transform:translateY(80px)}to{opacity:1;transform:translateY(0)}}</style></head><body><div class="rev_slider"><section class="hero"><h1 class="rise">Animated heading</h1></section></div><div class="sticky">Sticky bar</div><main style="height:1600px">Long content</main></body></html>';
  await writeFile(join(dir,'bundle/home.html'),page);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'motion-evidence'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const motion=evidence.pages[0].views[0].motion;
  assert.ok(motion);
  assert.ok(motion!.libraries.includes('Slider Revolution'),motion!.libraries.join(', '));
  assert.ok(motion!.animations.some(animation=>animation.properties.includes('opacity')||animation.properties.includes('transform')),JSON.stringify(motion!.animations));
  assert.equal(motion!.hasEntranceMotion,true,JSON.stringify(motion));
  assert.equal(motion!.hasStickyOrFixedMotion,true,JSON.stringify(motion));
  assert.ok(motion!.frames.length>=3);
}));
test('capture preserves real reading order across inline emphasis',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const page='<!doctype html><html><body><p>Call <strong>today</strong> for a <em>free estimate</em>.</p></body></html>';
  await writeFile(join(dir,'bundle/home.html'),page);await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'text-order'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  assert.equal(evidence.pages[0].views[0].geometry.text,'Call today for a free estimate.');
}));
test('capture records hover-only desktop navigation and ignores hidden controls',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const page='<!doctype html><html><head><style>nav ul{list-style:none;margin:0;padding:0}.submenu{display:none}.menu-item-has-children:hover>.submenu{display:block}</style></head><body><button style="display:none" aria-expanded="false">Hidden menu</button><nav><ul><li class="menu-item-has-children"><a href="/services">Services</a><ul class="submenu"><li>Tree Removal</li><li>Stump Grinding</li></ul></li></ul></nav><main><h1>Home</h1></main></body></html>';
  await writeFile(join(dir,'bundle/home.html'),page);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'hover-menu'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const states=evidence.pages[0].views[0].interactions??[],hover=states.find(state=>state.trigger.kind==='hover'&&state.trigger.name==='Services');
  assert.ok(hover,states.map(state=>`${state.trigger.kind}:${state.trigger.name}`).join(', '));
  assert.match(hover.geometry.text,/Tree Removal/);assert.match(hover.geometry.text,/Stump Grinding/);
  assert.equal(states.some(state=>state.trigger.name==='Hidden menu'),false);
}));
test('capture observes icon-only aria menu toggles even without aria-expanded',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const page='<!doctype html><html><body><h1>Menu fixture</h1><button aria-haspopup="menu" aria-controls="mobile-menu"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 2h10M0 5h10M0 8h10"/></svg></button><nav id="mobile-menu" hidden><p>Menu panel opened</p></nav><script>document.querySelector("button").addEventListener("click",()=>document.getElementById("mobile-menu").hidden=false)</script></body></html>';
  await writeFile(join(dir,'bundle/home.html'),page);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'aria-menu'),viewports:[{name:'mobile',width:390,height:844}],signal:AbortSignal.timeout(60000)});
  const states=evidence.pages[0].views[0].interactions??[];
  const menu=states.find(state=>state.trigger.name==='mobile-menu');
  assert.ok(menu,states.map(state=>state.trigger.name).join(', '));
  assert.match(menu.geometry.text,/Menu panel opened/);
}));
test('capture records visible form field text state and geometry',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const page='<!doctype html><html><body><h1>Contact us</h1><form><input placeholder="Email address"><select><option>Choose a service</option><option selected>Tree removal</option></select><input type="checkbox" checked><textarea placeholder="Tell us about the project"></textarea></form></body></html>';
  await writeFile(join(dir,'bundle/home.html'),page);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'form-evidence'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const elements=evidence.pages[0].views[0].geometry.elements;
  const email=elements.find(e=>e.tag==='input'&&e.attributes?.placeholder==='Email address');
  const select=elements.find(e=>e.tag==='select');
  const checkbox=elements.find(e=>e.tag==='input'&&e.attributes?.type==='checkbox');
  const textarea=elements.find(e=>e.tag==='textarea');
  assert.ok(email&&email.width>0&&email.height>0);assert.equal(email.attributes?.disabled,'false');assert.equal(email.attributes?.readonly,'false');
  assert.equal(select?.attributes?.['selected-text'],'Tree removal');assert.equal(select?.attributes?.disabled,'false');
  assert.equal(checkbox?.attributes?.checked,'true');
  assert.equal(textarea?.attributes?.placeholder,'Tell us about the project');assert.equal(textarea?.attributes?.readonly,'false');
}));
test('capture inventories hidden carousel slides with exact text and image order',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  for(const name of ['a','b','c','d'])await writeFile(join(dir,'bundle',name+'.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text x="2" y="20">${name}</text></svg>`);
  const slides=['a','b','c','d'].map((name,index)=>`<article class="swiper-slide" style="${index?'display:none':''}"><img src="${name}.svg"><h3>Review ${index+1}</h3><p>Person ${name.toUpperCase()}</p></article>`).join('');
  const page=`<!doctype html><html><body><h1>Reviews</h1><section class="swiper" aria-label="Customer reviews">${slides}<button class="swiper-button-next"></button></section></body></html>`;
  await writeFile(join(dir,'bundle/home.html'),page);await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'carousel-inventory'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const carousel=evidence.pages[0].views[0].geometry.carousels?.find(item=>item.label==='Customer reviews');
  assert.ok(carousel,JSON.stringify(evidence.pages[0].views[0].geometry.carousels));assert.equal(carousel.slides.length,4);
  assert.deepEqual(carousel.slides.map(slide=>slide.text),['Review 1 Person A','Review 2 Person B','Review 3 Person C','Review 4 Person D']);
  assert.ok(carousel.slides.every(slide=>slide.images.length===1));
}));
test('carousel evidence keeps reserved slots even when many disclosures appear first',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const details=Array.from({length:7},(_,i)=>`<details><summary>Question ${i}</summary><p>Answer</p></details>`).join('');
  const page=`<!doctype html><html><body>${details}<button class="swiper-button-next"></button></body></html>`;
  await writeFile(join(dir,'bundle/home.html'),page);await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'interaction-priority'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const names=(evidence.pages[0].views[0].interactions??[]).map(i=>i.trigger.name);
  assert.ok(names.includes('Next slide'),names.join(', '));assert.ok(names.length<=8);
}));
test('capture replays duplicate icon-only carousel controls by occurrence',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const carousel='<!doctype html><html><head><meta charset="utf-8"><title>Carousel</title><style>button{display:block;width:44px;height:44px;margin:20px}</style></head><body><h1>Carousel controls</h1><button class="swiper-button-next"></button><button class="swiper-button-next"></button></body></html>';
  await writeFile(join(dir,'bundle/home.html'),carousel);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'carousel-evidence'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const interactions=evidence.pages[0].views[0].interactions??[];
  assert.equal(interactions.length,2);assert.deepEqual(interactions.map(i=>[i.trigger.name,i.trigger.ordinal]),[['Next slide',0],['Next slide',1]]);
}));
test('dense long-page geometry sampling retains lower-page and footer evidence',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const paragraphs=Array.from({length:1700},(_,i)=>`<p>Row ${i}</p>`).join('');
  const page=`<!doctype html><html><head><style>body{margin:0}p{margin:0;height:10px;line-height:10px;font-size:8px}footer{height:24px}</style></head><body><main>${paragraphs}</main><footer>End marker</footer></body></html>`;
  await writeFile(join(dir,'bundle/home.html'),page);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'dense-long'),viewports:[{name:'desktop',width:1440,height:900}],signal:AbortSignal.timeout(60000)});
  const geometry=evidence.pages[0].views[0].geometry;
  assert.equal(geometry.truncated,true);
  assert.ok(geometry.elements.some(e=>e.tag==='footer'&&/End marker/.test(e.text)),`footer missing from ${geometry.elements.length} sampled elements`);
  assert.ok(geometry.elements.some(e=>e.tag==='p'&&e.y>14000),`lower-page paragraphs missing from sampled geometry`);
}));
test('capture accepts a long landing page beyond the former 18000px ceiling within the bounded pixel budget',{skip:process.env.MOLT_RUN_BROWSER_TESTS!=='1'},()=>fixture(async dir=>{
  const longHtml='<!doctype html><html><head><meta charset="utf-8"><title>Long page</title></head><body style="margin:0"><main style="height:19500px;padding:32px"><h1>Long-form landing page</h1><p>Bottom content remains part of the same page.</p></main></body></html>';
  await writeFile(join(dir,'bundle/home.html'),longHtml);
  await writeFile(join(dir,'bundle/bundle.json'),JSON.stringify({site:'https://fixture.example',pages:[{route:'/',file:'home.html'}]}));
  const evidence=await capture({bundleDir:join(dir,'bundle'),directory:join(dir,'long-evidence'),viewports:[{name:'mobile',width:390,height:844}],signal:AbortSignal.timeout(60000)});
  assert.equal(evidence.pages.length,1);assert.equal(evidence.pages[0].views.length,1);
  assert.ok(evidence.pages[0].views[0].geometry.height>18000);
  const bytes=(await readFile(evidence.pages[0].views[0].screenshot)).length;assert.ok(bytes>0);
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
    const page={path:file,content:`export default function Page(){return <><header><img src="${asset}" alt="Studio mark"/><a href="/">Studio</a><a href="/about">About</a></header><main><h1>${title(route)}</h1><p>${text(route)}</p><a className="accent" href="/about">Explore our work</a><details><summary>Project notes</summary><p>Hidden until opened.</p></details></main><footer>Studio, thoughtfully made.</footer></>}`};
    return {summary:'Build fixture page with a deliberately incorrect desktop heading',files:route==='/'?[page,{path:'src/site.css',content:CSS.replace('font-size:48px','font-size:24px')}]:[page]};
  }};
  const result=await runReconstruction({bundleDir:join(dir,'bundle'),workDir:join(dir,'runs'),model,maxRepairs:2,signal:AbortSignal.timeout(120000)});
  assert.equal(generation,2);assert.equal(repair,1);assert.equal(result.status,'review',JSON.stringify(result.evaluation));
  assert.equal(result.evaluation.views.length,6);assert.ok(result.evaluation.views.every(v=>v.pass&&v.score!==null));
  assert.ok(result.evaluation.views.every(v=>v.interactions?.length===1&&v.interactions[0].pass));
  assert.equal(result.attempts[0].evaluation.pass,false);assert.equal(result.attempts[1].accepted,true);
  assert.ok((await readFile(join(result.outDir,'src/site.css'),'utf8')).includes('font-size:48px'));
  const lock=JSON.parse(await readFile(join(result.outDir,'package-lock.json'),'utf8'));assert.equal(lock.name,'molt-reconstruction');assert.equal(lock.packages[''].dependencies.react,'18.3.1');
  assert.equal(JSON.parse(await readFile(result.reportPath,'utf8')).status,'review');
}));
