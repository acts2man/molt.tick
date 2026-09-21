import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

export interface PublishResult { url:string; repository:string }

function validRepo(name:string):string{
  const value=name.trim().toLowerCase();
  if(!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(value)||value.includes('..'))throw new Error('Invalid output repository name');
  return value;
}
async function run(command:string,args:string[],cwd:string,env:Record<string,string|undefined>={},timeoutMs=120000):Promise<string>{
  return await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let out='',err='',settled=false;
    const timer=setTimeout(()=>{if(settled)return;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();settled=true;reject(new Error(`${command} timed out after ${Math.round(timeoutMs/1000)}s`));},timeoutMs);
    timer.unref();
    const finish=(fn:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);fn();};
    child.stdout.on('data',b=>{if(out.length<12000)out+=String(b);});
    child.stderr.on('data',b=>{if(err.length<12000)err+=String(b);});
    child.on('error',error=>finish(()=>reject(error)));
    child.on('close',code=>finish(()=>code===0?resolve(out.trim()):reject(new Error(`${command} failed (exit ${code}): ${(err||out).trim().slice(0,1200)}`))));
  });
}
async function exists(owner:string,repo:string,token:string,cwd:string):Promise<boolean>{
  try{await run('gh',['repo','view',`${owner}/${repo}`,'--json','name'],cwd,{GH_TOKEN:token});return true;}catch{return false;}
}
export async function reserveOutputRepository(directory:string,owner:string,name:string,token:string):Promise<PublishResult>{
  const requested=validRepo(name);
  if(!token||token.length<20)throw new Error('GitHub export token is missing. Reconnect Molt with repository creation permissions.');
  const login=await run('gh',['api','user','--jq','.login'],directory,{GH_TOKEN:token});
  if(login.trim().toLowerCase()!==owner.toLowerCase())throw new Error(`GitHub export token belongs to ${login||'another account'}, not ${owner}.`);
  await run('gh',['repo','view','acts2man/molt.tick','--json','name'],directory,{GH_TOKEN:token});
  let repo=requested;
  if(await exists(owner,repo,token,directory)){
    let found='';
    for(let version=2;version<=30;version++){const candidate=validRepo(`${requested}-v${version}`);if(!(await exists(owner,candidate,token,directory))){found=candidate;break;}}
    if(!found)throw new Error(`Could not find an available GitHub repository name after ${owner}/${requested}-v30.`);
    repo=found;
  }
  const repository=`${owner}/${repo}`;
  await run('gh',['repo','create',repository,'--private','--add-readme','--description','React reconstruction reserved by Molt'],directory,{GH_TOKEN:token});
  try{
    try{await run('gh',['repo','view',repository,'--json','name'],directory,{GH_TOKEN:token});}
    catch(error){throw new Error('NEW_REPOSITORY_ACCESS: The token created the repository but cannot access it. Edit the fine-grained token and set Repository access to All repositories. '+(error instanceof Error?error.message:String(error)));}
    try{
      await run('gh',['secret','set','MOLT_HANDOFF_PREFLIGHT','--repo',repository,'--body','verified'],directory,{GH_TOKEN:token});
      await run('gh',['secret','delete','MOLT_HANDOFF_PREFLIGHT','--repo',repository],directory,{GH_TOKEN:token});
    }catch(error){throw new Error('ACTIONS_SECRETS_WRITE: The token cannot write Actions secrets to the new repository. Set Secrets to Read & write. '+(error instanceof Error?error.message:String(error)));}
    const probe=`name: Molt handoff permission probe
on:
  workflow_dispatch:
jobs:
  permission-check:
    if: \${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: echo permission-check
`;
    try{
      const encoded=Buffer.from(probe,'utf8').toString('base64');
      const sha=await run('gh',['api',`repos/${repository}/contents/.github/workflows/molt-permission-check.yml`,'--method','PUT','--field','message=Verify Molt workflow permission','--field',`content=${encoded}`,'--jq','.content.sha'],directory,{GH_TOKEN:token});
      await run('gh',['api',`repos/${repository}/contents/.github/workflows/molt-permission-check.yml`,'--method','DELETE','--field','message=Remove Molt workflow permission probe','--field',`sha=${sha.trim()}`],directory,{GH_TOKEN:token});
    }catch(error){throw new Error('WORKFLOW_FILE_WRITE: The token cannot write workflow files to the new repository. Set Contents and Workflows to Read & write. '+(error instanceof Error?error.message:String(error)));}
  }catch(error){
    try{await run('gh',['repo','delete',repository,'--yes'],directory,{GH_TOKEN:token});}catch{}
    throw new Error('GitHub delivery preflight failed before model usage: '+(error instanceof Error?error.message:String(error)));
  }
  return {repository,url:`https://github.com/${repository}`};
}
export async function deleteReservedOutputRepository(directory:string,repository:string,token:string):Promise<void>{
  if(!token||token.length<20||!/^acts2man\/[a-z0-9][a-z0-9._-]{0,99}$/i.test(repository))return;
  try{await run('gh',['repo','delete',repository,'--yes'],directory,{GH_TOKEN:token});}catch(error){console.warn('Reserved GitHub repository cleanup warning:',error instanceof Error?error.message:String(error));}
}
export async function publishReservedOutputRepository(directory:string,repository:string,token:string):Promise<PublishResult>{
  if(!token||token.length<20)throw new Error('GitHub export token is missing.');
  if(!/^acts2man\/[a-z0-9][a-z0-9._-]{0,99}$/i.test(repository))throw new Error('Invalid reserved output repository.');
  const ignore='\n# Generated repository hygiene\nnode_modules/\ndist/\n';
  await appendFile(`${directory}/.gitignore`,ignore);
  const readmePath=`${directory}/README.md`;
  let readme='';try{readme=await readFile(readmePath,'utf8');}catch{}
  if(!readme.includes('Generated by Molt'))await appendFile(readmePath,'\n\n---\nGenerated by Molt from an authorized website reconstruction. Review integrations, forms, payments, authentication, email, and licensing before production use.\n');
  await run('git',['init','-b','main'],directory);
  await run('git',['config','user.name','Molt Reconstruction'],directory);
  await run('git',['config','user.email','molt@users.noreply.github.com'],directory);
  await run('git',['add','.'],directory);
  await run('git',['commit','-m','Initial React reconstruction from Molt'],directory);
  await run('git',['remote','add','origin',`https://github.com/${repository}.git`],directory);
  await run('git',['push','-u','--force','origin','main'],directory,{GH_TOKEN:token,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${Buffer.from('x-access-token:'+token).toString('base64')}`});
  return {repository,url:`https://github.com/${repository}`};
}
