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
async function call(token:string,path:string,init:RequestInit={}):Promise<{status:number,data:any,text:string}>{
  const response=await fetch(`https://api.netlify.com${path}`,{
    ...init,redirect:'error',signal:AbortSignal.timeout(20000),
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
        run: npm install --no-audit --no-fund
      - name: Build React site
        run: npm run build
      - name: Deploy production site
        env:
          NETLIFY_AUTH_TOKEN: \${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: \${{ secrets.NETLIFY_SITE_ID }}
        run: npx --yes netlify-cli@27.8.0 deploy --prod --dir=dist --site="$NETLIFY_SITE_ID" --auth="$NETLIFY_AUTH_TOKEN" --message="GitHub \${GITHUB_SHA}"
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
async function verifyLive(url:string):Promise<void>{
  for(let attempt=0;attempt<12;attempt++){
    try{const response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(15000)});if(response.ok)return;}catch{}
    await new Promise(r=>setTimeout(r,5000));
  }
  throw new Error('Netlify reported a successful deploy, but the public site did not become reachable.');
}
export async function configureContinuousNetlifyDeploy(directory:string,repository:string,site:NetlifySite,githubToken:string,netlifyToken:string):Promise<NetlifyDeployResult>{
  if(!githubToken||githubToken.length<20)throw new Error('GitHub export token is missing while configuring continuous deployment.');
  await run('gh',['secret','set','NETLIFY_AUTH_TOKEN','--repo',repository,'--body',netlifyToken],directory,{GH_TOKEN:githubToken});
  await run('gh',['secret','set','NETLIFY_SITE_ID','--repo',repository,'--body',site.id],directory,{GH_TOKEN:githubToken});
  const encoded=Buffer.from(workflow(),'utf8').toString('base64');
  const commitSha=await run('gh',['api',`repos/${repository}/contents/.github/workflows/netlify-deploy.yml`,'--method','PUT','--field','message=Connect generated site to Netlify','--field',`content=${encoded}`,'--jq','.commit.sha'],directory,{GH_TOKEN:githubToken});
  const runInfo=await waitForRun(repository,commitSha.trim(),githubToken,directory);
  await verifyLive(site.url);
  return {...site,workflowUrl:runInfo.url};
}
