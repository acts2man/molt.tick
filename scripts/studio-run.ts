/** The runner authenticates to Netlify with GitHub OIDC, never a token in workflow inputs. */
import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { runReconstruction } from '../src/reconstruct/agent.js';
import { modelFromEnv } from '../src/reconstruct/provider.js';
import type { Model } from '../src/reconstruct/types.js';
import { availableAgentMinutes, productionRunBudget } from '../src/reconstruct/budgets.js';
import { reserveOutputRepository, publishReservedOutputRepository, deleteReservedOutputRepository } from './publish-output.js';
import { preflightNetlify, createNetlifySite, deployNetlifyDirectory, configureContinuousNetlifyDeploy, deleteNetlifySite, type NetlifySite } from './publish-netlify.js';
import { finalStudioEvent } from './studio-report.js';
import { runnerFetch } from './runner-callback.js';
let liveModel:Model|undefined,runnerIdentityCache:{token:string;expiresAt:number}|undefined;
let reservedRepository:string|undefined,reservedSite:NetlifySite|undefined,publishedSource=false;

const origin=process.env.MOLT_STUDIO_ORIGIN??'',id=process.env.MOLT_JOB_ID??'';
if(origin!=='https://moltick.netlify.app'||!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid studio job configuration');
const runnerStartedAt=Date.now();
const artifacts=resolve('studio-artifacts');await mkdir(artifacts,{recursive:true});
let progressFloor=1,progressStage='Submitting',progressRepairRounds=4;
function milestone(message:string):{progress:number;stage:string}|null{
  const lower=message.toLowerCase();
  if(lower.includes('runner connected'))return {progress:4,stage:'Starting runner'};
  if(lower.includes('fresh runner identity verified'))return {progress:6,stage:'Verifying runner'};
  if(lower.includes('reserved output repository'))return {progress:9,stage:'Preparing delivery'};
  if(lower.includes('zero-cost delivery preflight passed'))return {progress:12,stage:'Preflight complete'};
  if(lower.includes('paid-model guard armed'))return {progress:14,stage:'Preparing model'};
  if(lower.includes('retrieving the saved-page bundle'))return {progress:16,stage:'Loading source files'};
  if(lower.includes('capturing source evidence'))return {progress:20,stage:'Capturing website'};
  if(lower.startsWith('source captured:'))return {progress:30,stage:'Analyzing source'};
  if(lower.startsWith('reconstructing '))return {progress:38,stage:'Generating React'};
  const build=/building and comparing every page\/device \(round (\d+)\)/i.exec(message);
  if(build){
    const round=Number(build[1]);
    if(round===0)return {progress:52,stage:'Measuring first build'};
    const progress=Math.min(82,56+Math.round((round/Math.max(1,progressRepairRounds))*26));
    return {progress,stage:`Measuring repair round ${round}`};
  }
  if(lower.startsWith('repairing '))return {progress:Math.min(81,Math.max(56,progressFloor+1)),stage:'Repairing visual differences'};
  const repair=/repair round (\d+)\s+(accepted|not applied)/i.exec(message);
  if(repair){
    const round=Number(repair[1]),progress=Math.min(83,57+Math.round((round/Math.max(1,progressRepairRounds))*26));
    return {progress,stage:`Reviewing repair round ${round}`};
  }
  if(lower.includes('measured visual checks passed')||lower.includes('best measured reconstruction retained'))return {progress:84,stage:'Visual reconstruction complete'};
  if(lower.includes('core react reconstruction checkpointed'))return {progress:86,stage:'Saving reconstruction'};
  if(lower.includes('building the interactive preview'))return {progress:88,stage:'Building live preview'};
  if(lower.includes('uploading interactive preview'))return {progress:90,stage:'Uploading live preview'};
  if(lower.includes('interactive preview is ready'))return {progress:92,stage:'Live preview ready'};
  if(lower.includes('publishing retained react source'))return {progress:94,stage:'Publishing GitHub repository'};
  if(lower.includes('github repository published'))return {progress:96,stage:'Repository published'};
  if(lower.includes('connecting the reserved netlify'))return {progress:97,stage:'Deploying live website'};
  if(lower.includes('live site deployed and connected'))return {progress:99,stage:'Live website ready'};
  if(lower.includes('ready for review')||lower.includes('reconstruction is saved'))return {progress:100,stage:'Complete'};
  return null;
}
function jwtExpiry(token:string):number{
  try{const payload=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString('utf8')) as {exp?:number};return Number.isFinite(payload.exp)?Number(payload.exp)*1000:0;}catch{return 0;}
}
async function identityToken(force=false):Promise<string>{
  if(!force&&runnerIdentityCache&&runnerIdentityCache.expiresAt>Date.now()+60_000)return runnerIdentityCache.token;
  const endpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!endpoint||!secret)throw new Error('The workflow needs GitHub id-token: write permission.');
  const response=await fetch(`${endpoint}&audience=${encodeURIComponent(origin)}`,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not obtain the runner identity.');
  const data=await response.json() as {value:string};const expiresAt=jwtExpiry(data.value)||Date.now()+120_000;
  runnerIdentityCache={token:data.value,expiresAt};return data.value;
}
async function studio(path:string,init:RequestInit={}):Promise<Response>{
  return runnerFetch({origin,id,path,init,getToken:async force=>{if(force)runnerIdentityCache=undefined;return identityToken(force);}});
}
function redacted(message:string):string{let text=message;for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','ACTIONS_ID_TOKEN_REQUEST_TOKEN','MOLT_GITHUB_EXPORT_TOKEN','MOLT_NETLIFY_AUTH_TOKEN']){const value=process.env[key];if(value)text=text.split(value).join('[redacted]');}return text;}
async function progress(message:string,extra:object={},required=true):Promise<void>{
  const clean=redacted(message),next=milestone(clean);
  if(next&&next.progress>=progressFloor){progressFloor=next.progress;progressStage=next.stage;}
  console.log(clean);
  try{await studio('/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:clean,progress:progressFloor,progressStage,...extra})});}
  catch(error){const note='Studio callback warning: '+redacted(error instanceof Error?error.message:String(error));console.warn(note);if(required)throw error;}
}
function pathIn(root:string,file:string):string{
  if(file.startsWith('/')||file.includes('\\')||file.split('/').some(p=>!p||p.startsWith('.')))throw new Error('Unsafe saved-page path');
  const full=resolve(root,file),r=relative(root,full);if(r.startsWith('..'))throw new Error('Saved file escaped the bundle');return full;
}
async function run(command:string,args:string[],cwd:string,env:Record<string,string|undefined>={},timeoutMs=120000):Promise<void>{
  await new Promise<void>((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let err='',settled=false;
    const timer=setTimeout(()=>{if(settled)return;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();settled=true;reject(new Error(`${command} timed out after ${Math.round(timeoutMs/1000)}s`));},timeoutMs);
    timer.unref();
    const finish=(fn:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);fn();};
    child.stderr.on('data',b=>{if(err.length<8000)err+=String(b);});
    child.on('error',error=>finish(()=>reject(error)));child.on('close',code=>finish(()=>code===0?resolveRun():reject(new Error(`${command} failed (exit ${code}): ${err.slice(0,1200)}`))));
  });
}
async function previewFiles(root:string):Promise<Array<{path:string;file:string;size:number}>>{
  const out:Array<{path:string;file:string;size:number}>=[],allowed=/\.(html?|css|js|json|png|jpe?g|svg|webp|gif|avif|ico|woff2?|ttf|otf)$/i,walk=async(dir:string)=>{
    for(const entry of await readdir(dir,{withFileTypes:true})){const full=join(dir,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile()){
      const path=relative(root,full).split('\\').join('/');if(!allowed.test(path))continue;
      const size=(await stat(full)).size;
      if(size>8_000_000)throw new Error(`Preview file is too large: ${path}`);out.push({path,file:full,size});
    }}
  };await walk(root);return out;
}
async function uploadInteractivePreview(outDir:string):Promise<void>{
  const base=`/api/molt/preview/${id}/`;
  await progress('Building the interactive preview.');
  await run('npm',['run','build'],outDir,{MOLT_PREVIEW_BASE:base});
  const root=join(outDir,'dist'),files=await previewFiles(root);
  const total=files.reduce((n,f)=>n+f.size,0);if(files.length>400||total>35_000_000)throw new Error('Interactive preview exceeds the safe upload budget.');
  await progress(`Uploading interactive preview (${files.length} files).`);
  for(const item of files){const data=await readFile(item.file);await studio(`/preview?file=${encodeURIComponent(item.path)}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:new Uint8Array(data)});}
  await progress('Interactive preview is ready inside Molt.',{previewReady:true});
}
async function preview(file:string,name:string):Promise<string|null>{
  try{
    const source=PNG.sync.read(await readFile(file));
    const scale=Math.min(1,900/source.width,10000/source.height);
    const image=new PNG({width:Math.max(1,Math.round(source.width*scale)),height:Math.max(1,Math.round(source.height*scale))});
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
      const from=(Math.min(source.height-1,Math.floor(y/scale))*source.width+Math.min(source.width-1,Math.floor(x/scale)))*4,to=(y*image.width+x)*4;
      source.data.copy(image.data,to,from,from+4);
    }
    const bytes=PNG.sync.write(image);if(bytes.length>4_000_000)return null;
    await studio(`/images/${name}`,{method:'PUT',headers:{'content-type':'image/png'},body:new Uint8Array(bytes)});return name;
  }catch(error){console.warn(`Preview upload unavailable: ${redacted((error as Error).message)}`);return null;}
}
try{
  const job=await (await studio('')).json() as {sourceUrl:string;pages:string[];bundleId?:string;model:string;reasoningEffort:'low'|'medium'|'high'|'xhigh'|'max';outputRepo:string;maxPages:number;maxRepairs:number};
  const budget=productionRunBudget(job.maxPages,job.maxRepairs,job.reasoningEffort);
  progressRepairRounds=Math.max(1,budget.repairRounds||1);
  if(job.model)process.env.MOLT_AI_MODEL=job.model;
  if(job.reasoningEffort)process.env.MOLT_REASONING_EFFORT=job.reasoningEffort;
  process.env.MOLT_MODEL_TIMEOUT_MS=String(budget.requestMs);
  process.env.MOLT_AI_MAX_TOKENS=String(budget.maxOutputTokens);
  process.env.MOLT_MAX_MODEL_CALLS=String(budget.maxModelCalls);
  process.env.MOLT_MAX_TRANSPORT_ATTEMPTS=String(budget.maxTransportAttempts);
  await progress(`Runner connected. Using ${job.model||process.env.MOLT_AI_MODEL} with ${job.reasoningEffort||process.env.MOLT_REASONING_EFFORT||'default'} reasoning. Runtime envelope: ${budget.runnerMinutes} runner minutes with ${budget.deliveryReserveMinutes} minutes reserved for checkpoint/export/deploy; reconstruction may use up to ${budget.agentMinutes} minutes, ${budget.repairRounds} measured repair calls, ${budget.maxModelCalls} logical model calls, and ${budget.maxTransportAttempts} bounded provider transport attempts.`);
  if(!process.env.MOLT_AI_MODEL||!(process.env.MOLT_MODEL_PROVIDER==='anthropic'?process.env.ANTHROPIC_API_KEY:process.env.OPENAI_API_KEY))throw new Error('Model configuration is missing. Open Connections in Molt Studio.');
  // Everything below this preflight is still zero-cost. Prove runner rotation, Blob writes and GitHub export access before the first model request.
  runnerIdentityCache=undefined;
  await progress('Zero-cost preflight: fresh runner identity verified.');
  await studio('/preview?file=preflight.json',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:new TextEncoder().encode(JSON.stringify({job:id,at:new Date().toISOString()}))});
  const plannedRepo=await reserveOutputRepository(process.cwd(),'acts2man',job.outputRepo,process.env.MOLT_GITHUB_EXPORT_TOKEN??'');reservedRepository=plannedRepo.repository;
  await progress(`Reserved output repository and proved workflow/secret access: ${plannedRepo.repository}`,{outputRepoUrl:plannedRepo.url,reservedOutputRepository:plannedRepo.repository});
  await preflightNetlify(process.env.MOLT_NETLIFY_TEAM_SLUG??'',process.env.MOLT_NETLIFY_AUTH_TOKEN??'');
  const plannedSite=await createNetlifySite(process.env.MOLT_NETLIFY_TEAM_SLUG??'',plannedRepo.repository.split('/')[1],process.env.MOLT_NETLIFY_AUTH_TOKEN??'');reservedSite=plannedSite;
  await progress(`Reserved Netlify site for delivery: ${plannedSite.name}`,{reservedNetlifySiteId:plannedSite.id});
  const netlifyProbeDir=resolve('studio-work/netlify-preflight');await mkdir(netlifyProbeDir,{recursive:true});
  await writeFile(join(netlifyProbeDir,'index.html'),'<!doctype html><meta name="robots" content="noindex"><title>Molt delivery preflight</title><p>Molt reserved this deployment target before reconstruction.</p>');
  await deployNetlifyDirectory(netlifyProbeDir,plannedSite.id,process.env.MOLT_NETLIFY_AUTH_TOKEN??'');
  const netlifyProbe=await fetch(plannedSite.url,{redirect:'follow',signal:AbortSignal.timeout(15000)});
  if(!netlifyProbe.ok)throw new Error(`Netlify reserved-site deploy preflight returned HTTP ${netlifyProbe.status} before model usage.`);
  await writeFile(join(artifacts,'handoff.json'),JSON.stringify({outputRepoUrl:plannedRepo.url,reservedNetlifySite:plannedSite},null,2));
  await progress(`Zero-cost delivery preflight passed. Reserved ${plannedRepo.repository}, proved GitHub workflow/secret access, and deployed a placeholder to Netlify site ${plannedSite.name}; no model usage has occurred yet.`,{outputRepoUrl:plannedRepo.url,reservedOutputRepository:plannedRepo.repository,reservedNetlifySiteId:plannedSite.id});
  await progress(`Paid-model guard armed: at most ${budget.maxModelCalls} logical model calls. Transient network/rate-limit retries use a separate bounded transport budget of ${budget.maxTransportAttempts} attempts and no longer consume reconstruction-call capacity.`);
  let bundleDir:string|undefined;
  if(job.bundleId){
    await progress('Retrieving the saved-page bundle.');bundleDir=resolve('studio-work/bundle');await mkdir(bundleDir,{recursive:true});
    const manifest=await (await studio('/bundle')).json() as {files:{path:string;size:number;parts?:number}[]};
    if(manifest.files.length>BUNDLE_MAX_FILES)throw new Error('Bundle has too many files');let total=0;
    for(const f of manifest.files){
      if(f.size>BUNDLE_MAX_FILE_BYTES||(total+=f.size)>BUNDLE_MAX_TOTAL_BYTES)throw new Error('Bundle size limit exceeded');
      const dest=pathIn(bundleDir,f.path);await mkdir(dirname(dest),{recursive:true});
      const parts=Math.max(1,Math.ceil(f.size/BUNDLE_CHUNK_BYTES)),chunks:Buffer[]=[];let received=0;
      for(let part=0;part<parts;part++){
        const response=await studio(`/bundle?file=${encodeURIComponent(f.path)}${parts>1?`&part=${part}`:''}`);
        const bytes=Buffer.from(await response.arrayBuffer()),expected=part===parts-1?f.size-part*BUNDLE_CHUNK_BYTES:BUNDLE_CHUNK_BYTES;
        if(bytes.length!==expected)throw new Error(`Bundle file chunk size mismatch for ${f.path} (${part+1}/${parts})`);
        chunks.push(bytes);received+=bytes.length;
      }
      if(received!==f.size)throw new Error('Bundle file size mismatch');
      await writeFile(dest,Buffer.concat(chunks,received));
    }
  }
  const elapsedBeforeModel=Date.now()-runnerStartedAt;
  const availableMinutes=availableAgentMinutes(budget.agentMinutes,budget.runnerMinutes,budget.deliveryReserveMinutes,elapsedBeforeModel);
  if(availableMinutes<5)throw new Error(`Preflight/source preparation consumed too much of the runner envelope to safely start paid reconstruction while preserving the ${budget.deliveryReserveMinutes}-minute delivery reserve.`);
  process.env.MOLT_AGENT_MINUTES=String(availableMinutes);
  if(availableMinutes<budget.agentMinutes)await progress(`Runtime guard reduced reconstruction to ${availableMinutes} minutes so the ${budget.deliveryReserveMinutes}-minute delivery reserve remains protected.`);
  liveModel=modelFromEnv();
  const result=await runReconstruction({model:liveModel,...(bundleDir?{bundleDir,url:job.sourceUrl,urls:job.pages.length?job.pages:undefined}:{url:job.sourceUrl,urls:job.pages.length?job.pages:undefined}),workDir:resolve('studio-work/reconstruction'),maxPages:job.maxPages,maxRepairs:job.maxRepairs,onProgress:message=>progress(message,{},false)});
  // Checkpoint the expensive work before any nonessential callback, preview, or export step.
  await cp(result.outDir,join(artifacts,'react-project'),{recursive:true,filter:source=>!source.split(/[\\/]/).some(s=>s==='node_modules'||s==='.git'||s==='dist')});
  await writeFile(join(artifacts,'report.json'),JSON.stringify(result,null,2));
  await writeFile(join(artifacts,'READ-ME.txt'),'This is actual Molt output. Review report.json before using it. Passing pixel metrics do not migrate form backends, identity, payment services or other integrations. The downloadable artifact excludes font binaries; obtain any required fonts from their original authorized source. The runner retained the best measured React source, not a claimed universally exact result.\n');
  await progress('Core React reconstruction checkpointed; beginning reserved delivery phase.',{},false);
  const report=JSON.parse(JSON.stringify(result));
  const finalExtras:{previewReady?:boolean;outputRepoUrl?:string;outputRepoError?:string;liveSiteUrl?:string;liveSiteAdminUrl?:string;deploymentError?:string}={outputRepoUrl:plannedRepo.url};
  try{
    await progress(`Publishing retained React source to ${plannedRepo.repository}`,{},false);
    const published=await publishReservedOutputRepository(result.outDir,plannedRepo.repository,process.env.MOLT_GITHUB_EXPORT_TOKEN??'');
    publishedSource=true;finalExtras.outputRepoUrl=published.url;
    await writeFile(join(artifacts,'handoff.json'),JSON.stringify(finalExtras,null,2));
    await progress(`GitHub repository published: ${published.repository}`,{outputRepoUrl:published.url,sourcePublished:true},false);
    await progress('Connecting the reserved Netlify production site to the generated repository.',{},false);
    const deployed=await configureContinuousNetlifyDeploy(result.outDir,published.repository,plannedSite,process.env.MOLT_GITHUB_EXPORT_TOKEN??'',process.env.MOLT_NETLIFY_AUTH_TOKEN??'');
    finalExtras.liveSiteUrl=deployed.url;finalExtras.liveSiteAdminUrl=deployed.adminUrl;
    await writeFile(join(artifacts,'handoff.json'),JSON.stringify(finalExtras,null,2));
    await progress(`Live site deployed and connected: ${deployed.url}`,{liveSiteUrl:deployed.url,liveSiteAdminUrl:deployed.adminUrl},false);
  }catch(exportError){
    const outputRepoError='React source was built, but the repository/deployment handoff failed: '+redacted(exportError instanceof Error?exportError.message:String(exportError));
    finalExtras.outputRepoError=outputRepoError;finalExtras.deploymentError=outputRepoError;
    await writeFile(join(artifacts,'handoff.json'),JSON.stringify(finalExtras,null,2));
    await progress(outputRepoError,{outputRepoError},false);
  }
  const runnerRemainingMinutes=()=>Math.max(0,budget.runnerMinutes-(Date.now()-runnerStartedAt)/60000);
  if(runnerRemainingMinutes()>=5){
    await progress('Critical source/deployment handoff complete; preparing optional review assets with remaining reserve.',{},false);
    for(let i=0;i<report.evaluation.views.length&&runnerRemainingMinutes()>=3;i++){
      const view=report.evaluation.views[i];view.sourceImage=view.source?await preview(view.source,`view-${i}-source.png`):null;view.candidateImage=view.candidate?await preview(view.candidate,`view-${i}-react.png`):null;view.diffImage=view.diff?await preview(view.diff,`view-${i}-diff.png`):null;
      for(let stateIndex=0;stateIndex<(view.interactions??[]).length&&runnerRemainingMinutes()>=3;stateIndex++){
        const state=view.interactions[stateIndex],prefix=`view-${i}-state-${stateIndex}`;
        state.sourceImage=state.source?await preview(state.source,`${prefix}-source.png`):null;
        state.candidateImage=state.candidate?await preview(state.candidate,`${prefix}-react.png`):null;
        state.diffImage=state.diff?await preview(state.diff,`${prefix}-diff.png`):null;
      }
    }
    if(runnerRemainingMinutes()>=3){
      try{await uploadInteractivePreview(result.outDir);finalExtras.previewReady=true;await writeFile(join(artifacts,'handoff.json'),JSON.stringify(finalExtras,null,2));}
      catch(previewError){await progress('Interactive preview could not be prepared: '+redacted(previewError instanceof Error?previewError.message:String(previewError)),{},false);}
    }else await progress('Skipped interactive preview to preserve finalization headroom.',{},false);
  }else await progress('Skipped optional review assets to preserve finalization headroom.',{},false);
  await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2));
  await writeFile(join(artifacts,'handoff.json'),JSON.stringify(finalExtras,null,2));
  const {message:finalMessage,...finalPayload}=finalStudioEvent(report,finalExtras);
  await progress(finalMessage,finalPayload,false);
  if(result.status!=='review')process.exitCode=2;
}catch(error){
  if(!publishedSource){
    if(reservedSite)await deleteNetlifySite(reservedSite.id,process.env.MOLT_NETLIFY_AUTH_TOKEN??'');
    if(reservedRepository)await deleteReservedOutputRepository(process.cwd(),reservedRepository,process.env.MOLT_GITHUB_EXPORT_TOKEN??'');
  }
  const message=redacted(error instanceof Error?error.message:String(error));
  await writeFile(join(artifacts,'error.json'),JSON.stringify({error:message,usage:liveModel?.usage},null,2));
  await progress(message,{error:message,usage:liveModel?.usage},false);
  console.error(message);process.exitCode=1;
}
