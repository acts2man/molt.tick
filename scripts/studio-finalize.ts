import { readFile, readdir, stat, mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finalStudioEvent } from './studio-report.js';
import { runnerFetch } from './runner-callback.js';

const origin=process.env.MOLT_STUDIO_ORIGIN??'',id=process.env.MOLT_JOB_ID??'';
if(origin!=='https://moltick.netlify.app'||!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid studio finalizer configuration');

async function readJson(path:string):Promise<any|null>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}}
async function findReports(root:string):Promise<string[]>{
  const out:string[]=[];async function walk(dir:string){let entries:any[]=[];try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){const full=resolve(dir,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile()&&entry.name==='report.json')out.push(full);}
  }await walk(root);return out;
}
async function recoverCheckpoint(root:string):Promise<any|null>{
  const reports=await findReports(resolve('studio-work/reconstruction'));if(!reports.length)return null;
  let latest=reports[0],latestMtime=0;
  for(const path of reports){const info=await stat(path);if(info.mtimeMs>latestMtime){latest=path;latestMtime=info.mtimeMs;}}
  const report=await readJson(latest);if(!report)return null;
  await mkdir(root,{recursive:true});await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));
  const site=resolve(latest,'..','site');try{await cp(site,resolve(root,'react-project-recovered'),{recursive:true,filter:source=>!source.split(/[\\/]/).some(s=>s==='node_modules'||s==='.git'||s==='dist')});}catch{}
  console.log('Recovered the latest measured reconstruction checkpoint after an interrupted runner.');
  return report;
}
async function identityToken():Promise<string>{
  const endpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!endpoint||!secret)throw new Error('The workflow needs GitHub id-token: write permission.');
  const response=await fetch(`${endpoint}&audience=${encodeURIComponent(origin)}`,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not obtain a fresh runner identity for finalization.');
  return ((await response.json()) as {value:string}).value;
}
async function postEvent(payload:any):Promise<void>{
  await runnerFetch({origin,id,path:'/events',attempts:4,getToken:async()=>identityToken(),init:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}});
}
const root=resolve('studio-artifacts');
let report=await readJson(resolve(root,'report.json'));if(!report)report=await recoverCheckpoint(root);
const handoff=await readJson(resolve(root,'handoff.json'))??{};
const failure=await readJson(resolve(root,'error.json'));
if(report){
  const payload=finalStudioEvent(report,handoff);
  await postEvent(payload);
  console.log('Fresh-process finalizer persisted the checkpointed reconstruction report.');
}else if(failure?.error){
  await postEvent({message:String(failure.error).slice(0,4000),error:String(failure.error).slice(0,4000),usage:failure.usage??null});
  console.log('Fresh-process finalizer persisted the reconstruction error.');
}else{
  console.log('No checkpointed report or error was available to finalize.');
}
