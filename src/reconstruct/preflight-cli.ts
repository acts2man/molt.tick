import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runPreflight } from './preflight.js';
import { integer } from './policy.js';

const {values}=parseArgs({options:{url:{type:'string'},bundle:{type:'string'},out:{type:'string'},page:{type:'string',multiple:true},'max-pages':{type:'string'},'max-repairs':{type:'string'},help:{type:'boolean'}}});
if(values.help){
  console.log('Molt preflight\n  npm run preflight -- --url https://example.com --out ./work\n  npm run preflight -- --bundle ./saved-pages --out ./work\n  Optional: --page /about --page /contact --max-pages 12 --max-repairs 2\n\nPreflight captures and scopes the source without calling an AI model.');
}else{
  const controller=new AbortController();
  process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  try{
    const result=await runPreflight({url:values.url,bundleDir:values.bundle,workDir:resolve(values.out??'./molt-work'),urls:values.page,maxPages:integer(values['max-pages'],12,1,50),maxRepairs:integer(values['max-repairs'],2,0,6),signal:controller.signal,onProgress:console.log});
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error((error as Error).message);process.exitCode=1;}
}
