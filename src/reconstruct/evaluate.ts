import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, build, restrictNetwork, serve } from './runtime.js';
import { activateInteraction, geometry, settle } from './capture.js';
import { compare } from './images.js';
import { routeFile } from './policy.js';
import type { Evidence, Evaluation, ViewCheck, Geometry } from './types.js';

const normalize=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
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
    for(const property of ['font-family','font-size','font-weight','line-height','letter-spacing'])if(original.style[property]!==actual.style[property])mismatches.push(property);
    if(mismatches.length)problems.push(`Heading ${original.text}: ${mismatches.join(', ')} differ`);
  }
  if(Math.abs(source.height-candidate.height)>Math.max(3,source.height*0.005))problems.push(`Page height differs: source ${source.height}px, generated ${candidate.height}px`);
  return problems;
}
export function emptyEvaluation(evidence:Evidence,issue:string):Evaluation{
  return {pass:false,issues:[issue],views:evidence.pages.flatMap(p=>p.views.map(v=>({route:p.route,viewport:v.viewport.name,score:null,worstBand:null,pass:false,issues:[issue],source:v.screenshot})))};
}
export async function evaluate(outDir:string,evidence:Evidence,directory:string,signal:AbortSignal,threshold=95,bandThreshold=85):Promise<Evaluation>{
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
        check.issues.push(...contentIssues(reference.geometry,generated),...errors);
        // Literal DOM links are checked after rendering, including shared components.
        const known=new Set(evidence.pages.map(p=>p.route));
        for(const link of generated.links){const url=new URL(link);if(url.origin!==host.origin)continue;const route=url.pathname.replace(/\/+$/,'')||'/';if(!known.has(route)&&!url.pathname.startsWith('/assets/'))check.issues.push(`Unresolved internal link: ${route}`);}
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
            stateCheck.issues.push(...contentIssues(state.geometry,stateGenerated));
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
