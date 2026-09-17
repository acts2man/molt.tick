import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { browser, restrictNetwork, serve } from './runtime.js';
import { assertPublicUrl, inside, publicUrl, routePath, validateViewports } from './policy.js';
import { detectIntegrations } from './integrations.js';
import { VIEWPORTS, type Evidence, type Geometry, type InteractionTrigger, type Viewport } from './types.js';

export interface CaptureOptions {
  url?: string; urls?: string[]; bundleDir?: string; directory: string;
  viewports?: Viewport[]; maxPages?: number; signal: AbortSignal;
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
 const attrs=(el)=>Object.fromEntries(['role','aria-label','aria-expanded','aria-selected','aria-controls','aria-haspopup','type'].map(n=>[n,el.getAttribute(n)]).filter(([,v])=>v!==null));
 const elements=[]; let truncated=false;
 for(const el of nodes){
  const tag=el.tagName.toLowerCase(); if(/^(script|style|noscript|link|meta)$/.test(tag)) continue;
  const b=el.getBoundingClientRect(),s=getComputedStyle(el);
  if(!b.width||!b.height||s.display==='none'||s.visibility==='hidden') continue;
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
 const signatures=[document.documentElement.className,document.body.className,...Array.from(document.querySelectorAll('script[src],link[href]')).map(el=>el.getAttribute('src')||el.getAttribute('href')||''),document.querySelector('meta[name="generator"]')?.getAttribute('content')||''].join(' ');\n const platformHints=[]; for(const [label,re] of [['WordPress',/wordpress|wp-content|wp-includes/i],['Elementor',/elementor/i],['WPBakery',/wpbakery|js_composer|vc_/i],['Divi',/divi|et_pb_/i],['WooCommerce',/woocommerce|wc-/i],['Shopify',/shopify/i],['Wix',/wix/i],['Squarespace',/squarespace/i]])if(re.test(signatures))platformHints.push(label);\n return {text:document.body.innerText,title:document.title,height:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,
 brokenImages:Array.from(document.images).filter(i=>{const b=i.getBoundingClientRect(),s=getComputedStyle(i);return b.width>0&&b.height>0&&b.right>0&&b.left<innerWidth&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&i.naturalWidth===0;}).length,
 elements,links:Array.from(document.querySelectorAll('a[href]')).map(a=>a.href),embeds:Array.from(document.querySelectorAll('iframe')).map(f=>f.src),forms:document.forms.length,fontFaces,mediaQueries:Array.from(new Set(mediaQueries)),platformHints:Array.from(new Set(platformHints)),truncated};
})()`;
export async function geometry(page: Page): Promise<Geometry> {
  return await page.evaluate(GEOMETRY) as Geometry;
}

/** Observe only bounded, reversible interaction states. Links, submit buttons and arbitrary clicks are excluded. */
const INTERACTIONS = `(() => {
 const clean=(s)=>String(s||'').replace(/\\s+/g,' ').trim().slice(0,120);
 const name=(el)=>clean(el.getAttribute('aria-label')||el.textContent);
 const out=[],seen=new Set();
 const push=(kind,el)=>{const n=name(el),controls=el.getAttribute('aria-controls')||undefined,key=kind+'|'+n+'|'+(controls||'');if(!n||seen.has(key))return;seen.add(key);out.push({kind,name:n,controls});};
 for(const d of Array.from(document.querySelectorAll('details:not([open])'))){const s=d.querySelector(':scope > summary');if(s)push('details',s);}
 for(const el of Array.from(document.querySelectorAll('button[aria-expanded="false"],[role="button"][aria-expanded="false"]'))){
   if(el.matches('[type="submit"],[type="reset"]')||el.closest('form')&&el.tagName==='BUTTON'&&(!el.getAttribute('type')||el.getAttribute('type')==='submit'))continue;
   if(el.getAttribute('role')==='tab')continue; push('button',el);
 }
 for(const el of Array.from(document.querySelectorAll('[role="tab"]:not([aria-selected="true"])')))push('tab',el);
 return out.slice(0,3);
})()`;
export async function discoverInteractions(page: Page): Promise<InteractionTrigger[]> {
  return await page.evaluate(INTERACTIONS) as InteractionTrigger[];
}
export async function activateInteraction(page: Page, trigger: InteractionTrigger): Promise<boolean> {
  return await page.evaluate(({kind,name,controls}) => {
    const clean=(s:unknown)=>String(s??'').replace(/\\s+/g,' ').trim().slice(0,120);
    const label=(el:Element)=>clean(el.getAttribute('aria-label')||el.textContent);
    let items:Element[]=[];
    if(kind==='details')items=Array.from(document.querySelectorAll('details:not([open]) > summary'));
    else if(kind==='tab')items=Array.from(document.querySelectorAll('[role="tab"]'));
    else items=Array.from(document.querySelectorAll('button,[role="button"]')).filter(el=>!el.matches('[type="submit"],[type="reset"]'));
    const target=items.find(el=>label(el)===name&&(!controls||el.getAttribute('aria-controls')===controls));
    if(!target)return false;
    (target as HTMLElement).click();
    return true;
  }, trigger);
}
/** Do not erase transforms, reveal hidden menus, or resize the viewport to page height. */
export async function settle(page: Page, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await page.evaluate(`Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,5000))])`);
  let height = await page.evaluate('document.documentElement.scrollHeight') as number;
  if (height > 18000) throw new Error('Page exceeds the 18000px capture budget; split the source into sections');
  for (let y = 0; y < height; y += 650) {
    signal.throwIfAborted();
    await page.evaluate(`scrollTo(0,${y})`);
    await page.waitForTimeout(70);
    height = await page.evaluate('document.documentElement.scrollHeight') as number;
    if (height > 18000) throw new Error('Page grows beyond the capture budget');
  }
  await page.evaluate(`scrollTo(0,0)`);
  await page.waitForTimeout(350);
  await page.evaluate(`(() => { for(const a of document.getAnimations()){try{if(a.effect.getComputedTiming().iterations!==Infinity)a.finish();}catch{}} })()`);
  await page.evaluate(`Promise.race([Promise.all(Array.from(document.images).map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,5000))])`);
}
const EXT: Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/svg+xml':'svg','image/avif':'avif','image/x-icon':'ico','font/woff':'woff','font/woff2':'woff2','font/ttf':'ttf','font/otf':'otf','application/font-woff':'woff','application/x-font-woff':'woff'};
function urlsIn(css: string): string[] { return [...css.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)].map(m=>m[1]); }
function absolutizeCss(css: string, base: string): string {
  return css.replace(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi, (_m,u:string)=>{try{return `url("${new URL(u,base).href}")`;}catch{return 'url("")';}});
}
export async function capture(options: CaptureOptions): Promise<Evidence> {
  if (!!options.url === !!options.bundleDir) throw new Error('Provide exactly one URL or bundle directory');
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
  let local: Awaited<ReturnType<typeof serve>> | undefined;
  let targets: Array<{route:string;url:string}> = [];
  if(options.bundleDir){
    const bundle=await readBundle(options.bundleDir); evidence.site=bundle.site;
    if(bundle.pages.length>maxPages)throw new Error('Bundle has more pages than maxPages; no pages were silently skipped');
    const aliases=Object.fromEntries(bundle.pages.map(p=>[p.route,p.file]));
    local=await serve(resolve(options.bundleDir),aliases,true);
    targets=bundle.pages.map(p=>({route:p.route,url:local!.origin+p.route}));
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
    if(options.url&&!options.urls?.length){
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
    for(const target of targets){
      const item:Evidence['pages'][number]={...target,title:'',views:[]};
      const slug=createHash('sha256').update(target.route).digest('hex').slice(0,12);
      await mkdir(join(options.directory,slug),{recursive:true});
      for(const viewport of views){
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
