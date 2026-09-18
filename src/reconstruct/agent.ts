import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { capture, type CaptureOptions } from './capture.js';
import { assessComplexity } from './complexity.js';
import { evaluate } from './evaluate.js';
import { referenceImages, repairImages } from './images.js';
import { modelFromEnv } from './provider.js';
import { repairLoop } from './loop.js';
import { writeReview } from './report.js';
import { apply, digest, restore, scaffold, snapshot } from './workspace.js';
import { prepareToolchain, build } from './runtime.js';
import { routeFile, integer } from './policy.js';
import type { Evidence, EvidencePage, FileChange, Model, ReconstructionResult } from './types.js';

export interface AgentOptions {
  url?:string; urls?:string[]; bundleDir?:string; workDir:string;
  maxPages?:number; maxRepairs?:number; model?:Model; signal?:AbortSignal;
  onProgress?:(message:string)=>void|Promise<void>;
}
const ESSENTIAL_STYLE_KEYS=['display','position','top','left','right','bottom','z-index','width','height','min-height','max-width','box-sizing','flex-direction','flex-wrap','flex-basis','justify-content','align-items','gap','grid-template-columns','padding','margin','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','color','background','background-image','background-size','background-position','border','border-radius','box-shadow','object-fit','object-position','transform','opacity','overflow'] as const;
function clipped(value:string|undefined,limit:number){if(!value)return value;return value.length>limit?value.slice(0,limit)+'…':value;}
function compactElement(e:any){
  const style=Object.fromEntries(ESSENTIAL_STYLE_KEYS.map(k=>[k,e.style?.[k]]).filter(([,v])=>v&&v!=='none'&&v!=='auto'&&v!=='normal'&&v!=='0px'));
  return {tag:e.tag,text:clipped(e.text,260),x:Math.round(e.x),y:Math.round(e.y),width:Math.round(e.width),height:Math.round(e.height),
    ...(Object.keys(style).length?{style}:{}),...(e.src?{src:clipped(e.src,500)}:{}),...(e.href?{href:clipped(e.href,500)}:{}),
    ...(e.svg?{svg:clipped(e.svg,4000)}:{}),...(e.attributes&&Object.keys(e.attributes).length?{attributes:e.attributes}:{}),
    ...(e.before?{before:e.before}:{}),...(e.after?{after:e.after}:{})};
}
function pageContext(evidence:Evidence,page:EvidencePage,geometryLimit=240,textLimit=50000):unknown{
  const remap=(s:string)=>{for(const asset of evidence.assets)if(s.includes(asset.original))s=s.split(asset.original).join(asset.publicPath);return s;};
  const desktopText=clipped(page.views[0]?.geometry.text??'',textLimit)??'';
  const mediaQueries=[...new Set(page.views.flatMap(v=>v.geometry.mediaQueries))].slice(0,120);
  const select=(elements:any[],limit:number)=>elements.filter(e=>e.text||e.src||e.svg||/^(section|header|footer|main|nav|form|button|a|img|h[1-6])$/.test(e.tag)||e.style?.['background-image']!=='none')
    .slice(0,limit).map(e=>JSON.parse(remap(JSON.stringify(compactElement(e)))));
  return {route:page.route,title:page.title,file:routeFile(page.route),fullVisibleText:desktopText,mediaQueries,
    views:page.views.map((v,index)=>({
      viewport:v.viewport,pageHeight:v.geometry.height,truncatedGeometry:v.geometry.truncated,
      ...(index>0&&v.geometry.text!==page.views[0]?.geometry.text?{visibleTextOverride:clipped(v.geometry.text,textLimit)}:{}),
      interactions:(v.interactions??[]).slice(0,3).map(state=>({id:state.id,trigger:state.trigger,visibleText:clipped(state.geometry.text,12000),pageHeight:state.geometry.height,
        geometry:select(state.geometry.elements,Math.min(70,geometryLimit))})),
      geometry:select(v.geometry.elements,geometryLimit),
    }))};
}
function relevantFiles(files:FileChange[],page:EvidencePage):FileChange[]{
  const pageFile=routeFile(page.route);
  return files.filter(f=>f.path===pageFile||f.path==='src/site.css'||f.path.startsWith('src/components/')||f.path.startsWith('src/styles/'));
}
function relevantAssets(evidence:Evidence,page:EvidencePage){
  const haystack=JSON.stringify(page.views.map(v=>({elements:v.geometry.elements.map(e=>({src:e.src,bg:e.style['background-image']})),interactions:(v.interactions??[]).map(i=>i.geometry.elements.map(e=>({src:e.src,bg:e.style['background-image']})))})));
  return evidence.assets.filter(a=>haystack.includes(a.original)).map(a=>({original:a.original.startsWith('data:')?'embedded asset':a.original,path:a.publicPath}));
}
function boundedFiles(files:FileChange[],page:EvidencePage,perFile=55000){
  return relevantFiles(files,page).map(f=>({path:f.path,content:clipped(f.content,perFile)}));
}
function visionFirstContext(evidence:Evidence,page:EvidencePage){
  const remap=(value:string|undefined)=>{let out=value??'';for(const asset of evidence.assets)if(out.includes(asset.original))out=out.split(asset.original).join(asset.publicPath);return clipped(out,260);};
  const outline=(elements:any[])=>elements.filter(e=>/^(header|nav|main|section|footer|form|h[1-6]|img|button|a)$/.test(e.tag))
    .slice(0,36).map(e=>({tag:e.tag,text:clipped(e.text,180),x:Math.round(e.x),y:Math.round(e.y),width:Math.round(e.width),height:Math.round(e.height),...(e.src?{src:remap(e.src)}:{}),...(e.attributes&&Object.keys(e.attributes).length?{attributes:e.attributes}:{})}));
  return {
    route:page.route,title:page.title,file:routeFile(page.route),
    fullVisibleText:clipped(page.views[0]?.geometry.text??'',14000),
    views:page.views.map((v,index)=>({viewport:v.viewport,pageHeight:v.geometry.height,outline:outline(v.geometry.elements),
      ...(index>0&&v.geometry.text!==page.views[0]?.geometry.text?{visibleTextOverride:clipped(v.geometry.text,5000)}:{}),
      interactions:(v.interactions??[]).slice(0,3).map(i=>({id:i.id,trigger:i.trigger,visibleText:clipped(i.geometry.text,2500)}))}))
  };
}
export function reconstructionPrompt(evidence:Evidence,page:EvidencePage,files:FileChange[],task:string):string{
  const assets=relevantAssets(evidence,page);
  const build=(geometryLimit:number,textLimit:number,fileLimit:number)=>JSON.stringify({task,sourceSite:evidence.site,routeMap:evidence.pages.map(p=>({route:p.route,file:routeFile(p.route)})),
    editable:['src/pages/<listed-route-file>.tsx','src/components/<name>.tsx','src/styles/<name>.css','src/site.css'],
    fonts:evidence.fontFaces.slice(0,40).map(f=>clipped(f,1800)),assets:assets.slice(0,160).map(a=>({original:clipped(a.original,320),path:a.path})),
    reference:pageContext(evidence,page,geometryLimit,textLimit),currentFiles:boundedFiles(files,page,fileLimit),warnings:evidence.warnings.slice(0,40),unresolvedIntegrations:evidence.blockers.slice(0,40),integrationInventory:evidence.integrations.filter(i=>i.route===page.route).slice(0,40)});
  for(const [g,t,f] of [[180,42000,42000],[110,28000,30000],[64,18000,20000],[36,12000,14000]] as const){
    const text=build(g,t,f); if(text.length<=300000)return text;
  }
  const visionFirst=JSON.stringify({
    task:task+' The attached desktop, tablet and mobile screenshots are the primary visual authority. Implement from the screenshots plus this compact structural outline.',
    sourceSite:evidence.site,routeMap:evidence.pages.map(p=>({route:p.route,file:routeFile(p.route)})),
    editable:['src/pages/<listed-route-file>.tsx','src/components/<name>.tsx','src/styles/<name>.css','src/site.css'],
    reference:visionFirstContext(evidence,page),
    assets:assets.slice(0,100).map(a=>a.path),
    fonts:evidence.fontFaces.slice(0,16).map(f=>clipped(f,900)),
    currentFiles:boundedFiles(files,page,12000).slice(0,8),
    warnings:evidence.warnings.slice(0,20),unresolvedIntegrations:evidence.blockers.slice(0,20),integrationInventory:evidence.integrations.filter(i=>i.route===page.route).slice(0,20)
  });
  if(visionFirst.length<=300000)return visionFirst;
  return JSON.stringify({
    task:task+' Use the attached screenshots as the primary visual authority. This source required an ultra-compact evidence fallback; prioritize visual fidelity, visible copy, responsive layout and local assets.',
    sourceSite:evidence.site,route:page.route,file:routeFile(page.route),title:page.title,
    visibleText:clipped(page.views[0]?.geometry.text??'',9000),
    viewports:page.views.map(v=>({viewport:v.viewport,pageHeight:v.geometry.height})),
    assets:assets.slice(0,60).map(a=>a.path),
    currentFiles:boundedFiles(files,page,8000).slice(0,6)
  });
}
/** One browser-evidence contract, one shared React workspace, one measured repair loop. */
export async function runReconstruction(options:AgentOptions):Promise<ReconstructionResult>{
  const model=options.model??modelFromEnv();
  const minutes=integer(process.env.MOLT_AGENT_MINUTES,30,1,120);
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(minutes*60000)]);
  await mkdir(options.workDir,{recursive:true});
  const run=await mkdtemp(join(options.workDir,'reconstruction-')),outDir=join(run,'site'),reportPath=join(run,'report.json');
  const progress=async(message:string)=>{await options.onProgress?.(message);};
  await progress('Capturing source evidence at desktop, tablet and mobile sizes');
  const evidence=await capture({url:options.url,urls:options.urls,bundleDir:options.bundleDir,directory:join(run,'source'),maxPages:options.maxPages,signal} satisfies CaptureOptions);
  const complexity=assessComplexity(evidence);
  await writeFile(join(run,'complexity.json'),JSON.stringify(complexity,null,2));
  await progress(`Source captured: ${complexity.pages.length} pages; planning complexity recorded (not a charge)`);
  await scaffold(outDir,evidence);await prepareToolchain(outDir);
  const allowed=new Set(evidence.pages.map(p=>routeFile(p.route)));
  for(const page of evidence.pages){
    signal.throwIfAborted();await progress(`Reconstructing ${page.route} with shared components`);
    const files=await snapshot(outDir),request={prompt:reconstructionPrompt(evidence,page,files,'Implement this page. Reuse shared components and styles; preserve previously implemented routes. Reproduce the observed menu, disclosure, accordion and tab states with accessible React behavior when interaction evidence is supplied.'),images:await referenceImages(page.views)};
    // A malformed first reply gets one self-correction opportunity with its exact validation error.
    let error='';let done=false;
    for(let attempt=0;attempt<2&&!done;attempt++){
      try{const reply=await model.complete({...request,prompt:request.prompt+(error?`\nPrevious reply was rejected: ${error}. Return corrected complete files.`:'')},signal);await apply(outDir,reply.files,allowed);const current=await snapshot(outDir);if(!current.some(f=>f.path===routeFile(page.route)))throw new Error('Requested page file was not produced');done=true;}
      catch(e){await restore(outDir,files);error=(e as Error).message;if(attempt===1)throw e;}
    }
  }
  const result=await repairLoop({
    snapshot:()=>snapshot(outDir),restore:(s:FileChange[])=>restore(outDir,s),digest,
    evaluate:async(round:number)=>{await progress(`Building and comparing every page/device (round ${round})`);return evaluate(outDir,evidence,join(run,`attempt-${round}`),signal);},
    propose:async(best,history,round)=>{
      const rank=(v:typeof best.views[number])=>Math.min(v.worstBand??101,...(v.interactions??[]).filter(i=>!i.pass).map(i=>i.worstBand??0));
      const worst=[...best.views].filter(v=>!v.pass).sort((a,b)=>rank(a)-rank(b))[0];
      const page=evidence.pages.find(p=>p.route===worst?.route)??evidence.pages[0];
      await progress(`Repairing ${page.route}; keeping passing pages and viewports intact`);
      const checks=best.views.filter(v=>v.route===page.route);
      const targets=checks.map(v=>({viewport:v.viewport,score:v.score,worstBand:v.worstBand,worstY:v.worstY,issues:v.issues.slice(0,12),interactions:(v.interactions??[]).filter(i=>!i.pass).map(i=>({name:i.trigger.name,score:i.score,worstBand:i.worstBand,worstY:i.worstY,issues:i.issues.slice(0,6)}))}));
      const historySummary=history.slice(-4).map(a=>({round:a.round,accepted:a.accepted,summary:a.summary,views:a.evaluation.views.filter(v=>v.route===page.route).map(v=>({viewport:v.viewport,score:v.score,worstBand:v.worstBand}))}));
      return model.complete({prompt:reconstructionPrompt(evidence,page,await snapshot(outDir),`Repair round ${round}. Target a measured 95%+ pixel match on every viewport without regressing any viewport. Current targets: ${JSON.stringify(targets)}. Recent attempts: ${JSON.stringify(historySummary)}. The attached DIFF heatmap and source/candidate crops show the worst measured bands. Fix the largest shared geometry/typography causes first, then viewport-specific spacing. Do not invent hidden content merely to satisfy diagnostics; reproduce what is actually visible in the reference screenshots. Keep correct regions intact.`),images:await repairImages(checks)},signal);
    },
    apply:reply=>apply(outDir,reply.files,allowed),
    save:async(best,attempts)=>{await writeFile(reportPath,JSON.stringify({status:best.pass&&!evidence.blockers.length?'review':'needs-work',outDir,evaluation:best,attempts,warnings:evidence.warnings,blockers:evidence.blockers,usage:model.usage},null,2));},
  },{maxRounds:options.maxRepairs??integer(process.env.MOLT_MAX_REPAIRS,6,0,20),signal});
  // Restore() changes source files. Never leave a rejected candidate in dist.
  await rm(join(outDir,'dist'),{recursive:true,force:true});
  const finalBuild=signal.aborted?{ok:false,log:'Run cancelled before final compilation'}:await build(outDir,AbortSignal.any([signal,AbortSignal.timeout(120000)]));
  await writeFile(join(run,'final-build.log'),finalBuild.log);
  if(!finalBuild.ok){result.evaluation={...result.evaluation,pass:false,issues:[...result.evaluation.issues,'Final compilation of the retained source did not succeed']};}
  const final:ReconstructionResult={complexity,status:result.evaluation.pass&&!evidence.blockers.length?'review':'needs-work',outDir,reportPath,...result,warnings:evidence.warnings,blockers:evidence.blockers,integrations:evidence.integrations,usage:model.usage,source:{site:evidence.site,assetCount:evidence.assets.length,pages:evidence.pages.map(p=>({route:p.route,title:p.title,sections:p.views[0].geometry.elements.filter(e=>/^(section|main|header|footer)$/.test(e.tag)).length,elements:p.views[0].geometry.elements.length}))}};
  await writeFile(reportPath,JSON.stringify(final,null,2));
  await writeReview(join(run,'review.html'),final);
  await progress(final.status==='review'?'Measured visual checks passed; ready for human review':'Best measured reconstruction retained with unresolved differences');
  return final;
}
