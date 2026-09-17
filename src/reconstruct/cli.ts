import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runReconstruction } from './agent.js';
import { integer } from './policy.js';

const {values}=parseArgs({options:{url:{type:'string'},bundle:{type:'string'},out:{type:'string'},page:{type:'string',multiple:true},'max-pages':{type:'string'},'max-repairs':{type:'string'},help:{type:'boolean'}}});
if(values.help){
  console.log('Molt reconstruction\n  npm run reconstruct -- --url https://example.com --out ./work\n  npm run reconstruct -- --bundle ./saved-pages --out ./work\n  Optional: --page /about --page /contact --max-pages 12 --max-repairs 6\n\nRequires MOLT_AI_MODEL and the selected server-side provider key. Saved bundles contain bundle.json with site and pages[{route,file}].');
}else{
  const controller=new AbortController();
  process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  try{
    const result=await runReconstruction({url:values.url,bundleDir:values.bundle,workDir:resolve(values.out??'./molt-work'),urls:values.page,maxPages:integer(values['max-pages'],12,1,50),maxRepairs:integer(values['max-repairs'],6,0,20),signal:controller.signal,onProgress:console.log} as Parameters<typeof runReconstruction>[0]);
    console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='review'?0:2;
  }catch(error){console.error((error as Error).message);process.exitCode=1;}
}
