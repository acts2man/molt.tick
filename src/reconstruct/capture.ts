import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, posix, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { browser, restrictNetwork, serve } from './runtime.js';
import { assertPublicUrl, inside, publicUrl, routePath, validateViewports } from './policy.js';
import { detectIntegrations } from './integrations.js';
import { VIEWPORTS, type Evidence, type Geometry, type InteractionTrigger, type Viewport } from './types.js';

export interface CaptureOptions {
  url?: string; urls?: string[]; bundleDir?: string; directory: string;
  viewports?: Viewport[]; maxPages?: number; signal: AbortSignal;
  /** Add up to two source-derived breakpoint probes when using the default viewport matrix. */
  adaptiveViewports?: boolean;
  /** Re-load live pages before capture and report unstable source states without fabricating certainty. */
  sourceStability?: boolean;
}
interface Bundle { site: string; pages: Array<{ route: string; file: string }> }
export async function readBundle(root: string): Promise<Bundle> {
  const file = await inside(root, 'bundle.json');
  const raw = await readFile(file, 'utf8');
  if (raw.length > 100000) throw new Error('Bundle manifest is too large');
  const value = JSON.parse(raw) as Bundle;
  if (!value || typeof value.site !== 'string' || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 50) throw new Error('bundle.json must contain site and 1..50 pages');
  const site = publicUrl(value.site).href, routes = new Set<string>();
  for (const p of value.pages) {
    p.route = routePath(p.route);
    if (routes.has(p.route)) throw new Error('Duplicate bundle route');
    routes.add(p.route);
    if (typeof p.file !== 'string' || !/\.html?$/i.test(p.file)) throw new Error('Bundle pages must be HTML files');
    await inside(root, p.file);
  }
  return { site, pages: value.pages };
}
/** Script string avoids transpiler-injected helpers in browser evaluation. */
const GEOMETRY = `(() => {
 const props=['display','position','top','left','right','bottom','z-index','width','height','min-height','max-width','box-sizing','flex-direction','flex-wrap','flex-basis','justify-content','align-items','gap','grid-template-columns','padding','margin','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','color','background','background-image','background-size','background-position','border','border-radius','box-shadow','object-fit','object-position','transform','transform-origin','opacity','overflow','visibility'];
 const nodes=Array.from(document.querySelectorAll('body *')); const index=new Map(nodes.map((n,i)=>[n,String(i)]));
 const read=(s)=>Object.fromEntries(props.map(p=>[p,s.getPropertyValue(p)]).filter(p=>p[1]));
 const attrs=(el)=>Object.fromEntries(['role','aria-label','aria-expanded','aria-selected','aria-controls','aria-haspopup','type','alt','title','target','rel'].map(n=>[n,el.getAttribute(n)]).filter(([,v])=>v!==null));
 const elements=[]; let truncated=false;
 for(const el of nodes){
  const tag=el.tagName.toLowerCase(); if(/^(script|style|noscript|link|meta)$/.test(tag)) continue;
  const b=el.getBoundingClientRect(),s=getComputedStyle(el);
  if(!b.width||!b.height||b.right<=0||b.left>=innerWidth||s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) continue;
  if(elements.length>=1400){truncated=true;break;}
  const e={key:index.get(el),parent:index.get(el.parentElement),tag,text:/^h[1-6]$/.test(tag)?el.innerText:Array.from(el.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim(),x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height,style:read(s),attributes:attrs(el)};
  if(tag==='img') e.src=el.currentSrc||el.src;
  if(tag==='a') e.href=el.href;
  if(tag==='svg') e.svg=el.outerHTML.length<16000?el.outerHTML:undefined;
  for(const side of ['before','after']){const ps=getComputedStyle(el,'::'+side);if(ps.content&&ps.content!=='none'&&ps.content!=='normal')e[side]={...read(ps),content:ps.content};}
  elements.push(e);
 }
 const fontFaces=[],mediaQueries=[];
 const rules=(list)=>{for(const r of Array.from(list||[])){if(r.type===5)fontFaces.push(r.cssText);else if(r.type===4)mediaQueries.push(r.conditionText);if(r.cssRules)rules(r.cssRules);}};
 for(const s of Array.from(document.styleSheets)){try{rules(s.cssRules);}catch{}}
 const signatures=[document.documentElement.className,document.body.className,...Array.from(document.querySelectorAll('script[src],link[href]')).map(el=>el.getAttribute('src')||el.getAttribute('href')||''),document.querySelector('meta[name="generator"]')?.getAttribute('content')||''].join(' ');\n const platformHints=[]; for(const [label,re] of [['WordPress',/wordpress|wp-content|wp-includes/i],['Elementor',/elementor/i],['WPBakery',/wpbakery|js_composer|vc_/i],['Divi',/divi|et_pb_/i],['WooCommerce',/woocommerce|wc-/i],['Shopify',/shopify/i],['Wix',/wix/i],['Squarespace',/squarespace/i]])if(re.test(signatures))platformHints.push(label);\n const visibleText=String(document.body?.innerText||'').replace(/\\s+/g,' ').trim();\n const rootStyle=read(getComputedStyle(document.documentElement)),bodyStyle=read(getComputedStyle(document.body));\n return {text:visibleText,title:document.title,height:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,rootStyle,bodyStyle,
 brokenImages:Array.from(document.images).filter(i=>{const b=i.getBoundingClientRect(),s=getComputedStyle(i);return b.width>0&&b.height>0&&b.right>0&&b.left<innerWidth&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&i.naturalWidth===0;}).length,
 elements,links:Array.from(document.querySelectorAll('a[href]')).map(a=>a.href),embeds:Array.from(document.querySelectorAll('iframe')).map(f=>f.src),forms:document.forms.length,fontFaces,mediaQueries:Array.from(new Set(mediaQueries)),platformHints:Array.from(new Set(platformHints)),truncated};
})()`;
export async function geometry(page: Page): Promise<Geometry> {
  return await page.evaluate(GEOMETRY) as Geometry;
}

const normalizedFingerprintText=(value:string)=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
export function geometryFingerprint(value:Geometry):string{
  const candidates=value.elements.filter(e=>/^(header|nav|main|section|article|footer|h[1-6]|p|img|button|a|form)$/.test(e.tag)||Boolean(e.text)||Boolean(e.src));
  const sampled=candidates.length<=180?candidates:Array.from({length:180},(_,i)=>candidates[Math.round(i*(candidates.length-1)/179)]);
  const landmarks=sampled.map(e=>({
    tag:e.tag,text:normalizedFingerprintText(e.text).slice(0,180),src:e.src??'',
    x:Math.round(e.x),y:Math.round(e.y),width:Math.round(e.width),height:Math.round(e.height)
  }));
  return createHash('sha256').update(JSON.stringify({
    title:value.title,text:normalizedFingerprintText(value.text),height:Math.round(value.height),landmarks
  })).digest('hex');
}

export function adaptiveViewports(mediaQueries:string[],base:Viewport[]):Viewport[]{
  const remaining=Math.max(0,6-base.length);if(!remaining)return [];
  const widths=new Set<number>();
  for(const query of mediaQueries){
    const re=/(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px/gi;let match:RegExpExecArray|null;
    while((match=re.exec(query))){const width=Math.round(Number(match[1]));if(width>=320&&width<=1600)widths.add(width);}
  }
  const existing=base.map(v=>v.width);
  const candidates=[...widths].filter(width=>!existing.some(current=>Math.abs(current-width)<24));
  const distance=(width:number)=>Math.min(...existing.map(current=>Math.abs(current-width)));
  const ranked=candidates.sort((a,b)=>distance(b)-distance(a)||a-b);
  const mobile=ranked.find(width=>width<=600),larger=ranked.find(width=>width>600);
  const selected=mobile!==undefined&&larger!==undefined?[larger,mobile]:ranked.slice(0,2);
  return [...new Set(selected)].slice(0,Math.min(2,remaining)).sort((a,b)=>b-a).map(width=>({
    name:`probe-${width}`,width,height:width<=600?932:width<=900?1024:900
  }));
}

/** Observe only bounded, reversible interaction states. Links, submit buttons and arbitrary clicks are excluded. */
const INTERACTIONS = `(() => {
 const clean=(s)=>String(s||'').replace(/\\s+/g,' ').trim().slice(0,120);
 const name=(el)=>clean(el.getAttribute('aria-label')||el.getAttribute('title')||(el.classList?.contains('swiper-button-next')?'Next slide':el.classList?.contains('swiper-button-prev')?'Previous slide':'')||el.textContent);
 const seenElements=new Set(),counts=new Map();
 const groups={priority:[],carousel:[],tabs:[],other:[],details:[]};
 const push=(group,kind,el)=>{
   if(seenElements.has(el))return;
   const n=name(el),controls=el.getAttribute('aria-controls')||undefined,key=kind+'|'+n+'|'+(controls||'');
   if(!n)return;
   const ordinal=counts.get(key)||0;counts.set(key,ordinal+1);seenElements.add(el);
   groups[group].push({kind,name:n,controls,ordinal});
 };
 for(const el of Array.from(document.querySelectorAll('button[aria-expanded="false"],[role="button"][aria-expanded="false"]'))){
   if(el.matches('[type="submit"],[type="reset"]')||el.closest('form')&&el.tagName==='BUTTON'&&(!el.getAttribute('type')||el.getAttribute('type')==='submit'))continue;
   if(el.getAttribute('role')==='tab')continue;
   const n=name(el),important=/menu|navigation|nav|drawer|toggle/i.test(n+' '+(el.getAttribute('aria-controls')||''))||el.getAttribute('aria-haspopup');
   push(important?'priority':'other','button',el);
 }
 // Explicit Previous/Next carousel controls get reserved evidence slots so accordions cannot starve them.
 const carousel=/^(?:previous|prev|next)(?:\\s+(?:slide|testimonial|review|item|image|photo|project))?\\b/i;
 for(const el of Array.from(document.querySelectorAll('button,[role="button"]'))){
   const n=name(el);if(!carousel.test(n))continue;
   if(el.matches('[type="submit"],[type="reset"]')||el.closest('form')&&el.tagName==='BUTTON'&&(!el.getAttribute('type')||el.getAttribute('type')==='submit'))continue;
   push('carousel','button',el);
 }
 for(const el of Array.from(document.querySelectorAll('[role="tab"]:not([aria-selected="true"])')))push('tabs','tab',el);
 for(const d of Array.from(document.querySelectorAll('details:not([open])'))){const summary=d.querySelector(':scope > summary');if(summary)push('details','details',summary);}
 return [...groups.priority.slice(0,2),...groups.carousel.slice(0,2),...groups.tabs.slice(0,2),...groups.other.slice(0,1),...groups.details.slice(0,1)].slice(0,8);
})()`;
export async function discoverInteractions(page: Page): Promise<InteractionTrigger[]> {
  return await page.evaluate(INTERACTIONS) as InteractionTrigger[];
}
export async function activateInteraction(page: Page, trigger: InteractionTrigger): Promise<boolean> {
  const payload=JSON.stringify(trigger).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  const script=`(() => {
    const trigger=${payload};
    const clean=(s)=>String(s==null?'':s).replace(/\\s+/g,' ').trim().slice(0,120);
    const label=(el)=>clean(el.getAttribute('aria-label')||el.getAttribute('title')||(el.classList?.contains('swiper-button-next')?'Next slide':el.classList?.contains('swiper-button-prev')?'Previous slide':'')||el.textContent);
    let items=[];
    if(trigger.kind==='details')items=Array.from(document.querySelectorAll('details:not([open]) > summary'));
    else if(trigger.kind==='tab')items=Array.from(document.querySelectorAll('[role="tab"]'));
    else items=Array.from(document.querySelectorAll('button,[role="button"]')).filter(el=>!el.matches('[type="submit"],[type="reset"]'));
    const matches=items.filter(el=>label(el)===trigger.name&&(!trigger.controls||el.getAttribute('aria-controls')===trigger.controls));
    const target=matches[Math.max(0,Number(trigger.ordinal)||0)];
    if(!target)return false;
    target.click();
    return true;
  })()`;
  return await page.evaluate(script) as boolean;
}
/** Do not erase transforms, reveal hidden menus, or resize the viewport to page height. */
export async function settle(page: Page, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const maxHeight=Number(process.env.MOLT_MAX_CAPTURE_HEIGHT??26000);
  if(!Number.isInteger(maxHeight)||maxHeight<12000||maxHeight>27000)throw new Error('MOLT_MAX_CAPTURE_HEIGHT must be an integer from 12000 to 27000');
  await page.evaluate(`Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,5000))])`);
  let height = await page.evaluate('document.documentElement.scrollHeight') as number;
  if (height > maxHeight) throw new Error(`Page height ${height}px exceeds the safe ${maxHeight}px capture budget; capture the page as smaller saved-page routes or reduce infinite/lazy content`);
  for (let y = 0; y < height; y += 650) {
    signal.throwIfAborted();
    await page.evaluate(`scrollTo(0,${y})`);
    await page.waitForTimeout(70);
    height = await page.evaluate('document.documentElement.scrollHeight') as number;
    if (height > maxHeight) throw new Error(`Page grew beyond the safe ${maxHeight}px capture budget while lazy content loaded`);
  }
  await page.evaluate(`scrollTo(0,0)`);
  await page.waitForTimeout(350);
  await page.evaluate(`(() => { for(const a of document.getAnimations()){try{if(a.effect.getComputedTiming().iterations!==Infinity)a.finish();}catch{}} })()`);
  await page.evaluate(`Promise.race([Promise.all(Array.from(document.images).map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,5000))])`);
}
const EXT: Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/svg+xml':'svg','image/avif':'avif','image/x-icon':'ico','font/woff':'woff','font/woff2':'woff2','font/ttf':'ttf','font/otf':'otf','application/font-woff':'woff','application/x-font-woff':'woff'};
const SAVED_MIME:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};

function urlsIn(css: string): string[] { return [...css.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)].map(m=>m[1]); }
function absolutizeCss(css: string, base: string): string {
  return css.replace(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi, (_m,u:string)=>{try{return `url("${new URL(u,base).href}")`;}catch{return 'url("")';}});
}
export async function capture(options: CaptureOptions): Promise<Evidence> {
  if (!options.url&&!options.bundleDir) throw new Error('Provide a URL, a saved-page bundle, or both');
  const views = options.viewports ?? [...VIEWPORTS]; validateViewports(views);
  const maxPages = options.maxPages ?? 12;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new Error('maxPages must be 1..50');
  await mkdir(join(options.directory,'assets'),{recursive:true});
  const evidence: Evidence = { site:'',directory:options.directory,pages:[],assets:[],fontFaces:[],warnings:[],blockers:[],integrations:[] };
  const assetMap = new Map<string,Evidence['assets'][number]>(), faces = new Set<string>();
  let totalBytes=0;
  const save = async (url:string,body:Buffer,mime:string) => {
    if(assetMap.has(url))return;
    const ext = EXT[mime.split(';')[0]] ?? (/\.(woff2?|ttf|otf)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase());
    if(!ext)return;
    if(body.length>12_000_000||totalBytes+body.length>100_000_000||assetMap.size>=600)throw new Error('Asset budget exceeded');
    totalBytes+=body.length;
    const publicPath=`/assets/${createHash('sha256').update(body).digest('hex').slice(0,24)}.${ext}`;
    const file=join(options.directory,publicPath);
    const item={original:url,file,publicPath}; assetMap.set(url,item);
    await writeFile(file,body);
  };
  const importSavedResources=async(root:string)=>{
    let manifestFile:string;
    try{manifestFile=await inside(root,'manifest.json');}catch{return;}
    const raw=await readFile(manifestFile,'utf8');if(raw.length>1_000_000)throw new Error('Saved-page manifest is too large');
    let parsed:any;try{parsed=JSON.parse(raw);}catch{throw new Error('Saved-page manifest.json is invalid JSON');}
    const resources=parsed?.resources;if(!resources||typeof resources!=='object'||Array.isArray(resources))return;
    const entries=Object.entries(resources).filter(([path,url])=>typeof path==='string'&&typeof url==='string').slice(0,600) as Array<[string,string]>;
    const resourceMap=new Map(entries);
    for(const [path,original] of entries){
      let file:string;try{file=await inside(root,path);}catch{continue;}
      const extension=extname(path).toLowerCase(),mime=SAVED_MIME[extension];
      if(mime){
        const body=await readFile(file);await save(original,body,mime);continue;
      }
      if(extension!=='.css')continue;
      const css=await readFile(file,'utf8');
      if(css.length>2_000_000)continue;
      const base=posix.dirname(path);
      const rewritten=css.replace(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi,(_m,u:string)=>{
        if(/^data:/i.test(u))return `url("${u}")`;
        if(/^https?:\/\//i.test(u))return `url("${u}")`;
        const local=posix.normalize(posix.join(base,u)).replace(/^\.\//,'');
        const mapped=resourceMap.get(local);
        if(mapped)return `url("${mapped}")`;
        try{return `url("${new URL(u,original).href}")`;}catch{return 'url("")';}
      });
      for(const face of rewritten.match(/@font-face\s*\{[^}]*\}/gi)??[])faces.add(face);
    }
  };
  let local: Awaited<ReturnType<typeof serve>> | undefined;
  let targets: Array<{route:string;url:string}> = [];
  if(options.bundleDir){
    const bundle=await readBundle(options.bundleDir);
    if(bundle.pages.length>maxPages)throw new Error('Bundle has more pages than maxPages; no pages were silently skipped');
    if(options.url){
      const live=publicUrl(options.url);await assertPublicUrl(live.href);
      if(live.origin!==new URL(bundle.site).origin)throw new Error('Saved-page bundle and live URL must belong to the same website origin');
      evidence.site=live.origin;
      const requested=options.urls?.length?options.urls.map(value=>new URL(value,live)):bundle.pages.map(p=>new URL(p.route,live.origin));
      for(const page of requested)if(page.origin!==live.origin||page.search)throw new Error('Hybrid page URLs must be same-origin and cannot contain query parameters');
      targets=requested.map(page=>({route:routePath(page.pathname),url:page.href}));
      await importSavedResources(options.bundleDir);
      const savedRoutes=new Set(bundle.pages.map(p=>p.route)),supplemented=targets.filter(target=>savedRoutes.has(target.route)).length;
      evidence.warnings.push('Hybrid evidence enabled: live rendering is the visual/interaction authority while saved files supplement exact local assets and font data.');
      if(supplemented<targets.length)evidence.warnings.push(`Saved HTML/CSS supplements ${supplemented} of ${targets.length} selected routes; the remaining routes use live browser evidence without silently shrinking the requested page scope.`);
    }else{
      evidence.site=bundle.site;
      const aliases=Object.fromEntries(bundle.pages.map(p=>[p.route,p.file]));
      local=await serve(resolve(options.bundleDir),aliases,true);
      targets=bundle.pages.map(p=>({route:p.route,url:local!.origin+p.route}));
    }
  }else{
    const u=publicUrl(options.url!); await assertPublicUrl(u.href); evidence.site=u.origin;
    const requested=options.urls?.length?options.urls.map(v=>new URL(v,u)): [u];
    for(const v of requested){if(v.origin!==u.origin||v.search)throw new Error('Page URLs must be same-origin and cannot contain query parameters');}
    targets=requested.map(v=>({route:routePath(v.pathname),url:v.href}));
  }
  let engine: Awaited<ReturnType<typeof browser>> | undefined;
  const stop=()=>{void engine?.close();};
  options.signal.addEventListener('abort',stop,{once:true});
  try{
    options.signal.throwIfAborted(); engine=await browser();
    if(options.url&&!options.urls?.length&&!options.bundleDir){
      const ctx=await engine.newContext({viewport:views[0],serviceWorkers:'block',acceptDownloads:false});
      try{
        await restrictNetwork(ctx);const page=await ctx.newPage();
        const resp=await page.goto(targets[0].url,{waitUntil:'load',timeout:30000});
        if(!resp?.ok())throw new Error(`Source returned HTTP ${resp?.status()}`);
        const found=await page.evaluate(`Array.from(document.querySelectorAll('nav a[href],header a[href]')).map(a=>a.href)`) as string[];
        const known=new Set(targets.map(t=>t.route));
        for(const value of found){try{const u=new URL(value);if(u.origin!==new URL(evidence.site).origin||u.search||/\.(pdf|png|jpg|zip|mp4)$/i.test(u.pathname))continue;const route=routePath(u.pathname);if(!known.has(route)){targets.push({route,url:u.origin+route});known.add(route);}}catch{}}
        if(targets.length>maxPages){evidence.warnings.push(`Discovery found ${targets.length} routes; only the first ${maxPages} were selected.`);targets=targets.slice(0,maxPages);}
      }finally{await ctx.close();}
    }
    if(targets.length>maxPages||new Set(targets.map(t=>t.route)).size!==targets.length)throw new Error('Too many or duplicate requested routes');
    const stabilityEnabled=(options.sourceStability??true)&&Boolean(options.url)&&!local;
    const adaptiveEnabled=(options.adaptiveViewports??Boolean(options.url))&&options.viewports===undefined;
    const stabilityFingerprints=new Map<string,string>();
    for(const target of targets){
      if(stabilityEnabled){
        const ctx=await engine.newContext({viewport:views[0],deviceScaleFactor:1,colorScheme:'light',locale:'en-US',serviceWorkers:'block',acceptDownloads:false});
        try{
          await restrictNetwork(ctx);const page=await ctx.newPage();const samples:string[]=[];
          for(let attempt=0;attempt<3;attempt++){
            options.signal.throwIfAborted();
            const response=await page.goto(target.url,{waitUntil:'load',timeout:30000});if(!response?.ok())throw new Error(`HTTP ${response?.status()}`);
            await settle(page,options.signal);samples.push(geometryFingerprint(await geometry(page)));
            if(samples.length>=2&&samples.at(-1)===samples.at(-2))break;
          }
          const finalFingerprint=samples.at(-1);if(finalFingerprint)stabilityFingerprints.set(target.route,finalFingerprint);
          if(samples.length>=2&&samples.at(-1)!==samples.at(-2))evidence.warnings.push(`${target.route}: live source changed across repeated captures; rotating/A-B/geolocation/time-based content may make pixel scoring non-deterministic.`);
          else if(samples.length>2)evidence.warnings.push(`${target.route}: live source changed once, then stabilized on retry; Molt will compare the actual desktop capture against that stabilized fingerprint.`);
        }catch(error){evidence.warnings.push(`${target.route}: source-stability probe could not complete (${(error as Error).message}); normal capture will still validate the route.`);}
        finally{await ctx.close().catch(()=>{});}
      }
      const item:Evidence['pages'][number]={...target,title:'',views:[]};
      const slug=createHash('sha256').update(target.route).digest('hex').slice(0,12);
      await mkdir(join(options.directory,slug),{recursive:true});
      const pageViewports=[...views];
      for(let viewIndex=0;viewIndex<pageViewports.length;viewIndex++){
        const viewport=pageViewports[viewIndex];
        options.signal.throwIfAborted();
        const ctx=await engine.newContext({viewport,deviceScaleFactor:1,colorScheme:'light',locale:'en-US',serviceWorkers:'block',acceptDownloads:false});
        const pending:Promise<void>[]=[];const assetErrors:string[]=[];
        try{
          await restrictNetwork(ctx,local?.origin,!!local);
          const page=await ctx.newPage();
          page.on('response',res=>{
            const type=res.request().resourceType();if(!['image','font','stylesheet'].includes(type)||!res.ok())return;
            pending.push((async()=>{const body=await res.body();const mime=res.headers()['content-type']??'';
              if(type==='stylesheet'){for(const face of body.toString('utf8').match(/@font-face\s*\{[^}]*\}/gi)??[])faces.add(absolutizeCss(face,res.url()));}
              else await save(res.url(),body,mime);
            })().catch(e=>{assetErrors.push((e as Error).message);}));
          });
          const response=await page.goto(target.url,{waitUntil:'load',timeout:30000});
          if(!response?.ok())throw new Error(`${target.route}: HTTP ${response?.status()}`);
          await settle(page,options.signal);
          const screenshot=join(options.directory,slug,`${viewport.name}.png`);
          await page.screenshot({path:screenshot,fullPage:true,animations:'disabled',scale:'css',timeout:15000});
          const g=await geometry(page);
          if(stabilityEnabled&&viewIndex===0){
            const expected=stabilityFingerprints.get(target.route),actual=geometryFingerprint(g);
            if(expected&&expected!==actual)evidence.warnings.push(`${target.route}: the actual desktop evidence changed again after the stability probe; visual scoring for this route may reflect rotating source content rather than reconstruction error.`);
          }
          if(adaptiveEnabled&&viewIndex===0){
            const probes=adaptiveViewports(g.mediaQueries,pageViewports);
            if(probes.length){pageViewports.push(...probes);validateViewports(pageViewports);evidence.warnings.push(`${target.route}: added source-derived breakpoint verification at ${probes.map(v=>v.width+'px').join(', ')}.`);}
          }
          if(!g.text.trim()&&!g.elements.some(e=>e.src||e.svg))throw new Error('Source page is empty');
          if(g.text.length>120000)throw new Error('Page text exceeds reconstruction context budget');
          for(const face of g.fontFaces)faces.add(absolutizeCss(face,target.url));
          for(const e of g.elements){
            const urls=[...(e.src?[e.src]:[]),...urlsIn(e.style['background-image']??'')];
            for(const url of urls){if(!url.startsWith('data:'))continue;const m=/^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);if(m)await save(url,Buffer.from(m[2]?m[3]:decodeURIComponent(m[3]),m[2]?'base64':'utf8'),m[1]);}
          }
          if(g.truncated)evidence.warnings.push(`${target.route} ${viewport.name}: geometry limited to 1400 elements; full screenshot and text retained.`);
          if(g.brokenImages)evidence.blockers.push(`${target.route} ${viewport.name}: ${g.brokenImages} source images did not load.`);
          if(g.embeds.length)evidence.blockers.push(`${target.route}: embedded media requires an approved integration (${g.embeds.join(', ')}).`);
          if(g.forms)evidence.blockers.push(`${target.route}: form submission needs a backend integration; acknowledging this does not implement it.`);
          const interactions:NonNullable<Evidence['pages'][number]['views'][number]['interactions']>=[];
          const triggers=await discoverInteractions(page);
          for(let index=0;index<triggers.length;index++){
            options.signal.throwIfAborted();
            const trigger=triggers[index],id=`${trigger.kind}-${createHash('sha256').update(JSON.stringify(trigger)).digest('hex').slice(0,8)}`;
            if(!await activateInteraction(page,trigger)){evidence.warnings.push(`${target.route} ${viewport.name}: could not replay source interaction "${trigger.name}".`);continue;}
            await page.waitForTimeout(250);
            await page.evaluate(`(() => { for(const a of document.getAnimations()){try{if(a.effect.getComputedTiming().iterations!==Infinity)a.finish();}catch{}} })()`);
            const stateScreenshot=join(options.directory,slug,`${viewport.name}-${id}.png`);
            await page.screenshot({path:stateScreenshot,fullPage:true,animations:'disabled',scale:'css',timeout:15000});
            const stateGeometry=await geometry(page);
            interactions.push({id,trigger,screenshot:stateScreenshot,geometry:stateGeometry});
            await writeFile(join(options.directory,slug,`${viewport.name}-${id}.json`),JSON.stringify(stateGeometry,null,2));
            if(index<triggers.length-1){
              const reset=await page.goto(target.url,{waitUntil:'load',timeout:30000});
              if(!reset?.ok()){evidence.warnings.push(`${target.route} ${viewport.name}: interaction-state reset returned HTTP ${reset?.status()}.`);break;}
              await settle(page,options.signal);
            }
          }
          item.title=g.title;item.views.push({viewport,screenshot,geometry:g,interactions});
          await writeFile(join(options.directory,slug,`${viewport.name}.json`),JSON.stringify({...g,interactions:interactions.map(i=>({id:i.id,trigger:i.trigger,screenshot:i.screenshot}))},null,2));
          await Promise.all(pending);
          if(assetErrors.length)evidence.blockers.push(`${target.route}: asset capture errors: ${assetErrors.slice(0,3).join('; ')}`);
        }finally{await ctx.close();}
      }
      evidence.pages.push(item);
    }
    evidence.assets=[...assetMap.values()];
    for(const face of faces){
      let resolved=face;
      for(const url of urlsIn(face)){const a=assetMap.get(url);if(a)resolved=resolved.split(url).join(a.publicPath);}
      if(urlsIn(resolved).some(u=>!u.startsWith('/assets/'))){evidence.warnings.push('A source font could not be localized; fallback may differ.');continue;}
      evidence.fontFaces.push(resolved);
    }
    evidence.warnings=[...new Set(evidence.warnings)];evidence.blockers=[...new Set(evidence.blockers)];evidence.integrations=detectIntegrations(evidence);
    await writeFile(join(options.directory,'evidence.json'),JSON.stringify(evidence,null,2));
    return evidence;
  }finally{options.signal.removeEventListener('abort',stop);await engine?.close().catch(()=>{});await local?.close();}
}
