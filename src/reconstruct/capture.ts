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
export interface DiscoveredLink { href:string; region:'nav'|'header'|'main'|'footer'|'sitemap'; index:number }
export function skippableDiscoveredCaptureError(error:unknown):boolean{
  const message=error instanceof Error?error.message:String(error);
  return /page\.goto:|net::ERR_|\bHTTP \d{3}\b|Source page is empty|Page text exceeds reconstruction context budget/i.test(message);
}
export function prioritizeDiscoveredLinks(links:DiscoveredLink[]):string[]{
  const bucket=(item:DiscoveredLink)=>{
    let pathname='';try{pathname=new URL(item.href).pathname.toLowerCase();}catch{}
    const core=/(?:^|[-/])(contact|about|(?:our)?services?|pricing|faq|team|staff|locations?|gallery|portfolio|projects?|testimonials?|reviews?)(?:[-_]?\d+)?(?:[-/]|$)/i.test(pathname);
    const lowValue=/(?:^|[-/])(blog|news|privacy|terms|cookie|category|tag|author)(?:[-/]|$)/i.test(pathname);
    if(core)return 0;
    if(item.region==='nav'||item.region==='header')return 1;
    if(lowValue)return 4;
    return item.region==='main'?2:3;
  };
  const seen=new Set<string>(),out:string[]=[];
  for(const item of [...links].sort((a,b)=>bucket(a)-bucket(b)||a.index-b.index)){
    if(seen.has(item.href))continue;seen.add(item.href);out.push(item.href);
  }
  return out;
}
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
 const props=['display','position','top','left','right','bottom','z-index','width','height','min-height','max-width','box-sizing','flex-direction','flex-wrap','flex-basis','justify-content','align-items','gap','grid-template-columns','padding','margin','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','color','background','background-image','background-size','background-position','border','border-radius','box-shadow','object-fit','object-position','transform','transform-origin','opacity','overflow','visibility','appearance','accent-color','filter','backdrop-filter','clip-path','text-shadow','white-space','word-break','aspect-ratio'];
 const allNodes=Array.from(document.querySelectorAll('body *')); const index=new Map(allNodes.map((n,i)=>[n,String(i)]));
 const read=(s)=>Object.fromEntries(props.map(p=>[p,s.getPropertyValue(p)]).filter(p=>p[1]));
 const attrs=(el)=>{
  const out=Object.fromEntries(['role','aria-label','aria-expanded','aria-selected','aria-controls','aria-haspopup','type','alt','title','target','rel','placeholder'].map(n=>[n,el.getAttribute(n)]).filter(([,v])=>v!==null));
  if(/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName))out.disabled=String(Boolean(el.disabled));
  if(/^(INPUT|TEXTAREA)$/.test(el.tagName))out.readonly=String(Boolean(el.readOnly));
  if(el.tagName==='INPUT'&&/^(checkbox|radio)$/i.test(el.type))out.checked=String(Boolean(el.checked));
  if(el.tagName==='SELECT')out['selected-text']=String(el.selectedOptions?.[0]?.textContent||'').replace(/\s+/g,' ').trim().slice(0,160);
  return out;
 };
 const candidates=allNodes.filter(el=>{const tag=el.tagName.toLowerCase();if(/^(script|style|noscript|link|meta)$/.test(tag))return false;const b=el.getBoundingClientRect();return !!b.width&&!!b.height&&b.right>0&&b.left<innerWidth;});
 let nodes=candidates,truncated=candidates.length>1400;
 const evenly=(items,limit)=>items.length<=limit?items:Array.from({length:limit},(_,i)=>items[Math.round(i*(items.length-1)/(limit-1))]);
 if(truncated){
  const priority=candidates.filter(el=>/^(header|nav|main|section|article|footer|h[1-6]|p|li|img|button|form|input|select|textarea)$/.test(el.tagName.toLowerCase()));
  const selected=[],seen=new Set();
  for(const el of [...evenly(priority,700),...evenly(candidates,1400)]){if(seen.has(el))continue;seen.add(el);selected.push(el);if(selected.length>=1400)break;}
  nodes=selected.sort((a,b)=>Number(index.get(a))-Number(index.get(b)));
 }
 const elements=[];
 for(const el of nodes){
  const tag=el.tagName.toLowerCase();
  const b=el.getBoundingClientRect(),s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) continue;
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
 const signatures=[document.documentElement.className,document.body.className,...Array.from(document.querySelectorAll('script[src],link[href]')).map(el=>el.getAttribute('src')||el.getAttribute('href')||''),document.querySelector('meta[name="generator"]')?.getAttribute('content')||''].join(' ');\n const platformHints=[]; for(const [label,re] of [['WordPress',/wordpress|wp-content|wp-includes/i],['Elementor',/elementor/i],['WPBakery',/wpbakery|js_composer|vc_/i],['Divi',/divi|et_pb_/i],['WooCommerce',/woocommerce|wc-/i],['Shopify',/shopify/i],['Wix',/wix/i],['Squarespace',/squarespace/i]])if(re.test(signatures))platformHints.push(label);\n const cleanText=(node)=>{const walk=(current)=>current?.nodeType===3?String(current.textContent||''):Array.from(current?.childNodes||[]).map(walk).join(' ');return walk(node).replace(/\\s+/g,' ').trim().slice(0,2200);};\n const carouselRoots=Array.from(document.querySelectorAll('[aria-roledescription="carousel"],.swiper,.swiper-container,.slick-slider,[class*="carousel"],[class*="slider"],[class*="testimonial"],[class*="review"]'));\n const carousels=[],seenCarouselRoots=new Set(),seenCarouselSignatures=new Set();\n for(const root of carouselRoots){\n  if(seenCarouselRoots.has(root))continue;seenCarouselRoots.add(root);\n  const selectors=['.swiper-slide:not(.swiper-slide-duplicate)','.slick-slide:not(.slick-cloned)','[aria-roledescription="slide"]','[data-swiper-slide-index]',':scope > article',':scope > li','article','[class*="testimonial"]','[class*="review"]'];\n  let slides=[];\n  for(const selector of selectors){try{const found=Array.from(root.querySelectorAll(selector)).filter(el=>el!==root);if(found.length>=2){slides=found;break;}}catch{}}\n  if(slides.length<2)continue;\n  const unique=[],seenSlides=new Set();\n  for(const slide of slides){const text=cleanText(slide),images=Array.from(slide.querySelectorAll('img')).map(i=>{const raw=i.getAttribute('data-src')||i.getAttribute('data-lazy-src')||i.getAttribute('data-original')||i.currentSrc||i.src;try{return raw?new URL(raw,document.baseURI).href:'';}catch{return raw||'';}}).filter(Boolean).slice(0,4);const signature=text+'|'+images.join('|');if(!signature||seenSlides.has(signature))continue;seenSlides.add(signature);unique.push({text,images});if(unique.length>=24)break;}\n  if(unique.length<2)continue;\n  const inventorySignature=unique.map(slide=>slide.text+'|'+slide.images.join('|')).join('||');if(seenCarouselSignatures.has(inventorySignature))continue;seenCarouselSignatures.add(inventorySignature);\n  const label=String(root.getAttribute('aria-label')||root.id||root.className||'carousel').replace(/\\s+/g,' ').trim().slice(0,160);\n  carousels.push({label,slides:unique});if(carousels.length>=6)break;\n }\n const visibleText=String(document.body?.innerText||'').replace(/\\s+/g,' ').trim();\n const rootStyle=read(getComputedStyle(document.documentElement)),bodyStyle=read(getComputedStyle(document.body));\n return {text:visibleText,title:document.title,height:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,rootStyle,bodyStyle,
 brokenImages:Array.from(document.images).filter(i=>{const b=i.getBoundingClientRect(),s=getComputedStyle(i);return b.width>0&&b.height>0&&b.right>0&&b.left<innerWidth&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&i.naturalWidth===0;}).length,
 elements,links:Array.from(document.querySelectorAll('a[href]')).map(a=>a.href),embeds:Array.from(document.querySelectorAll('iframe')).map(f=>f.src),forms:document.forms.length,carousels,fontFaces,mediaQueries:Array.from(new Set(mediaQueries)),platformHints:Array.from(new Set(platformHints)),truncated};
})()`;
export async function geometry(page: Page): Promise<Geometry> {
  return await page.evaluate(GEOMETRY) as Geometry;
}
export async function navigateRenderable(page:Page,url:string):Promise<import('playwright-core').Response|null>{
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  // Full load is best-effort only. Third-party analytics, captcha, media, or CDN
  // requests must not make an already-rendered source page fatal.
  await page.waitForLoadState('load',{timeout:5000}).catch(()=>{});
  return response;
}

export async function navigateRenderableWithFallback(page:Page,url:string,fallbackUrl?:string):Promise<{response:import('playwright-core').Response|null;url:string;usedFallback:boolean;liveError?:string}>{
  try{
    const response=await navigateRenderable(page,url);
    if(response?.ok()||!fallbackUrl)return{response,url,usedFallback:false};
    const liveError=`HTTP ${response?.status()}`;
    const fallback=await navigateRenderable(page,fallbackUrl);
    return{response:fallback,url:fallbackUrl,usedFallback:true,liveError};
  }catch(error){
    if(!fallbackUrl)throw error;
    const fallback=await navigateRenderable(page,fallbackUrl);
    return{response:fallback,url:fallbackUrl,usedFallback:true,liveError:error instanceof Error?error.message:String(error)};
  }
}


const MOTION_FRAME = `(() => {
  const nodes=Array.from(document.querySelectorAll('body *')),index=new Map(nodes.map((node,i)=>[node,String(i)]));
  const useful=(el,s)=>{
    const tag=el.tagName.toLowerCase(),b=el.getBoundingClientRect();
    if(!b.width||!b.height||b.bottom<0||b.top>innerHeight||s.display==='none'||s.visibility==='hidden')return false;
    const animated=s.transform!=='none'||Number(s.opacity)!==1||s.position==='sticky'||s.position==='fixed'||s.animationName!=='none'||s.transitionDuration!=='0s';
    return animated||/^(header|nav|main|section|article|h[1-6]|p|img|button|a)$/.test(tag);
  };
  const selected=[];
  for(const el of nodes){
    const s=getComputedStyle(el);if(!useful(el,s))continue;const b=el.getBoundingClientRect();
    selected.push({key:index.get(el)||'',tag:el.tagName.toLowerCase(),text:String(el.innerText||el.getAttribute('aria-label')||el.getAttribute('alt')||'').replace(/\\s+/g,' ').trim().slice(0,140),x:Math.round(b.x+scrollX),y:Math.round(b.y+scrollY),width:Math.round(b.width),height:Math.round(b.height),transform:s.transform,opacity:s.opacity,position:s.position});
    if(selected.length>=140)break;
  }
  return {scrollY:Math.round(scrollY),elements:selected};
})()`;
const MOTION_META = `(() => {
  const signature=[document.documentElement.className,document.body.className,...Array.from(document.querySelectorAll('script[src],link[href]')).map(el=>el.getAttribute('src')||el.getAttribute('href')||'')].join(' ');
  const libraries=[];
  const add=(name,yes)=>{if(yes&&!libraries.includes(name))libraries.push(name);};
  add('Slider Revolution',/revslider|revolution|rs6|rev_slider/i.test(signature)||!!document.querySelector('rs-module,.rev_slider,[class*="rev_slider"]'));
  add('GSAP',!!window.gsap||!!window.ScrollTrigger||/gsap|scrolltrigger/i.test(signature));
  add('Swiper',!!window.Swiper||/swiper/i.test(signature)||!!document.querySelector('.swiper,.swiper-container'));
  add('Slick',!!window.jQuery?.fn?.slick||/slick/i.test(signature)||!!document.querySelector('.slick-slider'));
  add('Elementor Motion',/elementor/i.test(signature)&&!!document.querySelector('.elementor-invisible,[data-settings*="animation"],[class*="elementor-motion"]'));
  add('AOS',!!window.AOS||/aos/i.test(signature)||!!document.querySelector('[data-aos]'));
  const animations=[];
  for(const animation of document.getAnimations().slice(0,80)){
    try{
      const effect=animation.effect, timing=effect?.getTiming?.()||{},target=effect?.target;
      const frames=effect?.getKeyframes?.()||[],props=new Set();
      for(const frame of frames)for(const key of Object.keys(frame))if(!['offset','easing','composite','computedOffset'].includes(key))props.add(key);
      const label=String(target?.getAttribute?.('aria-label')||target?.getAttribute?.('alt')||target?.textContent||target?.id||target?.className||target?.tagName||'animation').replace(/\\s+/g,' ').trim().slice(0,140);
      animations.push({target:label,duration:Number.isFinite(Number(timing.duration))?Number(timing.duration):null,delay:Number.isFinite(Number(timing.delay))?Number(timing.delay):null,iterations:Number.isFinite(Number(timing.iterations))?Number(timing.iterations):null,direction:String(timing.direction||''),easing:String(timing.easing||''),fill:String(timing.fill||''),playState:String(animation.playState||''),properties:Array.from(props).slice(0,12)});
    }catch{}
  }
  return {libraries,animations};
})()`;
export async function observeMotion(page:Page,signal:AbortSignal):Promise<import('./types.js').MotionEvidence>{
  signal.throwIfAborted();
  await page.evaluate(`Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1200))])`);
  const meta=await page.evaluate(MOTION_META) as {libraries:string[];animations:import('./types.js').MotionAnimationEvidence[]};
  const frames:import('./types.js').MotionFrame[]=[];
  const sample=async(atMs:number)=>{
    signal.throwIfAborted();
    const raw=await page.evaluate(MOTION_FRAME) as {scrollY:number;elements:import('./types.js').MotionElementSample[]};
    frames.push({atMs,scrollY:raw.scrollY,elements:raw.elements});
  };
  await sample(0);await page.waitForTimeout(220);await sample(220);await page.waitForTimeout(480);await sample(700);
  const height=await page.evaluate('document.documentElement.scrollHeight') as number;
  const viewportHeight=await page.evaluate('innerHeight') as number;
  const positions=[Math.max(0,Math.round((height-viewportHeight)*0.35)),Math.max(0,Math.round((height-viewportHeight)*0.7))];
  let at=700;
  for(const y of positions){if(y<=0)continue;await page.evaluate(`scrollTo(0,${y})`);await page.waitForTimeout(180);at+=180;await sample(at);}
  await page.evaluate('scrollTo(0,0)');await page.waitForTimeout(80);
  const byKey=new Map<string,import('./types.js').MotionElementSample[]>();
  for(const frame of frames)for(const element of frame.elements){const list=byKey.get(element.key)??[];list.push(element);byKey.set(element.key,list);}
  let changedElements=0,hasScrollLinkedMotion=false,hasEntranceMotion=false,hasStickyOrFixedMotion=false;
  for(const list of byKey.values()){
    if(list.length<2)continue;
    const first=list[0],changed=list.some(item=>item.transform!==first.transform||item.opacity!==first.opacity||Math.abs(item.x-first.x)>2||Math.abs(item.y-first.y)>2);
    if(changed)changedElements++;
    if(list.some(item=>item.position==='sticky'||item.position==='fixed'))hasStickyOrFixedMotion=true;
    const startup=list.filter((_item,index)=>frames[index]?.scrollY===0);
    if(startup.length>=2&&startup.some(item=>item.transform!==startup[0].transform||item.opacity!==startup[0].opacity))hasEntranceMotion=true;
    const scrolled=list.filter((_item,index)=>frames[index]?.scrollY>0);
    if(scrolled.length&&scrolled.some(item=>item.transform!==first.transform||item.opacity!==first.opacity||Math.abs(item.y-first.y)>2))hasScrollLinkedMotion=true;
  }
  return {libraries:meta.libraries,frames,animations:meta.animations,changedElements,hasScrollLinkedMotion,hasEntranceMotion,hasStickyOrFixedMotion};
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
 const name=(el)=>clean(el.getAttribute('aria-label')||el.getAttribute('title')||(el.classList?.contains('swiper-button-next')?'Next slide':el.classList?.contains('swiper-button-prev')?'Previous slide':'')||el.textContent||el.getAttribute('aria-controls'));
 const seenElements=new Set(),counts=new Map();
 const groups={priority:[],hover:[],carousel:[],tabs:[],other:[],details:[]};
 const visible=(el)=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return !!b.width&&!!b.height&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;};
 const push=(group,kind,el)=>{
   if(seenElements.has(el)||!visible(el))return;
   const n=name(el),controls=el.getAttribute('aria-controls')||undefined,key=kind+'|'+n+'|'+(controls||'');
   if(!n)return;
   const ordinal=counts.get(key)||0;counts.set(key,ordinal+1);seenElements.add(el);
   groups[group].push({kind,name:n,controls,ordinal});
 };
 for(const el of Array.from(document.querySelectorAll('button[aria-expanded="false"],[role="button"][aria-expanded="false"],button[aria-haspopup],[role="button"][aria-haspopup],button[aria-controls],[role="button"][aria-controls]'))){
   if(el.matches('[type="submit"],[type="reset"]')||el.closest('form')&&el.tagName==='BUTTON'&&(!el.getAttribute('type')||el.getAttribute('type')==='submit'))continue;
   if(el.getAttribute('role')==='tab')continue;
   const n=name(el),important=/menu|navigation|nav|drawer|toggle/i.test(n+' '+(el.getAttribute('aria-controls')||''))||el.getAttribute('aria-haspopup');
   push(important?'priority':'other','button',el);
 }
 // Desktop navigation often exposes submenus only through CSS :hover rather than a click handler.
 for(const el of Array.from(document.querySelectorAll('header a[aria-haspopup],nav a[aria-haspopup],header li.menu-item-has-children > a,nav li.menu-item-has-children > a,header li:has(> ul) > a,nav li:has(> ul) > a')))push('hover','hover',el);
 // Explicit Previous/Next carousel controls get reserved evidence slots so accordions cannot starve them.
 const carousel=/^(?:previous|prev|next)(?:\\s+(?:slide|testimonial|review|item|image|photo|project))?\\b/i;
 for(const el of Array.from(document.querySelectorAll('button,[role="button"]'))){
   const n=name(el);if(!carousel.test(n))continue;
   if(el.matches('[type="submit"],[type="reset"]')||el.closest('form')&&el.tagName==='BUTTON'&&(!el.getAttribute('type')||el.getAttribute('type')==='submit'))continue;
   push('carousel','button',el);
 }
 for(const el of Array.from(document.querySelectorAll('[role="tab"]:not([aria-selected="true"])')))push('tabs','tab',el);
 for(const d of Array.from(document.querySelectorAll('details:not([open])'))){const summary=d.querySelector(':scope > summary');if(summary)push('details','details',summary);}
 return [...groups.priority.slice(0,2),...groups.hover.slice(0,1),...groups.carousel.slice(0,2),...groups.tabs.slice(0,1),...groups.other.slice(0,1),...groups.details.slice(0,1)].slice(0,8);
})()`;
export async function discoverInteractions(page: Page): Promise<InteractionTrigger[]> {
  return await page.evaluate(INTERACTIONS) as InteractionTrigger[];
}
export async function activateInteraction(page: Page, trigger: InteractionTrigger): Promise<boolean> {
  const payload=JSON.stringify(trigger).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  if(trigger.kind==='hover'){
    const point=await page.evaluate(`(() => {
      const trigger=${payload};
      const clean=(s)=>String(s==null?'':s).replace(/\\s+/g,' ').trim().slice(0,120);
      const label=(el)=>clean(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||el.getAttribute('aria-controls'));
      const visible=(el)=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return !!b.width&&!!b.height&&b.bottom>0&&b.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;};
      const items=Array.from(document.querySelectorAll('header a,nav a,header button,nav button,header [role="button"],nav [role="button"]')).filter(visible);
      const matches=items.filter(el=>label(el)===trigger.name&&(!trigger.controls||el.getAttribute('aria-controls')===trigger.controls));
      const target=matches[Math.max(0,Number(trigger.ordinal)||0)];if(!target)return null;
      const b=target.getBoundingClientRect();return {x:Math.max(1,Math.min(innerWidth-2,b.left+b.width/2)),y:Math.max(1,Math.min(innerHeight-2,b.top+b.height/2))};
    })()`) as {x:number;y:number}|null;
    if(!point)return false;await page.mouse.move(point.x,point.y);return true;
  }
  const script=`(() => {
    const trigger=${payload};
    const clean=(s)=>String(s==null?'':s).replace(/\\s+/g,' ').trim().slice(0,120);
    const label=(el)=>clean(el.getAttribute('aria-label')||el.getAttribute('title')||(el.classList?.contains('swiper-button-next')?'Next slide':el.classList?.contains('swiper-button-prev')?'Previous slide':'')||el.textContent||el.getAttribute('aria-controls'));
    const visible=(el)=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return !!b.width&&!!b.height&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;};
    let items=[];
    if(trigger.kind==='details')items=Array.from(document.querySelectorAll('details:not([open]) > summary'));
    else if(trigger.kind==='tab')items=Array.from(document.querySelectorAll('[role="tab"]'));
    else items=Array.from(document.querySelectorAll('button,[role="button"]')).filter(el=>!el.matches('[type="submit"],[type="reset"]'));
    const matches=items.filter(el=>visible(el)&&label(el)===trigger.name&&(!trigger.controls||el.getAttribute('aria-controls')===trigger.controls));
    const target=matches[Math.max(0,Number(trigger.ordinal)||0)];
    if(!target)return false;
    target.click();
    return true;
  })()`;
  return await page.evaluate(script) as boolean;
}
async function primeCarouselAssets(page:Page,signal:AbortSignal):Promise<number>{
  const triggers=await discoverInteractions(page),next=triggers.find(trigger=>trigger.kind==='button'&&/^next(?:\s+(?:slide|testimonial|review|item|image|photo|project))?\b/i.test(trigger.name));
  if(!next)return 0;
  const seen=new Set<string>();
  for(let step=0;step<16;step++){
    signal.throwIfAborted();const fingerprint=geometryFingerprint(await geometry(page));if(seen.has(fingerprint))break;seen.add(fingerprint);
    if(!await activateInteraction(page,next))break;await page.waitForTimeout(140);
  }
  return seen.size;
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
  const assetMap = new Map<string,Evidence['assets'][number]>(),assetFiles=new Map<string,{file:string;publicPath:string}>(),faces = new Set<string>();
  let totalBytes=0;
  const save = async (url:string,body:Buffer,mime:string) => {
    if(assetMap.has(url))return;
    const ext = EXT[mime.split(';')[0]] ?? (/\.(woff2?|ttf|otf)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase());
    if(!ext)return;
    if(body.length>16_000_000||assetMap.size>=1000)throw new Error('Asset budget exceeded');
    const digest=createHash('sha256').update(body).digest('hex'),assetKey=`${digest}.${ext}`,existing=assetFiles.get(assetKey);
    if(existing){assetMap.set(url,{original:url,...existing});return;}
    if(totalBytes+body.length>160_000_000)throw new Error('Asset budget exceeded');
    totalBytes+=body.length;
    const publicPath=`/assets/${digest.slice(0,24)}.${ext}`;
    const file=join(options.directory,publicPath);
    const stored={file,publicPath};assetFiles.set(assetKey,stored);assetMap.set(url,{original:url,...stored});
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
  let targets: Array<{route:string;url:string;fallbackUrl?:string;discovered?:boolean}> = [];
  const autoDiscovery=Boolean(options.url&&!options.urls?.length&&!options.bundleDir);
  if(options.bundleDir){
    const bundle=await readBundle(options.bundleDir);
    if(bundle.pages.length>maxPages)throw new Error('Bundle has more pages than maxPages; no pages were silently skipped');
    if(options.url){
      const live=publicUrl(options.url);await assertPublicUrl(live.href);
      if(live.origin!==new URL(bundle.site).origin)throw new Error('Saved-page bundle and live URL must belong to the same website origin');
      evidence.site=live.origin;
      const requested=options.urls?.length?options.urls.map(value=>new URL(value,live)):bundle.pages.map(p=>new URL(p.route,live.origin));
      for(const page of requested)if(page.origin!==live.origin||page.search)throw new Error('Hybrid page URLs must be same-origin and cannot contain query parameters');
      const aliases=Object.fromEntries(bundle.pages.map(p=>[p.route,p.file]));
      local=await serve(resolve(options.bundleDir),aliases,true);
      const savedRoutes=new Set(bundle.pages.map(p=>p.route));
      targets=requested.map(page=>{const route=routePath(page.pathname);return{route,url:page.href,...(savedRoutes.has(route)?{fallbackUrl:local!.origin+route}:{})};});
      await importSavedResources(options.bundleDir);
      const supplemented=targets.filter(target=>savedRoutes.has(target.route)).length;
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
    if(autoDiscovery){
      const ctx=await engine.newContext({viewport:views[0],serviceWorkers:'block',acceptDownloads:false});
      try{
        await restrictNetwork(ctx);const page=await ctx.newPage();
        const resp=await navigateRenderable(page,targets[0].url);
        if(!resp?.ok())throw new Error(`Source returned HTTP ${resp?.status()}`);
        const discovered=await page.evaluate(`Array.from(document.querySelectorAll('header a[href],nav a[href],main a[href],footer a[href]')).map((a,index)=>({href:a.href,region:a.closest('nav')?'nav':a.closest('header')?'header':a.closest('main')?'main':'footer',index}))`) as DiscoveredLink[];
        const sitemapUrls=await page.evaluate(`(async()=>{const origin=location.origin,queue=['/wp-sitemap.xml','/sitemap.xml','/wp-sitemap-posts-page-1.xml'].map(path=>origin+path),seen=new Set(),pages=[];while(queue.length&&seen.size<8&&pages.length<200){const url=queue.shift();if(!url||seen.has(url))continue;seen.add(url);try{const response=await fetch(url,{credentials:'omit'});if(!response.ok)continue;const text=await response.text(),doc=new DOMParser().parseFromString(text,'application/xml');for(const node of Array.from(doc.querySelectorAll('loc'))){const raw=String(node.textContent||'').trim();if(!raw)continue;const parsed=new URL(raw,origin);if(parsed.origin!==origin)continue;if(/\\.xml$/i.test(parsed.pathname)){if(queue.length<12)queue.push(parsed.href);}else pages.push(parsed.href);if(pages.length>=200)break;}}catch{}}return pages;})()`) as string[];
        const sitemapLinks:DiscoveredLink[]=sitemapUrls.map((href,index)=>({href,region:'sitemap',index:10000+index}));
        const found=prioritizeDiscoveredLinks([...discovered,...sitemapLinks]),known=new Set(targets.map(t=>t.route)),candidateLimit=Math.min(100,Math.max(maxPages*4,24));
        for(const value of found){try{const u=new URL(value);if(u.origin!==new URL(evidence.site).origin||u.search||/\.(pdf|png|jpg|zip|mp4)$/i.test(u.pathname))continue;const route=routePath(u.pathname);if(!known.has(route)){targets.push({route,url:u.origin+route,discovered:true});known.add(route);if(targets.length>=candidateLimit)break;}}catch{}}
        if(targets.length>maxPages)evidence.warnings.push(`Discovery found ${targets.length} candidate routes; Molt will retain the first ${maxPages} that capture successfully.`);
      }finally{await ctx.close();}
    }
    if((!autoDiscovery&&targets.length>maxPages)||new Set(targets.map(t=>t.route)).size!==targets.length)throw new Error('Too many or duplicate requested routes');
    const stabilityEnabled=(options.sourceStability??true)&&Boolean(options.url);
    const adaptiveEnabled=(options.adaptiveViewports??Boolean(options.url))&&options.viewports===undefined;
    const stabilityFingerprints=new Map<string,string>();
    for(const target of targets){
      if(autoDiscovery&&evidence.pages.length>=maxPages)break;
      const warningStart=evidence.warnings.length,blockerStart=evidence.blockers.length;
      try{
      if(stabilityEnabled){
        const ctx=await engine.newContext({viewport:views[0],deviceScaleFactor:1,colorScheme:'light',locale:'en-US',serviceWorkers:'block',acceptDownloads:false});
        try{
          await restrictNetwork(ctx,local?.origin,false);const page=await ctx.newPage();const samples:string[]=[];
          for(let attempt=0;attempt<3;attempt++){
            options.signal.throwIfAborted();
            const probe=await navigateRenderableWithFallback(page,target.url,target.fallbackUrl);const response=probe.response;if(probe.usedFallback){evidence.warnings.push(`${target.route}: live source stability probe fell back to the retained saved page (${probe.liveError}).`);break;}if(!response?.ok())throw new Error(`HTTP ${response?.status()}`);
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
          await restrictNetwork(ctx,local?.origin,Boolean(local&&!options.url));
          const page=await ctx.newPage();
          page.on('response',res=>{
            const type=res.request().resourceType();if(!['image','font','stylesheet'].includes(type)||!res.ok())return;
            pending.push((async()=>{const body=await res.body();const mime=res.headers()['content-type']??'';
              if(type==='stylesheet'){for(const face of body.toString('utf8').match(/@font-face\s*\{[^}]*\}/gi)??[])faces.add(absolutizeCss(face,res.url()));}
              else await save(res.url(),body,mime);
            })().catch(e=>{assetErrors.push((e as Error).message);}));
          });
          const navigation=await navigateRenderableWithFallback(page,target.url,target.fallbackUrl);
          const response=navigation.response,activeUrl=navigation.url;
          if(navigation.usedFallback)evidence.warnings.push(`${target.route} ${viewport.name}: live source navigation failed (${navigation.liveError}); captured the retained saved-page bundle instead.`);
          if(!response?.ok())throw new Error(`${target.route}: HTTP ${response?.status()}`);
          let motion:import('./types.js').MotionEvidence|undefined;
          if(viewport.name==='desktop'||viewport.name==='mobile'){
            try{motion=await observeMotion(page,options.signal);}catch(error){evidence.warnings.push(`${target.route} ${viewport.name}: motion observation could not complete (${(error as Error).message}). Stable visual capture will continue.`);}
          }
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
          for(const face of g.fontFaces)faces.add(absolutizeCss(face,activeUrl));
          for(const e of g.elements){
            const urls=[...(e.src?[e.src]:[]),...urlsIn(e.style['background-image']??'')];
            for(const url of urls){if(!url.startsWith('data:'))continue;const m=/^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);if(m)await save(url,Buffer.from(m[2]?m[3]:decodeURIComponent(m[3]),m[2]?'base64':'utf8'),m[1]);}
          }
          if(g.truncated)evidence.warnings.push(`${target.route} ${viewport.name}: geometry sampled to 1400 visible elements across the full page; full screenshot and text retained.`);
          if(g.brokenImages)evidence.blockers.push(`${target.route} ${viewport.name}: ${g.brokenImages} source images did not load.`);
          if(g.embeds.length)evidence.blockers.push(`${target.route}: embedded media requires an approved integration (${g.embeds.join(', ')}).`);
          if(g.forms)evidence.blockers.push(`${target.route}: form submission needs a backend integration; acknowledging this does not implement it.`);
          const primedCarouselStates=await primeCarouselAssets(page,options.signal);
          if(primedCarouselStates>1){const reset=await navigateRenderable(page,activeUrl);if(reset?.ok())await settle(page,options.signal);else evidence.warnings.push(`${target.route} ${viewport.name}: carousel asset priming could not restore the initial page state.`);}
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
              const reset=await navigateRenderable(page,activeUrl);
              if(!reset?.ok()){evidence.warnings.push(`${target.route} ${viewport.name}: interaction-state reset returned HTTP ${reset?.status()}.`);break;}
              await page.mouse.move(0,0);await settle(page,options.signal);
            }
          }
          item.title=g.title;item.views.push({viewport,screenshot,geometry:g,interactions,motion});
          await writeFile(join(options.directory,slug,`${viewport.name}.json`),JSON.stringify({...g,motion,interactions:interactions.map(i=>({id:i.id,trigger:i.trigger,screenshot:i.screenshot}))},null,2));
          await Promise.all(pending);
          if(assetErrors.length)evidence.blockers.push(`${target.route}: asset capture errors: ${assetErrors.slice(0,3).join('; ')}`);
        }finally{await ctx.close();}
      }
      evidence.pages.push(item);
      }catch(error){
        if(!target.discovered||options.signal.aborted||!skippableDiscoveredCaptureError(error))throw error;
        evidence.warnings.length=warningStart;evidence.blockers.length=blockerStart;
        evidence.warnings.push(`${target.route}: skipped discovered route because source capture failed (${(error as Error).message}).`);
      }
    }
    if(autoDiscovery&&evidence.pages.length<maxPages)evidence.warnings.push(`Discovery retained ${evidence.pages.length} of the requested maximum ${maxPages} pages after validating available candidates.`);
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
