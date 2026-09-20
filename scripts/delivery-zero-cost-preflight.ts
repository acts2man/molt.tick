import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { reserveOutputRepository, publishReservedOutputRepository } from './publish-output.js';
import { preflightNetlify, createNetlifySite, configureContinuousNetlifyDeploy, type NetlifySite } from './publish-netlify.js';

const githubToken=process.env.MOLT_GITHUB_EXPORT_TOKEN??'';
const netlifyToken=process.env.MOLT_NETLIFY_AUTH_TOKEN??'';
const teamSlug=process.env.MOLT_NETLIFY_TEAM_SLUG??'';
const runId=(process.env.GITHUB_RUN_ID??Date.now().toString()).replace(/[^0-9]/g,'').slice(-10);
const runAttempt=(process.env.GITHUB_RUN_ATTEMPT??'1').replace(/[^0-9]/g,'');
const baseName=`molt-delivery-ci-${runId}-${runAttempt}`;
const root=resolve('delivery-zero-cost-preflight');
let repository:string|undefined,site:NetlifySite|undefined;

async function command(command:string,args:string[],env:Record<string,string|undefined>={}):Promise<void>{
  await new Promise<void>((resolveRun,reject)=>{
    const child=spawn(command,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let err='';child.stderr.on('data',b=>{if(err.length<4000)err+=String(b);});
    child.on('error',reject);child.on('close',code=>code===0?resolveRun():reject(new Error(`${command} failed (exit ${code}): ${err.trim().slice(0,1000)}`)));
  });
}
async function cleanup():Promise<void>{
  if(site){
    try{
      const response=await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(site.id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${netlifyToken}`},signal:AbortSignal.timeout(20000)});
      if(!response.ok&&response.status!==404)console.warn('Netlify cleanup warning:',response.status,(await response.text()).slice(0,500));
    }catch(error){console.warn('Netlify cleanup warning:',error instanceof Error?error.message:String(error));}
  }
  if(repository){
    try{await command('gh',['repo','delete',repository,'--yes'],{GH_TOKEN:githubToken});}
    catch(error){console.warn('GitHub cleanup warning:',error instanceof Error?error.message:String(error));}
  }
}
try{
  if(!githubToken||!netlifyToken||!teamSlug)throw new Error('Delivery preflight secrets are not configured in GitHub Actions.');
  await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
  const planned=await reserveOutputRepository(process.cwd(),'acts2man',baseName,githubToken);repository=planned.repository;
  await preflightNetlify(teamSlug,netlifyToken);
  site=await createNetlifySite(teamSlug,baseName,netlifyToken);
  const marker=`Molt generated-workflow delivery preflight ${runId}`;
  const pkg={name:baseName,private:true,type:'module',scripts:{build:'node build.mjs'}};
  const lock={name:baseName,lockfileVersion:3,requires:true,packages:{'':{name:baseName}}};
  await writeFile(join(root,'package.json'),JSON.stringify(pkg,null,2));
  await writeFile(join(root,'package-lock.json'),JSON.stringify(lock,null,2));
  const builtHtml=`<!doctype html><meta name="robots" content="noindex"><title>Molt delivery preflight</title><p>${marker}</p>`;
  const buildScript=`import {mkdir,writeFile} from 'node:fs/promises';await mkdir('dist',{recursive:true});await writeFile('dist/index.html',${JSON.stringify(builtHtml)});`;
  await writeFile(join(root,'build.mjs'),buildScript);
  await writeFile(join(root,'README.md'),'# Molt delivery CI fixture\n');
  await publishReservedOutputRepository(root,repository,githubToken);
  const deployed=await configureContinuousNetlifyDeploy(root,repository,site,githubToken,netlifyToken);
  let body='',ok=false;
  for(let attempt=0;attempt<12;attempt++){
    try{const response=await fetch(site.url,{redirect:'follow',signal:AbortSignal.timeout(15000)});body=await response.text();if(response.ok&&body.includes(marker)){ok=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,3000));
  }
  if(!ok)throw new Error('Generated repository workflow completed but the public Netlify site did not serve the expected build marker.');
  await writeFile(join(root,'result.json'),JSON.stringify({ok:true,repository,site:site.url,workflowUrl:deployed.workflowUrl},null,2));
  console.log('Zero-cost generated-repository workflow verified end-to-end:',repository,site.url,deployed.workflowUrl);
}finally{
  await cleanup();
}
