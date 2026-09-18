import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finalStudioEvent } from './studio-report.js';
import { runnerFetch } from './runner-callback.js';

const origin=process.env.MOLT_STUDIO_ORIGIN??'',id=process.env.MOLT_JOB_ID??'';
if(origin!=='https://moltick.netlify.app'||!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid studio finalizer configuration');

async function readJson(path:string):Promise<any|null>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}}
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
const report=await readJson(resolve(root,'report.json'));
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
