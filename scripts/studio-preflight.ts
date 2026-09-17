/** Model-free owner preflight runner. Uses GitHub OIDC to return measured scope to Molt Studio. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { runPreflight } from '../src/reconstruct/preflight.js';

const origin=process.env.MOLT_STUDIO_ORIGIN??'',id=process.env.MOLT_JOB_ID??'';
if(origin!=='https://moltick.netlify.app'||!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid studio preflight configuration');
const artifacts=resolve('preflight-artifacts');await mkdir(artifacts,{recursive:true});

async function identityToken():Promise<string>{
  const endpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!endpoint||!secret)throw new Error('The workflow needs GitHub id-token: write permission.');
  const response=await fetch(`${endpoint}&audience=${encodeURIComponent(origin)}`,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not obtain the runner identity.');
  return ((await response.json()) as {value:string}).value;
}
async function studio(path:string,init:RequestInit={}):Promise<Response>{
  const token=await identityToken(),response=await fetch(`${origin}/api/molt/runner/${id}${path}`,{...init,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${token}`,...init.headers}});
  if(!response.ok)throw new Error(`Studio callback failed (HTTP ${response.status}): ${(await response.text()).slice(0,400)}`);
  return response;
}
function pathIn(root:string,file:string):string{
  if(file.startsWith('/')||file.includes('\\')||file.split('/').some(p=>!p||p.startsWith('.')))throw new Error('Unsafe saved-page path');
  const full=resolve(root,file),r=relative(root,full);if(r.startsWith('..'))throw new Error('Saved file escaped the bundle');return full;
}
async function progress(message:string,extra:object={}):Promise<void>{
  console.log(message);await studio('/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,...extra})});
}
try{
  const job=await (await studio('')).json() as {sourceUrl:string;pages:string[];bundleId?:string;maxPages:number;maxRepairs:number};
  let bundleDir:string|undefined;
  if(job.bundleId){
    await progress('Retrieving the saved pages for scope analysis.');bundleDir=resolve('preflight-work/bundle');await mkdir(bundleDir,{recursive:true});
    const manifest=await (await studio('/bundle')).json() as {files:{path:string;size:number}[]};let total=0;
    if(manifest.files.length>300)throw new Error('Bundle has too many files');
    for(const f of manifest.files){if(f.size>4_000_000||(total+=f.size)>50_000_000)throw new Error('Bundle size limit exceeded');const dest=pathIn(bundleDir,f.path);await mkdir(dirname(dest),{recursive:true});const bytes=await (await studio(`/bundle?file=${encodeURIComponent(f.path)}`)).arrayBuffer();if(bytes.byteLength!==f.size)throw new Error('Bundle file size mismatch');await writeFile(dest,Buffer.from(bytes));}
  }
  const report=await runPreflight({...(bundleDir?{bundleDir}:{url:job.sourceUrl,urls:job.pages.length?job.pages:undefined}),workDir:resolve('preflight-work/scan'),maxPages:job.maxPages,maxRepairs:job.maxRepairs,onProgress:message=>progress(message)});
  await writeFile(resolve(artifacts,'preflight.json'),JSON.stringify(report,null,2));
  await writeFile(resolve(artifacts,'READ-ME.txt'),'Molt preflight measures public source pages, visible complexity, observed interactions and detectable services. It does not invoke the AI model and it is not a charge or guaranteed final quote.\n');
  await progress('Scope analysis is ready for approval.',{preflight:report});
}catch(error){
  const message=error instanceof Error?error.message:String(error);
  await writeFile(resolve(artifacts,'error.json'),JSON.stringify({error:message},null,2));
  try{await progress(message,{error:message});}catch{}
  console.error(message);process.exitCode=1;
}
