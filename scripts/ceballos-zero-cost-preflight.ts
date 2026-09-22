import assert from 'node:assert/strict';
import {mkdir,writeFile,access,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runReconstruction} from '../src/reconstruct/agent.js';
import {capture} from '../src/reconstruct/capture.js';
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
const routes=[
  {route:'/',file:'home.html',label:'Home'},
  {route:'/ourservices2',file:'services.html',label:'Services'},
  {route:'/about2',file:'about.html',label:'About'},
  {route:'/gallery-2',file:'gallery.html',label:'Gallery'},
  {route:'/contact2',file:'contact.html',label:'Contact'},
];
for(const page of routes){
  await writeFile(resolve(bundleDir,page.file),`<!doctype html><html><head><link rel="stylesheet" href="saved.css"><meta http-equiv="refresh" content="0;url=https://ceballostreeservices.com${page.route}"><script>location.href='https://ceballostreeservices.com${page.route}'</script></head><body onload="location.href='https://ceballostreeservices.com${page.route}'"><main><h1>${page.label} saved evidence</h1><img src="asset.png"></main></body></html>`);
}
await writeFile(resolve(bundleDir,'asset.png'),Buffer.from([137,80,78,71,13,10,26,10]));
await writeFile(resolve(bundleDir,'saved.css'),'@font-face{font-family:"Arvo";font-style:normal;font-weight:400;src:url(fonts/arvo.woff2) format("woff2")} body{margin:0}');
await mkdir(resolve(bundleDir,'fonts'),{recursive:true});
await writeFile(resolve(bundleDir,'fonts/arvo.woff2'),Buffer.from([119,79,70,50,0,1,0,0]));
await writeFile(resolve(bundleDir,'bundle.json'),JSON.stringify({site:'https://ceballostreeservices.com/',pages:routes.map(({route,file})=>({route,file}))}));
await writeFile(resolve(bundleDir,'manifest.json'),JSON.stringify({originalUrl:'https://ceballostreeservices.com/',resources:{'saved.css':'https://fonts.googleapis.com/css?family=Arvo','fonts/arvo.woff2':'https://fonts.gstatic.com/s/arvo/v23/tDbD2oWUg0MKqScQ7Q.woff2'}}));

const started=Date.now();
const mappedUrls=routes.map(page=>new URL(page.route,'https://ceballostreeservices.com').href);
const exactEvidence=await capture({
  url:'https://ceballostreeservices.com',
  urls:mappedUrls,
  bundleDir,
  directory:resolve(workDir,'exact-five-page-capture'),
  maxPages:5,
  viewports:[{name:'desktop',width:1440,height:900}],
  adaptiveViewports:false,
  sourceStability:false,
  signal:AbortSignal.timeout(300000)
});
assert.equal(exactEvidence.pages.length,5,'the exact five-page saved-bundle path must capture all mapped routes');
assert.deepEqual(exactEvidence.pages.map(page=>page.route),routes.map(page=>page.route));
assert.ok(exactEvidence.pages.every(page=>page.views.length===1&&page.views[0].geometry.text.trim()),'every uploaded route must produce usable browser evidence');
assert.ok(exactEvidence.pages.every(page=>!page.views[0].screenshot.includes('chrome-error')),'saved-page authority must never capture Chromium error pages');
assert.ok(exactEvidence.warnings.some(w=>/Saved-page authority enabled: 5 of 5/i.test(w)),'all five uploaded routes must use saved-page authority');

const home=exactEvidence.pages.find(page=>page.route==='/');
assert.ok(home,'home route must be present');
const onePageEvidence={...exactEvidence,pages:[home!]};
const result=await runReconstruction({
  model,url:'https://ceballostreeservices.com',bundleDir,workDir,maxPages:1,maxRepairs:1,evidence:onePageEvidence,
  onProgress:message=>{console.log('[preflight]',message);}
});
assert.equal(result.source.pages.length,1,'deterministic reconstruction must retain the validated homepage evidence');
assert.ok(result.evaluation.views.length>=1,'validated evidence must render into a generated candidate');
assert.ok(result.evaluation.views.every(v=>typeof v.score==='number'),'every evaluated viewport must produce a pixel score');
assert.ok(result.evaluation.views.every(v=>v.candidate),'every evaluated viewport must produce a generated screenshot');
assert.ok(result.attempts.length>=1,'repair loop must checkpoint at least the initial evaluation');
assert.ok(result.source.assetCount>=1,'saved resource evidence must survive into reconstruction');
const generatedAssets=await readdir(resolve(result.outDir,'public/assets'));assert.ok(generatedAssets.some(name=>name.endsWith('.woff2')),'saved font binary must survive into the generated React project');
await access(result.reportPath);
await access(result.outDir);
await writeFile(resolve(workDir,'summary.json'),JSON.stringify({
  ok:true,durationMs:Date.now()-started,deterministicModelCalls:usage.calls,status:result.status,
  exactSavedRoutes:exactEvidence.pages.map(page=>page.route),
  warnings:exactEvidence.warnings,
  views:result.evaluation.views.map(v=>({viewport:v.viewport,score:v.score,worstBand:v.worstBand,candidate:Boolean(v.candidate)}))
},null,2));
console.log('ZERO_COST_CEBALLOS_PREFLIGHT_OK');
