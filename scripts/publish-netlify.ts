import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface NetlifySite { id:string; name:string; url:string; adminUrl:string }
export interface NetlifyDeployResult extends NetlifySite { workflowUrl?:string }

function cleanName(value:string):string{
  const out=value.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,55);
  if(!out)throw new Error('Could not derive a Netlify site name from the output repository.');
  return out;
}
async function run(command:string,args:string[],cwd:string,env:Record<string,string|undefined>={}):Promise<string>{
  return await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let out='',err='';
    child.stdout.on('data',b=>{if(out.length<16000)out+=String(b);});
    child.stderr.on('data',b=>{if(err.length<16000)err+=String(b);});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(`${command} failed (exit ${code}): ${(err||out).trim().slice(0,1600)}`)));
  });
}
async function call(token:string,path:string,init:RequestInit={},fetcher:typeof fetch=fetch):Promise<{status:number,data:any,text:string}>{
  const response=await fetcher(`https://api.netlify.com${path}`,{
    ...init,redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...init.headers}
  });
  const text=await response.text();let data:any=null;try{data=text?JSON.parse(text):null;}catch{}
  return {status:response.status,data,text};
}
export async function preflightNetlify(teamSlug:string,token:string):Promise<void>{
  if(!token||token.length<20)throw new Error('Netlify deployment token is missing. Connect Netlify in Molt Owner setup before running a paid model.');
  if(!teamSlug||!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(teamSlug))throw new Error('Netlify team configuration is missing or invalid.');
  const [user,accounts]=await Promise.all([call(token,'/api/v1/user'),call(token,'/api/v1/accounts')]);
  if(user.status!==200)throw new Error(`Netlify preflight failed (HTTP ${user.status}). Reconnect the Netlify token before spending model usage.`);
  if(accounts.status!==200||!Array.isArray(accounts.data)||!accounts.data.some((a:any)=>a?.slug===teamSlug))throw new Error('Netlify preflight could not confirm access to the configured team. Reconnect hosting before spending model usage.');
}
export async function deleteNetlifySite(siteId:string,token:string):Promise<void>{
  if(!siteId||!token)return;
  try{
    const response=await call(token,`/api/v1/sites/${encodeURIComponent(siteId)}`,{method:'DELETE'});
    if(response.status!==404&&(response.status<200||response.status>=300))console.warn('Reserved Netlify site cleanup warning:',response.status,response.text.slice(0,500));
  }catch(error){console.warn('Reserved Netlify site cleanup warning:',error instanceof Error?error.message:String(error));}
}
export async function createNetlifySite(teamSlug:string,repoName:string,token:string):Promise<NetlifySite>{
  const base=cleanName(repoName);
  for(let n=1;n<=30;n++){
    const name=n===1?base:`${base.slice(0,Math.max(1,58-String(n).length))}-${n}`;
    const response=await call(token,`/api/v1/${encodeURIComponent(teamSlug)}/sites`,{method:'POST',body:JSON.stringify({name})});
    if(response.status>=200&&response.status<300){
      const site=response.data??{},id=String(site.id??''),actual=String(site.name??name);
      if(!id)throw new Error('Netlify created a site but did not return its identifier.');
      return {id,name:actual,url:String(site.ssl_url||site.url||`https://${actual}.netlify.app`).replace(/^http:/,'https:'),adminUrl:String(site.admin_url||`https://app.netlify.com/sites/${actual}`)};
    }
    if((response.status===409||response.status===422)&&/name|taken|exists|already/i.test(response.text))continue;
    throw new Error(`Netlify site creation failed (HTTP ${response.status}): ${response.text.slice(0,700)}`);
  }
  throw new Error('Could not find an available Netlify site name after 30 attempts.');
}

type DeployFile={path:string;absolute:string;sha:string};
async function collectDeployFiles(root:string):Promise<DeployFile[]>{
  const rows:DeployFile[]=[];
  async function walk(directory:string,prefix=''):Promise<void>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;
      const relative=prefix?`${prefix}/${entry.name}`:entry.name,absolute=join(directory,entry.name);
      if(entry.isDirectory())await walk(absolute,relative);
      else if(entry.isFile()){
        const body=await readFile(absolute);
        rows.push({path:relative.split('\\').join('/'),absolute,sha:createHash('sha1').update(body).digest('hex')});
      }
    }
  }
  await walk(root);return rows;
}
export async function deployNetlifyDirectory(directory:string,siteId:string,token:string,fetcher:typeof fetch=fetch,wait:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms))):Promise<{deployId:string}>{
  if(!siteId||!token)throw new Error('Netlify direct deploy is missing its site ID or token.');
  const files=await collectDeployFiles(directory);if(!files.length)throw new Error('Netlify direct deploy has no files to publish.');
  const manifest:Record<string,string>={};for(const file of files)manifest['/'+file.path]=file.sha;
  const created=await call(token,`/api/v1/sites/${encodeURIComponent(siteId)}/deploys`,{method:'POST',body:JSON.stringify({files:manifest})},fetcher);
  if(created.status<200||created.status>=300)throw new Error(`Netlify deploy manifest failed (HTTP ${created.status}): ${created.text.slice(0,700)}`);
  const deployId=String(created.data?.id??'');if(!deployId)throw new Error('Netlify deploy manifest did not return a deploy ID.');
  const required=new Set(Array.isArray(created.data?.required)?created.data.required.map(String):[]);
  for(const file of files){
    if(!required.has(file.sha))continue;
    const body=await readFile(file.absolute),encoded=file.path.split('/').map(encodeURIComponent).join('/');
    const response=await fetcher(`https://api.netlify.com/api/v1/deploys/${encodeURIComponent(deployId)}/files/${encoded}`,{
      method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:new Uint8Array(body)
    });
    if(!response.ok)throw new Error(`Netlify file upload failed for ${file.path} (HTTP ${response.status}): ${(await response.text()).slice(0,500)}`);
  }
  for(let attempt=0;attempt<45;attempt++){
    const status=await call(token,`/api/v1/deploys/${encodeURIComponent(deployId)}`,{},fetcher);
    if(status.status<200||status.status>=300)throw new Error(`Netlify deploy status check failed (HTTP ${status.status}).`);
    const state=String(status.data?.state??'');
    if(state==='ready')return {deployId};
    if(['error','failed'].includes(state))throw new Error(`Netlify deploy entered ${state} state: ${String(status.data?.error_message??'unknown error').slice(0,700)}`);
    await wait(2000);
  }
  throw new Error('Timed out waiting for the Netlify API deploy to become ready.');
}

function deployScript():string{
  return `import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2]||'dist',site=process.env.NETLIFY_SITE_ID,token=process.env.NETLIFY_AUTH_TOKEN;
if(!site||!token)throw new Error('NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required.');
const rows=[];
async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const rel=prefix?prefix+'/'+e.name:e.name,abs=join(dir,e.name);if(e.isDirectory())await walk(abs,rel);else if(e.isFile()){const b=await readFile(abs);rows.push({path:rel.split('\\\\').join('/'),abs,sha:createHash('sha1').update(b).digest('hex')});}}}
await walk(root);if(!rows.length)throw new Error('No built files found.');
async function req(path,init={}){const r=await fetch('https://api.netlify.com'+path,{...init,headers:{Authorization:'Bearer '+token,...init.headers}});const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch{};if(!r.ok)throw new Error('Netlify API '+r.status+': '+text.slice(0,700));return data;}
const files={};for(const f of rows)files['/'+f.path]=f.sha;
const created=await req('/api/v1/sites/'+encodeURIComponent(site)+'/deploys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files})});
const id=String(created?.id||'');if(!id)throw new Error('Netlify did not return a deploy ID.');
const required=new Set(Array.isArray(created?.required)?created.required.map(String):[]);
for(const f of rows){if(!required.has(f.sha))continue;const b=await readFile(f.abs),encoded=f.path.split('/').map(encodeURIComponent).join('/');await req('/api/v1/deploys/'+encodeURIComponent(id)+'/files/'+encoded,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(b)});}
for(let i=0;i<45;i++){const d=await req('/api/v1/deploys/'+encodeURIComponent(id));if(d?.state==='ready'){console.log('Netlify production deploy ready:',id);process.exit(0);}if(['error','failed'].includes(String(d?.state)))throw new Error('Netlify deploy failed: '+String(d?.error_message||d?.state));await new Promise(r=>setTimeout(r,2000));}
throw new Error('Timed out waiting for Netlify production deploy.');
`;
}
function workflow():string{
  return `name: Deploy to Netlify
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: netlify-production
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install site dependencies
        run: npm ci --no-audit --no-fund
      - name: Build React site
        run: npm run build
      - name: Deploy production site through Netlify API
        env:
          NETLIFY_AUTH_TOKEN: \${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: \${{ secrets.NETLIFY_SITE_ID }}
        run: node .github/scripts/netlify-deploy.mjs dist
`;
}
async function waitForRun(repo:string,commitSha:string,token:string,cwd:string):Promise<{url?:string}>{
  const env={GH_TOKEN:token};let fallbackDispatched=false;
  for(let attempt=0;attempt<32;attempt++){
    const raw=await run('gh',['run','list','--repo',repo,'--workflow','netlify-deploy.yml','--limit','10','--json','databaseId,status,conclusion,url,headSha'],cwd,env).catch(()=> '[]');
    let rows:any[]=[];try{rows=JSON.parse(raw||'[]');}catch{}
    const item=rows.find(r=>String(r.headSha)===commitSha)||rows[0];
    if(item?.status==='completed'){
      if(item.conclusion!=='success')throw new Error(`Generated repository Netlify workflow failed: ${item.url||item.conclusion}`);
      return {url:item.url};
    }
    if(attempt===6&&!item&&!fallbackDispatched){
      await run('gh',['workflow','run','netlify-deploy.yml','--repo',repo],cwd,env);
      fallbackDispatched=true;
    }
    await new Promise(r=>setTimeout(r,7000));
  }
  throw new Error('Timed out waiting for the generated repository to deploy to Netlify.');
}
export async function verifyLiveRoutes(url:string,routes:string[],fetcher:typeof fetch=fetch,wait:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms))):Promise<void>{
  const unique=[...new Set(['/',...routes.map(route=>route.startsWith('/')?route:'/'+route)])].slice(0,50);
  for(const route of unique){
    let ok=false,lastStatus=0;
    for(let attempt=0;attempt<12;attempt++){
      try{
        const target=new URL(route,url).href,response=await fetcher(target,{redirect:'follow',signal:AbortSignal.timeout(15000)});
        lastStatus=response.status;
        if(response.ok){ok=true;break;}
      }catch{}
      await wait(5000);
    }
    if(!ok)throw new Error(`Netlify reported a successful deploy, but reconstructed route ${route} did not become reachable${lastStatus?` (HTTP ${lastStatus})`:''}.`);
  }
}
export async function configureContinuousNetlifyDeploy(directory:string,repository:string,site:NetlifySite,githubToken:string,netlifyToken:string):Promise<NetlifyDeployResult>{
  if(!githubToken||githubToken.length<20)throw new Error('GitHub export token is missing while configuring continuous deployment.');
  await run('gh',['secret','set','NETLIFY_AUTH_TOKEN','--repo',repository,'--body',netlifyToken],directory,{GH_TOKEN:githubToken});
  await run('gh',['secret','set','NETLIFY_SITE_ID','--repo',repository,'--body',site.id],directory,{GH_TOKEN:githubToken});
  const scriptEncoded=Buffer.from(deployScript(),'utf8').toString('base64');
  await run('gh',['api',`repos/${repository}/contents/.github/scripts/netlify-deploy.mjs`,'--method','PUT','--field','message=Add Netlify API deploy helper','--field',`content=${scriptEncoded}`],directory,{GH_TOKEN:githubToken});
  const workflowEncoded=Buffer.from(workflow(),'utf8').toString('base64');
  const commitSha=await run('gh',['api',`repos/${repository}/contents/.github/workflows/netlify-deploy.yml`,'--method','PUT','--field','message=Connect generated site to Netlify','--field',`content=${workflowEncoded}`,'--jq','.commit.sha'],directory,{GH_TOKEN:githubToken});
  const runInfo=await waitForRun(repository,commitSha.trim(),githubToken,directory);
  let routes:string[]=['/'];
  try{const output=JSON.parse(await readFile(join(directory,'MOLT_OUTPUT.json'),'utf8'));if(Array.isArray(output?.routes))routes=output.routes.filter((route:unknown)=>typeof route==='string');}catch{}
  await verifyLiveRoutes(site.url,routes);
  return {...site,workflowUrl:runInfo.url};
}
