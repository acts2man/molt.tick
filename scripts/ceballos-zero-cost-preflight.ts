import assert from 'node:assert/strict';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runReconstruction} from '../src/reconstruct/agent.js';
import {routeFile} from '../src/reconstruct/policy.js';
import type {Model} from '../src/reconstruct/types.js';

const usage={calls:0,inputTokens:0,outputTokens:0,records:[]};
const model:Model={
  usage,
  async complete(){
    usage.calls++;
    return {summary:'Deterministic zero-cost pipeline preflight',files:[
      {path:routeFile('/'),content:`export default function Page(){return <main className="preflight-page"><h1>Ceballos Tree Services</h1><p>Deterministic Molt pipeline preflight.</p></main>}`},
      {path:'src/site.css',content:`.preflight-page{min-height:100vh;padding:48px;font-family:Arial,sans-serif;background:#fff;color:#111}.preflight-page h1{font-size:48px;margin:0 0 24px}`}
    ]};
  }
};
const workDir=resolve('zero-cost-preflight'),bundleDir=resolve(workDir,'saved-bundle');
await mkdir(bundleDir,{recursive:true});
await writeFile(resolve(bundleDir,'index.html'),'<!doctype html><html><head><link rel="stylesheet" href="saved.css"></head><body><main><h1>Ceballos Tree Services saved evidence</h1></main></body></html>');
await writeFile(resolve(bundleDir,'saved.css'),'@font-face{font-family:"Arvo";font-style:normal;font-weight:400;src:url(fonts/arvo.woff2) format("woff2")}');
await mkdir(resolve(bundleDir,'fonts'),{recursive:true});
await writeFile(resolve(bundleDir,'fonts/arvo.woff2'),Buffer.from([119,79,70,50,0,1,0,0]));
await writeFile(resolve(bundleDir,'bundle.json'),JSON.stringify({site:'https://ceballostreeservices.com/',pages:[{route:'/',file:'index.html'}]}));
await writeFile(resolve(bundleDir,'manifest.json'),JSON.stringify({originalUrl:'https://ceballostreeservices.com/',resources:{'saved.css':'https://fonts.googleapis.com/css?family=Arvo','fonts/arvo.woff2':'https://fonts.gstatic.com/s/arvo/v23/tDbD2oWUg0MKqScQ7Q.woff2'}}));
const started=Date.now();
const result=await runReconstruction({
  model,url:'https://ceballostreeservices.com',bundleDir,workDir,maxPages:1,maxRepairs:1,
  onProgress:message=>{console.log('[preflight]',message);}
});
assert.equal(result.source.pages.length,1,'real Ceballos homepage must capture');
assert.equal(result.evaluation.views.length,3,'desktop/tablet/mobile must all render');
assert.ok(result.evaluation.views.every(v=>typeof v.score==='number'),'every viewport must produce a pixel score');
assert.ok(result.evaluation.views.every(v=>v.candidate),'every viewport must produce a generated screenshot');
assert.ok(result.attempts.length>=1,'repair loop must checkpoint at least the initial evaluation');
assert.ok(result.warnings.some(w=>/Hybrid evidence enabled/i.test(w)),'hybrid live + saved evidence must be active');
assert.ok(result.source.assetCount>=1,'saved resource evidence must supplement the live capture');
await access(result.reportPath);
await access(result.outDir);
await writeFile(resolve(workDir,'summary.json'),JSON.stringify({
  ok:true,durationMs:Date.now()-started,deterministicModelCalls:usage.calls,status:result.status,
  views:result.evaluation.views.map(v=>({viewport:v.viewport,score:v.score,worstBand:v.worstBand,candidate:Boolean(v.candidate)}))
},null,2));
console.log('ZERO_COST_CEBALLOS_PREFLIGHT_OK');
