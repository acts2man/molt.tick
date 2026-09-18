/** The runner authenticates to Netlify with GitHub OIDC, never a token in workflow inputs. */
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { PNG } from 'pngjs';
import { runReconstruction } from '../src/reconstruct/agent.js';
import { modelFromEnv } from '../src/reconstruct/provider.js';
import type { Model } from '../src/reconstruct/types.js';
let liveModel:Model|undefined;

const origin=process.env.MOLT_STUDIO_ORIGIN??'',id=process.env.MOLT_JOB_ID??'';
if(origin!=='https://moltick.netlify.app'||!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid studio job configuration');
const artifacts=resolve('studio-artifacts');await mkdir(artifacts,{recursive:true});
async function identityToken():Promise<string>{
  const endpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!endpoint||!secret)throw new Error('The workflow needs GitHub id-token: write permission.');
  const response=await fetch(`${endpoint}&audience=${encodeURIComponent(origin)}`,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not obtain the runner identity.');
  const data=await response.json() as {value:string};return data.value;
}
async function studio(path:string,init:RequestInit={}):Promise<Response>{
  const token=await identityToken();
  const response=await fetch(`${origin}/api/molt/runner/${id}${path}`,{...init,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${token}`,...init.headers}});
  if(!response.ok)throw new Error(`Studio callback failed (HTTP ${response.status}): ${(await response.text()).slice(0,400)}`);
  return response;
}
function redacted(message:string):string{let text=message;for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','ACTIONS_ID_TOKEN_REQUEST_TOKEN']){const value=process.env[key];if(value)text=text.split(value).join('[redacted]');}return text;}
async function progress(message:string,extra:object={}):Promise<void>{
  const clean=redacted(message);console.log(clean);
  await studio('/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:clean,...extra})});
}
function pathIn(root:string,file:string):string{
  if(file.startsWith('/')||file.includes('\\')||file.split('/').some(p=>!p||p.startsWith('.')))throw new Error('Unsafe saved-page path');
  const full=resolve(root,file),r=relative(root,full);if(r.startsWith('..'))throw new Error('Saved file escaped the bundle');return full;
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
  const job=await (await studio('')).json() as {sourceUrl:string;pages:string[];bundleId?:string;model:string;reasoningEffort:'low'|'medium'|'high';maxPages:number;maxRepairs:number};
  if(job.model)process.env.MOLT_AI_MODEL=job.model;
  if(job.reasoningEffort)process.env.MOLT_REASONING_EFFORT=job.reasoningEffort;
  await progress(`Runner connected. Using ${job.model||process.env.MOLT_AI_MODEL} with ${job.reasoningEffort||process.env.MOLT_REASONING_EFFORT||'default'} reasoning.`);
  if(!process.env.MOLT_AI_MODEL||!(process.env.MOLT_MODEL_PROVIDER==='anthropic'?process.env.ANTHROPIC_API_KEY:process.env.OPENAI_API_KEY))throw new Error('Model configuration is missing. Open Connections in Molt Studio.');
  let bundleDir:string|undefined;
  if(job.bundleId){
    await progress('Retrieving the saved-page bundle.');bundleDir=resolve('studio-work/bundle');await mkdir(bundleDir,{recursive:true});
    const manifest=await (await studio('/bundle')).json() as {files:{path:string;size:number}[]};
    if(manifest.files.length>300)throw new Error('Bundle has too many files');let total=0;
    for(const f of manifest.files){if(f.size>4_000_000||(total+=f.size)>50_000_000)throw new Error('Bundle size limit exceeded');const dest=pathIn(bundleDir,f.path);await mkdir(dirname(dest),{recursive:true});const bytes=await (await studio(`/bundle?file=${encodeURIComponent(f.path)}`)).arrayBuffer();if(bytes.byteLength!==f.size)throw new Error('Bundle file size mismatch');await writeFile(dest,Buffer.from(bytes));}
  }
  liveModel=modelFromEnv();
  const result=await runReconstruction({model:liveModel,...(bundleDir?{bundleDir}:{url:job.sourceUrl,urls:job.pages.length?job.pages:undefined}),workDir:resolve('studio-work/reconstruction'),maxPages:job.maxPages,maxRepairs:job.maxRepairs,onProgress:message=>progress(message)});
  await progress('Preparing comparison images and the retained React source.');
  const report=JSON.parse(JSON.stringify(result));
  for(let i=0;i<report.evaluation.views.length;i++){
    const view=report.evaluation.views[i];view.sourceImage=view.source?await preview(view.source,`view-${i}-source.png`):null;view.candidateImage=view.candidate?await preview(view.candidate,`view-${i}-react.png`):null;view.diffImage=view.diff?await preview(view.diff,`view-${i}-diff.png`):null;
    for(let stateIndex=0;stateIndex<(view.interactions??[]).length;stateIndex++){
      const state=view.interactions[stateIndex],prefix=`view-${i}-state-${stateIndex}`;
      state.sourceImage=state.source?await preview(state.source,`${prefix}-source.png`):null;
      state.candidateImage=state.candidate?await preview(state.candidate,`${prefix}-react.png`):null;
      state.diffImage=state.diff?await preview(state.diff,`${prefix}-diff.png`):null;
    }
  }
  await cp(result.outDir,join(artifacts,'react-project'),{recursive:true,filter:source=>!source.split(/[\\/]/).some(s=>s==='node_modules'||s==='.git'||s==='dist')});
  await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2));
  await writeFile(join(artifacts,'READ-ME.txt'),'This is actual Molt output. Review report.json before using it. Passing pixel metrics do not migrate form backends, identity, payment services or other integrations. The downloadable artifact excludes font binaries; obtain any required fonts from their original authorized source. The runner retained the best measured React source, not a claimed universally exact result.\n');
  await progress(result.status==='review'?'Measured checks passed. Your reconstruction is ready for review.':'The best reconstruction is saved. Differences or integrations still need attention.',{report});
  if(result.status!=='review')process.exitCode=2;
}catch(error){
  const message=redacted(error instanceof Error?error.message:String(error));
  await writeFile(join(artifacts,'error.json'),JSON.stringify({error:message,usage:liveModel?.usage},null,2));
  try{await progress(message,{error:message,usage:liveModel?.usage});}catch(callbackError){console.error('Could not persist final status:',redacted((callbackError as Error).message));}
  console.error(message);process.exitCode=1;
}
