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
const workDir=resolve('zero-cost-preflight');
await mkdir(workDir,{recursive:true});
const started=Date.now();
const result=await runReconstruction({
  model,url:'https://ceballostreeservices.com',workDir,maxPages:1,maxRepairs:1,
  onProgress:message=>{console.log('[preflight]',message);}
});
assert.equal(result.source.pages.length,1,'real Ceballos homepage must capture');
assert.equal(result.evaluation.views.length,3,'desktop/tablet/mobile must all render');
assert.ok(result.evaluation.views.every(v=>typeof v.score==='number'),'every viewport must produce a pixel score');
assert.ok(result.evaluation.views.every(v=>v.candidate),'every viewport must produce a generated screenshot');
assert.ok(result.attempts.length>=1,'repair loop must checkpoint at least the initial evaluation');
await access(result.reportPath);
await access(result.outDir);
await writeFile(resolve(workDir,'summary.json'),JSON.stringify({
  ok:true,durationMs:Date.now()-started,deterministicModelCalls:usage.calls,status:result.status,
  views:result.evaluation.views.map(v=>({viewport:v.viewport,score:v.score,worstBand:v.worstBand,candidate:Boolean(v.candidate)}))
},null,2));
console.log('ZERO_COST_CEBALLOS_PREFLIGHT_OK');
