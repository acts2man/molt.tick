import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, build, restrictNetwork, serve } from './runtime.js';
import { activateInteraction, geometry, settle } from './capture.js';
import { compare } from './images.js';
import { routeFile } from './policy.js';
import type { Evidence, Evaluation, ViewCheck, Geometry, ElementEvidence } from './types.js';

const normalize=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
const TEXT_TAG=/^(h[1-6]|p|li|button|label|blockquote|strong|b|em|i|span|a|small)$/;
const INLINE_TEXT_TAG=/^(strong|b|em|i|span|a|small)$/;
const TYPOGRAPHY_PROPS=['font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','color'] as const;
const short=(e:ElementEvidence)=>{const value=normalize(e.text);return value.length>54?value.slice(0,51)+'…':value||e.tag;};
function typographyDiffs(source:ElementEvidence,candidate:ElementEvidence):string[]{
  const diffs:string[]=[];
  for(const property of TYPOGRAPHY_PROPS){
    const expected=source.style[property]??'',actual=candidate.style[property]??'';
    if(expected===actual)continue;
    diffs.push(`${property} source ${expected||'unset'}, generated ${actual||'unset'}`);
  }
  return diffs;
}
function matchedTextElements(source:Geometry,candidate:Geometry):Array<{source:ElementEvidence;candidate:ElementEvidence}>{
  const visibleCandidate=candidate.elements.filter(e=>normalize(e.text)&&TEXT_TAG.test(e.tag));
  const key=(e:ElementEvidence,text:string)=>(INLINE_TEXT_TAG.test(e.tag)?'inline':e.tag)+'\0'+text;
  const pools=new Map<string,ElementEvidence[]>();
  for(const e of visibleCandidate){
    const text=normalize(e.text),k=key(e,text),items=pools.get(k)??[];items.push(e);pools.set(k,items);
  }
  const out:Array<{source:ElementEvidence;candidate:ElementEvidence}>=[];
  for(const e of source.elements){
    const text=normalize(e.text);if(!text||!TEXT_TAG.test(e.tag))continue;
    const items=pools.get(key(e,text));let actual=items?.shift();
    // If emphasized inline text was flattened into its surrounding paragraph, still compare the
    // fragment against the smallest candidate text box containing it so lost bold/italic is visible.
    if(!actual&&INLINE_TEXT_TAG.test(e.tag)&&text.length>=3){
      actual=visibleCandidate.filter(c=>normalize(c.text).includes(text)).sort((a,b)=>normalize(a.text).length-normalize(b.text).length)[0];
    }
    if(actual)out.push({source:e,candidate:actual});
  }
  return out;
}
const overlapX=(a:ElementEvidence,b:ElementEvidence)=>{
  const left=Math.max(a.x,b.x),right=Math.min(a.x+a.width,b.x+b.width);
  return Math.max(0,right-left)/Math.max(1,Math.min(a.width,b.width));
};

const geometryDelta=(source:ElementEvidence,candidate:ElementEvidence)=>({
  x:candidate.x-source.x,y:candidate.y-source.y,width:candidate.width-source.width,height:candidate.height-source.height
});
const geometryMismatch=(delta:{x:number;y:number;width:number;height:number},tolerance=4)=>
  Math.max(Math.abs(delta.x),Math.abs(delta.y),Math.abs(delta.width),Math.abs(delta.height))>tolerance;
const geometryMessage=(label:string,source:ElementEvidence,candidate:ElementEvidence)=>{
  const d=geometryDelta(source,candidate);
  return `${label}: source x/y ${Math.round(source.x)}/${Math.round(source.y)}px, ${Math.round(source.width)}×${Math.round(source.height)}px; generated ${Math.round(candidate.x)}/${Math.round(candidate.y)}px, ${Math.round(candidate.width)}×${Math.round(candidate.height)}px; delta x ${Math.round(d.x)}, y ${Math.round(d.y)}, width ${Math.round(d.width)}, height ${Math.round(d.height)}px`;
};
function assetPath(value:string|undefined):string{
  if(!value)return '';
  try{return new URL(value,'https://molt.invalid').pathname;}catch{return value;}
}
export function mediaGeometryIssues(source:Geometry,candidate:Geometry,evidence:Evidence):string[]{
  const issues:Array<{amount:number;message:string}>=[],assetByOriginal=new Map(evidence.assets.map(asset=>[asset.original,asset.publicPath]));
  const generatedImages=candidate.elements.filter(e=>e.tag==='img'&&e.src);
  for(const image of source.elements.filter(e=>e.tag==='img'&&e.src)){
    const local=assetByOriginal.get(image.src!);if(!local)continue;
    const match=generatedImages.find(e=>assetPath(e.src)===local);if(!match)continue;
    const delta=geometryDelta(image,match);if(!geometryMismatch(delta))continue;
    issues.push({amount:Math.max(...Object.values(delta).map(Math.abs)),message:geometryMessage(`Image ${image.attributes?.alt?`"${String(image.attributes.alt).slice(0,70)}"`:local}`,image,match)});
  }
  const sourceBackgrounds=source.elements.filter(e=>e.style['background-image']&&e.style['background-image']!=='none');
  const candidateBackgrounds=candidate.elements.filter(e=>e.style['background-image']&&e.style['background-image']!=='none');
  for(const box of sourceBackgrounds){
    const original=[...box.style['background-image'].matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m=>m[1]).find(url=>assetByOriginal.has(url));
    if(!original)continue;const local=assetByOriginal.get(original)!;
    const match=candidateBackgrounds.find(e=>e.style['background-image'].includes(local));if(!match)continue;
    const delta=geometryDelta(box,match);if(!geometryMismatch(delta))continue;
    issues.push({amount:Math.max(...Object.values(delta).map(Math.abs)),message:geometryMessage(`Background ${local}`,box,match)});
  }
  return issues.sort((a,b)=>b.amount-a.amount).slice(0,8).map(i=>i.message);
}
export function controlGeometryIssues(source:Geometry,candidate:Geometry):string[]{
  const issues:Array<{amount:number;message:string}>=[];
  for(const pair of matchedTextElements(source,candidate)){
    const role=pair.source.attributes?.role??'';
    if(pair.source.tag!=='button'&&role!=='button')continue;
    const delta=geometryDelta(pair.source,pair.candidate);if(!geometryMismatch(delta))continue;
    issues.push({amount:Math.max(...Object.values(delta).map(Math.abs)),message:geometryMessage(`Control "${short(pair.source)}"`,pair.source,pair.candidate)});
  }
  return issues.sort((a,b)=>b.amount-a.amount).slice(0,6).map(i=>i.message);
}
export function spacingIssues(source:Geometry,candidate:Geometry):string[]{
  const pairs=matchedTextElements(source,candidate),problems:string[]=[];
  const typography:string[]=[];
  const horizontal:Array<{amount:number;message:string}>=[];
  for(const pair of pairs){
    if(/^h[1-6]$/.test(pair.source.tag))continue;
    const diffs=typographyDiffs(pair.source,pair.candidate);
    if(diffs.length&&typography.length<8)typography.push(`Text "${short(pair.source)}": ${diffs.join('; ')}`);
    if(!INLINE_TEXT_TAG.test(pair.source.tag)){
      const leftDelta=pair.candidate.x-pair.source.x;
      const sourceCenter=pair.source.x+pair.source.width/2,candidateCenter=pair.candidate.x+pair.candidate.width/2;
      const centerDelta=candidateCenter-sourceCenter;
      if(Math.abs(leftDelta)>8&&Math.abs(centerDelta)>8){
        horizontal.push({amount:Math.max(Math.abs(leftDelta),Math.abs(centerDelta)),message:`Horizontal alignment "${short(pair.source)}": source x ${Math.round(pair.source.x)}px, generated x ${Math.round(pair.candidate.x)}px; source center ${Math.round(sourceCenter)}px, generated center ${Math.round(candidateCenter)}px`});
      }
    }
  }
  problems.push(...typography);
  horizontal.sort((a,b)=>b.amount-a.amount);
  problems.push(...horizontal.slice(0,5).map(item=>item.message));

  const byParent=new Map<string,typeof pairs>();
  for(const pair of pairs){
    const parent=pair.source.parent;if(!parent)continue;
    const items=byParent.get(parent)??[];items.push(pair);byParent.set(parent,items);
  }
  const gaps:Array<{amount:number;message:string}>=[];
  for(const items of byParent.values()){
    items.sort((a,b)=>a.source.y-b.source.y||a.source.x-b.source.x);
    for(let i=0;i<items.length-1;i++){
      const a=items[i],b=items[i+1];
      if(b.source.y<a.source.y+a.source.height-2||overlapX(a.source,b.source)<0.12)continue;
      const sourceGap=b.source.y-(a.source.y+a.source.height);
      if(sourceGap<0||sourceGap>500)continue;
      const candidateGap=b.candidate.y-(a.candidate.y+a.candidate.height),delta=candidateGap-sourceGap;
      const tolerance=Math.max(5,Math.min(12,sourceGap*0.12));
      if(Math.abs(delta)<=tolerance)continue;
      gaps.push({amount:Math.abs(delta),message:`Spacing "${short(a.source)}" → "${short(b.source)}": source ${Math.round(sourceGap)}px, generated ${Math.round(candidateGap)}px (${Math.round(Math.abs(delta))}px too ${delta>0?'large':'small'})`});
    }
  }
  gaps.sort((a,b)=>b.amount-a.amount);
  problems.push(...gaps.slice(0,8).map(g=>g.message));
  return problems;
}
export function internalLinkIssues(source:Geometry,candidate:Geometry,captureOrigin:string,generatedOrigin:string,known:Set<string>,originalOrigin=captureOrigin):string[]{
  const problems:string[]=[],expected=new Set<string>(),actual=new Set<string>();
  const routeOf=(raw:string)=>{try{const u=new URL(raw);if(![captureOrigin,originalOrigin].includes(u.origin)||u.search)return null;return u.pathname.replace(/\/+$/,'')||'/';}catch{return null;}};
  for(const raw of source.links){const route=routeOf(raw);if(route&&known.has(route))expected.add(route);}
  for(const raw of candidate.links){
    try{
      const u=new URL(raw),route=u.pathname.replace(/\/+$/,'')||'/';
      if(u.origin===generatedOrigin){if(known.has(route))actual.add(route);else if(!u.pathname.startsWith('/assets/'))problems.push(`Unresolved internal link: ${route}`);}
      else if(u.origin===originalOrigin&&known.has(route))problems.push(`Internal link still points to the source website instead of the reconstructed route: ${route}`);
    }catch{}
  }
  for(const route of expected)if(!actual.has(route))problems.push(`Missing reconstructed internal link target: ${route}`);
  return [...new Set(problems)];
}
export function contentIssues(source:Geometry,candidate:Geometry):string[]{
  const problems:string[]=[];
  if(normalize(source.text)!==normalize(candidate.text))problems.push('Visible copy or reading order differs from the source');
  if(candidate.brokenImages)problems.push(`${candidate.brokenImages} generated images failed to load`);
  if(candidate.overflow&&!source.overflow)problems.push('Generated layout overflows the viewport');
  if(candidate.embeds.length)problems.push('Unapproved embedded runtime in generated output');
  const headings=candidate.elements.filter(e=>/^h[1-6]$/.test(e.tag));
  for(const original of source.elements.filter(e=>/^h[1-6]$/.test(e.tag))){
    const index=headings.findIndex(e=>e.tag===original.tag&&normalize(e.text)===normalize(original.text));
    if(index<0){problems.push(`Missing heading: ${original.text}`);continue;}
    const actual=headings.splice(index,1)[0];
    const mismatches=['x','y','width','height'].filter(k=>Math.abs(original[k as 'x'|'y'|'width'|'height']-actual[k as 'x'|'y'|'width'|'height'])>2);
    for(const property of TYPOGRAPHY_PROPS)if(original.style[property]!==actual.style[property])mismatches.push(property);
    if(mismatches.length)problems.push(`Heading ${original.text}: ${mismatches.join(', ')} differ`);
  }
  problems.push(...spacingIssues(source,candidate),...controlGeometryIssues(source,candidate));
  if(Math.abs(source.height-candidate.height)>Math.max(3,source.height*0.005))problems.push(`Page height differs: source ${source.height}px, generated ${candidate.height}px`);
  return problems;
}
export function emptyEvaluation(evidence:Evidence,issue:string):Evaluation{
  return {pass:false,issues:[issue],views:evidence.pages.flatMap(p=>p.views.map(v=>({route:p.route,viewport:v.viewport.name,score:null,worstBand:null,pass:false,issues:[issue],source:v.screenshot})))};
}
export async function evaluate(outDir:string,evidence:Evidence,directory:string,signal:AbortSignal,threshold=97,bandThreshold=92):Promise<Evaluation>{
  if(!Number.isFinite(threshold)||threshold<=0||threshold>100||!Number.isFinite(bandThreshold)||bandThreshold<=0||bandThreshold>100)throw new Error('Invalid visual acceptance thresholds');
  await mkdir(directory,{recursive:true});
  // A failed compilation must never reuse an earlier dist directory.
  await rm(join(outDir,'dist'),{recursive:true,force:true});
  const compilation=await build(outDir,AbortSignal.any([signal,AbortSignal.timeout(120000)]));
  await writeFile(join(directory,'build.log'),compilation.log);
  if(!compilation.ok)return emptyEvaluation(evidence,`Production compilation failed: ${compilation.log}`);
  const aliases=Object.fromEntries(evidence.pages.map(p=>[p.route,'index.html']));
  const host=await serve(join(outDir,'dist'),aliases);
  let engine:Awaited<ReturnType<typeof browser>>|undefined;
  const stop=()=>{void engine?.close();};signal.addEventListener('abort',stop,{once:true});
  const result:Evaluation={pass:false,issues:[],views:[]};
  try{
    signal.throwIfAborted();engine=await browser();
    for(const pageRef of evidence.pages){for(const reference of pageRef.views){
      signal.throwIfAborted();
      const slug=routeFile(pageRef.route).split('/').pop()!.replace('.tsx','');
      const stem=`${slug}-${reference.viewport.name}`;
      const check:ViewCheck={route:pageRef.route,viewport:reference.viewport.name,source:reference.screenshot,score:null,worstBand:null,pass:false,issues:[]};
      const ctx=await engine.newContext({viewport:reference.viewport,deviceScaleFactor:1,colorScheme:'light',locale:'en-US',serviceWorkers:'block',acceptDownloads:false});
      try{
        await restrictNetwork(ctx,host.origin,true);const page=await ctx.newPage();
        const errors:string[]=[];
        page.on('pageerror',e=>errors.push(e.message));
        page.on('requestfailed',r=>{if(['image','font','stylesheet','script'].includes(r.resourceType())&&!r.url().endsWith('favicon.ico'))errors.push(`Failed resource: ${r.url().replace(host.origin,'')}`);});
        const response=await page.goto(host.origin+pageRef.route,{waitUntil:'load',timeout:30000});
        if(!response?.ok())throw new Error(`Generated route HTTP ${response?.status()}`);
        await settle(page,signal);
        check.candidate=join(directory,`${stem}.png`);check.diff=join(directory,`${stem}.diff.png`);
        await page.screenshot({path:check.candidate,fullPage:true,animations:'disabled',scale:'css',timeout:15000});
        const generated=await geometry(page);
        check.issues.push(...contentIssues(reference.geometry,generated),...mediaGeometryIssues(reference.geometry,generated,evidence),...errors);
        // Literal DOM links are checked after rendering, including shared components. Same-site links
        // must point to the reconstructed host rather than silently sending users back to the source site.
        const known=new Set(evidence.pages.map(p=>p.route));
        check.issues.push(...internalLinkIssues(reference.geometry,generated,new URL(pageRef.url).origin,host.origin,known,new URL(evidence.site).origin));
        const metrics=await compare(check.source,check.candidate,check.diff);Object.assign(check,metrics);
        check.interactions=[];
        for(let stateIndex=0;stateIndex<(reference.interactions??[]).length;stateIndex++){
          const state=reference.interactions![stateIndex];
          if(stateIndex>0){
            const reset=await page.goto(host.origin+pageRef.route,{waitUntil:'load',timeout:30000});
            if(!reset?.ok()){check.issues.push(`Interaction reset failed before "${state.trigger.name}"`);break;}
            await settle(page,signal);
          }
          const stateCheck={id:state.id,trigger:state.trigger,score:null,worstBand:null,pass:false,issues:[],source:state.screenshot} as NonNullable<ViewCheck['interactions']>[number];
          if(!await activateInteraction(page,state.trigger)){
            stateCheck.issues.push(`Generated page is missing interactive control: ${state.trigger.name}`);
          }else{
            await page.waitForTimeout(250);
            await page.evaluate(`(() => { for(const a of document.getAnimations()){try{if(a.effect.getComputedTiming().iterations!==Infinity)a.finish();}catch{}} })()`);
            stateCheck.candidate=join(directory,`${stem}-${state.id}.png`);
            stateCheck.diff=join(directory,`${stem}-${state.id}.diff.png`);
            await page.screenshot({path:stateCheck.candidate,fullPage:true,animations:'disabled',scale:'css',timeout:15000});
            const stateGenerated=await geometry(page);
            stateCheck.issues.push(...contentIssues(state.geometry,stateGenerated),...mediaGeometryIssues(state.geometry,stateGenerated,evidence));
            const stateMetrics=await compare(stateCheck.source,stateCheck.candidate,stateCheck.diff);Object.assign(stateCheck,stateMetrics);
            stateCheck.pass=stateCheck.issues.length===0&&stateMetrics.score>=threshold&&stateMetrics.worstBand>=bandThreshold;
            await writeFile(join(directory,`${stem}-${state.id}.json`),JSON.stringify({source:state.geometry,generated:stateGenerated,check:stateCheck},null,2));
          }
          if(!stateCheck.pass)check.issues.push(`Interaction "${state.trigger.name}" does not match its observed source state`);
          check.interactions.push(stateCheck);
        }
        check.pass=check.issues.length===0&&metrics.score>=threshold&&metrics.worstBand>=bandThreshold&&check.interactions.every(i=>i.pass);
        await writeFile(join(directory,`${stem}.json`),JSON.stringify({source:reference.geometry,generated,check},null,2));
      }catch(error){check.issues.push((error as Error).message);check.pass=false;}
      finally{await ctx.close().catch(()=>{});}
      result.views.push(check);
    }}
    result.pass=result.views.length>0&&result.views.every(v=>v.pass);
    return result;
  }finally{signal.removeEventListener('abort',stop);await engine?.close().catch(()=>{});await host.close();}
}
