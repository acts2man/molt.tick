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
function pageContext(evidence:Evidence,page:EvidencePage):unknown{
  const remap=(s:string)=>{for(const asset of evidence.assets)if(s.includes(asset.original))s=s.split(asset.original).join(asset.publicPath);return s;};
  return {route:page.route,title:page.title,file:routeFile(page.route),views:page.views.map(v=>({
    viewport:v.viewport,fullVisibleText:v.geometry.text,pageHeight:v.geometry.height,mediaQueries:v.geometry.mediaQueries,
    interactions:(v.interactions??[]).map(state=>({id:state.id,trigger:state.trigger,visibleText:state.geometry.text,pageHeight:state.geometry.height,
      geometry:state.geometry.elements.filter(e=>e.text||e.src||e.svg||e.attributes?.['aria-expanded']||e.attributes?.['aria-selected']||/^(nav|dialog|details)$/.test(e.tag)).slice(0,180).map(e=>JSON.parse(remap(JSON.stringify(e))))})),
    // All visible copy is retained. Geometry is prioritized separately, never used to trim copy.
    geometry:v.geometry.elements.filter(e=>e.text||e.src||e.svg||/^(section|header|footer|main|nav)$/.test(e.tag)||e.style['background-image']!=='none').slice(0,450).map(e=>JSON.parse(remap(JSON.stringify(e)))),
  }))};
}
function prompt(evidence:Evidence,page:EvidencePage,files:FileChange[],task:string):string{
  const text=JSON.stringify({task,sourceSite:evidence.site,routeMap:evidence.pages.map(p=>({route:p.route,file:routeFile(p.route)})),
    editable:['src/pages/<listed-route-file>.tsx','src/components/<name>.tsx','src/styles/<name>.css','src/site.css'],
    fonts:evidence.fontFaces,assets:evidence.assets.map(a=>({original:a.original.startsWith('data:')?'embedded asset':a.original,path:a.publicPath})),
    reference:pageContext(evidence,page),currentFiles:files,warnings:evidence.warnings,unresolvedIntegrations:evidence.blockers});
  if(text.length>390000)throw new Error('Page evidence exceeds the context budget; split this source into smaller pages');return text;
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
    const files=await snapshot(outDir),request={prompt:prompt(evidence,page,files,'Implement this page. Reuse shared components and styles; preserve previously implemented routes. Reproduce the observed menu, disclosure, accordion and tab states with accessible React behavior when interaction evidence is supplied.'),images:await referenceImages(page.views)};
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
      const worst=[...best.views].filter(v=>!v.pass).sort((a,b)=>(a.worstBand??-1)-(b.worstBand??-1))[0];
      const page=evidence.pages.find(p=>p.route===worst?.route)??evidence.pages[0];
      await progress(`Repairing ${page.route}; keeping passing pages and viewports intact`);
      const checks=best.views.filter(v=>v.route===page.route);
      return model.complete({prompt:prompt(evidence,page,await snapshot(outDir),`Repair round ${round}. Measured results: ${JSON.stringify(best)}. Previous attempts: ${JSON.stringify(history.map(a=>({round:a.round,accepted:a.accepted,summary:a.summary})))}. Fix compile errors first, then the worst mismatch. Do not change correct pages.`),images:await repairImages(checks)},signal);
    },
    apply:reply=>apply(outDir,reply.files,allowed),
    save:async(best,attempts)=>{await writeFile(reportPath,JSON.stringify({status:best.pass&&!evidence.blockers.length?'review':'needs-work',outDir,evaluation:best,attempts,warnings:evidence.warnings,blockers:evidence.blockers,usage:model.usage},null,2));},
  },{maxRounds:options.maxRepairs??integer(process.env.MOLT_MAX_REPAIRS,6,0,20),signal});
  // Restore() changes source files. Never leave a rejected candidate in dist.
  await rm(join(outDir,'dist'),{recursive:true,force:true});
  const finalBuild=signal.aborted?{ok:false,log:'Run cancelled before final compilation'}:await build(outDir,AbortSignal.any([signal,AbortSignal.timeout(120000)]));
  await writeFile(join(run,'final-build.log'),finalBuild.log);
  if(!finalBuild.ok){result.evaluation={...result.evaluation,pass:false,issues:[...result.evaluation.issues,'Final compilation of the retained source did not succeed']};}
  const final:ReconstructionResult={complexity,status:result.evaluation.pass&&!evidence.blockers.length?'review':'needs-work',outDir,reportPath,...result,warnings:evidence.warnings,blockers:evidence.blockers,usage:model.usage,source:{site:evidence.site,assetCount:evidence.assets.length,pages:evidence.pages.map(p=>({route:p.route,title:p.title,sections:p.views[0].geometry.elements.filter(e=>/^(section|main|header|footer)$/.test(e.tag)).length,elements:p.views[0].geometry.elements.length}))}};
  await writeFile(reportPath,JSON.stringify(final,null,2));
  await writeReview(join(run,'review.html'),final);
  await progress(final.status==='review'?'Measured visual checks passed; ready for human review':'Best measured reconstruction retained with unresolved differences');
  return final;
}
