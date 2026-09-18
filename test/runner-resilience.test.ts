import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runnerFetch} from '../scripts/runner-callback.js';
import {compactStudioReport,finalStudioEvent} from '../scripts/studio-report.js';

test('runner callback replaces a stale identity after 403 and succeeds',async()=>{
  const tokens:string[]=[];let calls=0;
  const response=await runnerFetch({
    origin:'https://moltick.netlify.app',id:'11111111-1111-4111-8111-111111111111',path:'/events',
    getToken:async force=>{const token=force?'fresh-token':'stale-token';tokens.push(token);return token;},
    wait:async()=>{},
    fetcher:async(_url,init)=>{calls++;const auth=(init?.headers as any)?.Authorization;return auth==='Bearer stale-token'?new Response('expired',{status:403}):new Response('ok',{status:200});}
  });
  assert.equal(response.status,200);assert.equal(calls,2);assert.deepEqual(tokens,['stale-token','fresh-token']);
});

test('runner callback does not retry non-transient client errors',async()=>{
  let tokens=0,calls=0;
  await assert.rejects(runnerFetch({
    origin:'https://moltick.netlify.app',id:'11111111-1111-4111-8111-111111111111',path:'/events',
    getToken:async()=>{tokens++;return 'token';},wait:async()=>{},
    fetcher:async()=>{calls++;return new Response('bad request',{status:400});}
  }),/HTTP 400/);
  assert.equal(tokens,1);assert.equal(calls,1);
});

test('Studio report payload remains comfortably below callback limit even with large evaluations',()=>{
  const views=Array.from({length:72},(_,i)=>({route:'/page-'+i,viewport:'desktop',pass:false,score:88,worstBand:70,issues:Array(100).fill('difference '.repeat(100)),sourceImage:'source.png',candidateImage:'candidate.png',diffImage:'diff.png'}));
  const attempts=Array.from({length:20},(_,i)=>({round:i,accepted:i%2===0,summary:'repair summary '.repeat(500),evaluation:{views}}));
  const report=compactStudioReport({status:'needs-work',reason:'test',warnings:Array(200).fill('warning '.repeat(200)),blockers:Array(200).fill('blocker '.repeat(200)),evaluation:{pass:false,issues:Array(200).fill('issue '.repeat(200)),views},attempts,usage:{calls:5,inputTokens:1000,outputTokens:500}});
  const bytes=Buffer.byteLength(JSON.stringify({message:'done',report}));
  assert.ok(bytes<900_000,`callback payload was ${bytes} bytes`);
});

test('fresh-process finalizer preserves handoff metadata with compact report',()=>{
  const event=finalStudioEvent({status:'needs-work',evaluation:{pass:false,issues:[],views:[]},attempts:[],warnings:[],blockers:[]},{previewReady:true,outputRepoUrl:'https://github.com/acts2man/example-v2'});
  assert.equal(event.previewReady,true);assert.equal(event.outputRepoUrl,'https://github.com/acts2man/example-v2');assert.equal(event.report.status,'needs-work');
});
