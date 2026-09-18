import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { improves, routePath, routeFile, publicUrl, publicIP, inside, integer, validateViewports, safeEnvironment } from '../src/reconstruct/policy.js';
import { validateChanges, apply, snapshot, restore } from '../src/reconstruct/workspace.js';
import { repairLoop } from '../src/reconstruct/loop.js';
import { createModel, parseReply } from '../src/reconstruct/provider.js';
import { readBundle } from '../src/reconstruct/capture.js';
import { serve } from '../src/reconstruct/runtime.js';
import { repairImages } from '../src/reconstruct/images.js';
import { PNG } from 'pngjs';
import type { Evaluation, FileChange, ModelReply, Evidence } from '../src/reconstruct/types.js';
import { reconstructionPrompt } from '../src/reconstruct/agent.js';
const score=(n:number|null,pass=false):Evaluation=>({pass,issues:[],views:[{route:'/',viewport:'desktop',source:'source.png',score:n,worstBand:n,pass,issues:[]}]});
const signal=()=>new AbortController().signal;
async function temporary(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'molt-agent-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('route mapping prevents collisions across nested, dotted and punctuation routes',()=>assert.equal(new Set(['/a/b','/a.b','/a-b','/'].map(routeFile)).size,4));
test('route validation rejects traversal, encoded traversal and protocol-relative routes',()=>{for(const s of ['//evil','/../outside','/%2e%2e/out','/a?x=1','/a\\b','/%2f%2fevil'])assert.throws(()=>routePath(s));});
test('same route has stable filename and trailing slash normalization',()=>{assert.equal(routeFile('/about/'),routeFile('/about'));assert.equal(routePath('/'),' /'.trim());});
test('source URL validation rejects unsafe schemes and credentials',()=>{for(const u of ['file:///etc/passwd','data:text/html,a','javascript:alert(1)','https://user:password@example.com'])assert.throws(()=>publicUrl(u));assert.equal(publicUrl('example.com').origin,'https://example.com');});
test('reserved networks are denied',()=>{for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1','198.51.100.1'])assert.equal(publicIP(ip),false,ip);assert.equal(publicIP('8.8.8.8'),true);});
test('numeric and viewport limits are explicit',()=>{assert.equal(integer(undefined,6,0,20),6);for(const n of ['','-1','21','NaN','1.5'])assert.throws(()=>integer(n,6,0,20));assert.throws(()=>validateViewports([]));assert.throws(()=>validateViewports([{name:'../x',width:390,height:844}]));});
test('child environment excludes provider credentials',()=>{process.env.MOLT_TEST_PRIVATE_VALUE='secret';assert.equal(safeEnvironment().MOLT_TEST_PRIVATE_VALUE,undefined);delete process.env.MOLT_TEST_PRIVATE_VALUE;});
test('zero is measured; null is missing',()=>{assert.equal(improves(score(null),score(0)),true);assert.equal(improves(score(0),score(null)),false);});
test('measured pixel improvement is accepted even when diagnostic wording changes',()=>{const a=score(85);a.views[0].worstBand=55;a.views[0].issues=['Heading Example: y, font-weight differ'];const b=score(90);b.views[0].worstBand=64;b.views[0].issues=['Heading Example: y differ'];assert.equal(improves(a,b),true);});
test('global gain cannot regress a passing device',()=>{const a=score(99,true);a.views.push({...a.views[0],viewport:'mobile',score:70,worstBand:70,pass:false});a.pass=false;const b=structuredClone(a);b.views[0].score=90;b.views[0].pass=false;b.views[1].score=100;b.views[1].worstBand=100;b.views[1].pass=true;assert.equal(improves(a,b),false);});
test('material worst-region gain can outweigh small noise across still-failing viewports',()=>{
  const a=score(91);a.views[0].worstBand=78;a.views.push({...a.views[0],viewport:'mobile',score:90,worstBand:76,pass:false});
  const b=structuredClone(a);b.views[0].score=92.2;b.views[0].worstBand=82;b.views[1].score=89.4;b.views[1].worstBand=75.6;
  assert.equal(improves(a,b),true);
});
test('material regression in any failing viewport is still rejected',()=>{
  const a=score(91);a.views[0].worstBand=78;a.views.push({...a.views[0],viewport:'mobile',score:90,worstBand:76,pass:false});
  const b=structuredClone(a);b.views[0].score=94;b.views[0].worstBand=84;b.views[1].score=88;b.views[1].worstBand=74;
  assert.equal(improves(a,b),false);
});
test('malformed evaluator success and changed scope cannot pass',()=>{assert.equal(improves(score(50),score(null,true)),false);const next=score(99,true);next.views[0].viewport='mobile';assert.equal(improves(score(50),next),false);});
test('asset paths cannot escape a bundle through a symlink',()=>temporary(async dir=>{await writeFile(join(dir,'page.html'),'x');assert.equal(await inside(dir,'page.html'),join(dir,'page.html'));await symlink('/etc/passwd',join(dir,'escape'));await assert.rejects(inside(dir,'escape'));await assert.rejects(inside(dir,'../outside'));}));
test('bundle validates explicit routes and files before browsing',()=>temporary(async dir=>{await writeFile(join(dir,'home.html'),'<h1>Home</h1>');await writeFile(join(dir,'bundle.json'),JSON.stringify({site:'https://example.com',pages:[{route:'/',file:'home.html'}]}));assert.equal((await readBundle(dir)).pages.length,1);await writeFile(join(dir,'bundle.json'),JSON.stringify({site:'https://example.com',pages:[{route:'/',file:'home.html'},{route:'/',file:'home.html'}]}));await assert.rejects(readBundle(dir),/Duplicate/);}));
test('static server does not return home for missing routes or expose dotfiles',()=>temporary(async dir=>{await writeFile(join(dir,'index.html'),'home');await writeFile(join(dir,'.env'),'private');const server=await serve(dir,{'/':'index.html'});try{assert.equal(await(await fetch(server.origin)).text(),'home');assert.equal((await fetch(server.origin+'/missing')).status,404);assert.equal((await fetch(server.origin+'/.env')).status,404);}finally{await server.close();}}));

const change=(content:string,path='src/pages/home.tsx'):FileChange=>({path,content});
test('model cannot edit engine-owned build or configuration files',()=>{for(const p of ['package.json','.env','src/main.tsx','../x','src/pages/../../x.tsx'])assert.throws(()=>validateChanges([change('x',p)]));});
test('model cannot inject source HTML or dynamic runtime',()=>{for(const code of ['export default()=> <div dangerouslySetInnerHTML={{__html:"a"}}/>','fetch("https://example.com")','eval("x")','import x from "node:fs"','import("./x")','export default()=> <iframe src="https://example.com"/>'])assert.throws(()=>validateChanges([change(code)]));});
test('plain React state and semantic JSX are allowed',()=>assert.doesNotThrow(()=>validateChanges([change("import {useState} from 'react';export default function Page(){const [open,setOpen]=useState(false);return <button onClick={()=>setOpen(!open)}>{open?'Open':'Closed'}</button>}")])));
test('change sets reject duplicates and excessive content',()=>{assert.throws(()=>validateChanges([change('a'),change('b')]));assert.throws(()=>validateChanges([change('a'.repeat(250001))]));assert.throws(()=>validateChanges([]));});
test('workspace restoration removes rejected files',()=>temporary(async dir=>{await apply(dir,[change('export default()=> <h1>Before</h1>')],new Set(['src/pages/home.tsx']));const before=await snapshot(dir);await apply(dir,[change('export default()=> <h1>After</h1>'),change('export const value=1','src/components/Unexpected.ts')],new Set(['src/pages/home.tsx']));await restore(dir,before);assert.deepEqual(await snapshot(dir),before);}));

async function loopHarness(scores:number[],replies:number[],maxRounds=3,controller=new AbortController()){
  let current=0,evals=0;const saved:number[]=[];
  const result=await repairLoop({snapshot:async()=>current,restore:async s=>{current=s;},digest:s=>String(s),evaluate:async()=>{const n=scores[current];evals++;return score(n,n>=95);},propose:async()=>({summary:'repair',files:[{path:'value',content:String(replies.shift()??current)}]}),apply:async r=>{current=Number(r.files[0].content);},save:async _=>{saved.push(current);}},{maxRounds,signal:controller.signal});
  return {result,current,evals,saved};
}
test('repair loop keeps an improved version until measured acceptance',async()=>{const {result,current}=await loopHarness([60,80,99],[1,2]);assert.equal(result.evaluation.pass,true);assert.equal(current,2);assert.equal(result.attempts.length,3);});
test('repair loop rolls back a regression before the next attempt',async()=>{const {result,current}=await loopHarness([80,50,98],[1,2]);assert.equal(current,2);assert.equal(result.attempts[1].accepted,false);assert.equal(result.attempts[2].accepted,true);});
test('repeated patches do not trigger another build',async()=>{const {result,evals}=await loopHarness([70],[0,0],2);assert.equal(evals,1);assert.equal(result.evaluation.pass,false);assert.match(result.reason??'',/budget/);});
test('a passing initial output makes no model repair calls',async()=>{const {evals,result}=await loopHarness([99],[],4);assert.equal(evals,1);assert.equal(result.attempts.length,1);});
test('failed partial writes are restored',async()=>{let file='good';const before=file;const result=await repairLoop({snapshot:async()=>file,restore:async s=>{file=s;},digest:s=>s,evaluate:async()=>score(60),propose:async()=>({summary:'x',files:[]}),apply:async()=>{file='partial';throw new Error('disk failure');},save:async()=>{}},{maxRounds:1,signal:signal()});assert.equal(file,before);assert.equal(result.attempts[1].accepted,false);});
test('pre-aborted run starts no effects',async()=>{const c=new AbortController();c.abort();await assert.rejects(loopHarness([60],[1],2,c));});

test('large page evidence compacts below the provider safety budget',()=>{
  const style={display:'block','font-family':'Inter','font-size':'16px','line-height':'24px',padding:'24px',margin:'12px',color:'rgb(1, 2, 3)',background:'rgb(255,255,255)','background-image':'none',width:'1200px',height:'40px'};
  const hugeSvg='<svg>'+('<path d="M0 0h10v10z"/>'.repeat(700))+'</svg>';
  const pseudo={content:'"decorative"',background:'linear-gradient(red, blue)','box-shadow':('0 0 1px #000,'.repeat(400))};
  const elements=Array.from({length:1400},(_,i)=>({key:String(i),tag:i%9===0?'svg':i%10===0?'section':'div',text:'Repeated visible website copy '.repeat(8)+i,x:0,y:i*40,width:1200,height:40,style,attributes:{'aria-label':'x'.repeat(200)},svg:i%9===0?hugeSvg:undefined,before:i%7===0?pseudo:undefined,after:i%11===0?pseudo:undefined}));
  const geometry={text:'Homepage text '.repeat(9000),title:'Large site',height:56000,overflow:false,brokenImages:0,elements,links:[],embeds:[],forms:0,fontFaces:Array.from({length:120},(_,i)=>'@font-face{font-family:F'+i+';src:url(https://example.com/'+('x'.repeat(800))+'.woff2)}'),mediaQueries:Array.from({length:180},(_,i)=>'(max-width: '+(300+i)+'px)'),truncated:false};
  const page={route:'/',url:'https://example.com/',title:'Large site',views:[{viewport:{name:'desktop',width:1440,height:900},screenshot:'source.png',geometry},{viewport:{name:'tablet',width:768,height:1024},screenshot:'tablet.png',geometry},{viewport:{name:'mobile',width:390,height:844},screenshot:'mobile.png',geometry}]};
  const assets=Array.from({length:180},(_,i)=>({original:'https://example.com/assets/'+('very-long-original-'+i+'-').repeat(18)+'.png',file:'/tmp/'+i+'.png',publicPath:'/assets/'+i+'.png'}));
  const evidence:Evidence={site:'https://example.com',directory:'/tmp',pages:[page],assets,fontFaces:geometry.fontFaces,warnings:Array(100).fill('warning '.repeat(80)),blockers:Array(100).fill('blocker '.repeat(80)),integrations:[]};
  const text=reconstructionPrompt(evidence,page,[{path:'src/site.css',content:'a{display:block}'.repeat(30000)},{path:'src/components/Huge.tsx',content:'export const x="'+('y'.repeat(90000))+'"'}],'Implement this page');
  assert.ok(text.length<=300000,'compacted prompt was '+text.length+' chars');
  assert.match(text,/Large site/);
  assert.match(text,/screenshots|visual authority/i);
});
test('repair evidence stays inside provider image and payload budgets',async()=>temporary(async dir=>{
  const path=join(dir,'large.png'),png=new PNG({width:1200,height:1600});
  for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++){const i=(y*png.width+x)*4;png.data[i]=(x*17+y*31)%256;png.data[i+1]=(x*43+y*11)%256;png.data[i+2]=(x*7+y*53)%256;png.data[i+3]=255;}
  await writeFile(path,PNG.sync.write(png));
  const checks=['desktop','tablet','mobile'].map(viewport=>({route:'/',viewport,source:path,candidate:path,diff:path,score:80,worstBand:60,worstY:400,pass:false,issues:[]}));
  const images=await repairImages(checks as any);
  assert.ok(images.length<=18);
  assert.ok(images.every(image=>Buffer.from(image.base64,'base64').length<=900_000),'every repair image must stay below the binary budget');
}));
test('provider response must contain real files',()=>{assert.throws(()=>parseReply('{"summary":"done","files":[]}'));assert.equal(parseReply('```json\n{"summary":"x","files":[{"path":"src/site.css","content":"body{}"}]}\n```').files.length,1);});
const reply:ModelReply={summary:'test',files:[change('export default()=> <main>Text</main>')]};
test('Anthropic adapter sends both visual evidence and measured text',async()=>{let body:any;const model=createModel({provider:'anthropic',model:'test-model',key:'test-only',fetcher:async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(reply)}],usage:{input_tokens:12,output_tokens:7}}));}});assert.deepEqual(await model.complete({prompt:'geometry',images:[{label:'source',base64:'abc'}]},signal()),reply);assert.equal(body.messages[0].content[1].type,'image');assert.equal(model.usage.inputTokens,12);});
test('OpenAI adapter uses Responses images, schema and explicit model',async()=>{let body:any;const model=createModel({provider:'openai',model:'explicit-test',key:'test-only',fetcher:async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(reply)}]}],usage:{input_tokens:3,output_tokens:9}}));}});await model.complete({prompt:'geometry',images:[{label:'source',base64:'abc'}]},signal());assert.equal(body.store,false);assert.equal(body.model,'explicit-test');assert.equal(body.text.format.type,'json_schema');assert.equal(body.input[0].content[1].type,'input_image');});
test('OpenAI adapter forwards max reasoning for Astra-class benchmarks',async()=>{let body:any;const model=createModel({provider:'openai',model:'gpt-6-astra',key:'test-only',reasoningEffort:'max',fetcher:async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(reply)}]}],usage:{input_tokens:1,output_tokens:1}}));}});await model.complete({prompt:'geometry',images:[]},signal());assert.equal(body.reasoning.effort,'max');});
test('truncated output never becomes a successful page',async()=>{const model=createModel({provider:'anthropic',model:'test',key:'test',fetcher:async()=>new Response(JSON.stringify({stop_reason:'max_tokens',content:[{type:'text',text:JSON.stringify(reply)}]}))});await assert.rejects(model.complete({prompt:'x',images:[]},signal()),/incomplete/);});
test('exhausted call budget blocks extra provider calls',async()=>{let calls=0;const model=createModel({provider:'openai',model:'test',key:'test',maxCalls:1,fetcher:async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(reply)}]}]}));}});await model.complete({prompt:'x',images:[]},signal());await assert.rejects(model.complete({prompt:'x',images:[]},signal()),/budget/);assert.equal(calls,1);});
test('provider credentials are redacted from errors',async()=>{const model=createModel({provider:'openai',model:'test',key:'secret-key',fetcher:async()=>new Response('bad secret-key',{status:401})});await assert.rejects(model.complete({prompt:'x',images:[]},signal()),e=>!String(e).includes('secret-key'));});

test('review report embeds source text safely and never substitutes source for missing output',()=>temporary(async dir=>{
  const {writeReview}=await import('../src/reconstruct/report.js');
  const report=join(dir,'review.html');
  await writeReview(report,{status:'needs-work',outDir:dir,reportPath:join(dir,'report.json'),evaluation:score(null),attempts:[],warnings:['</script><script>alert(1)</script>'],blockers:[],usage:{calls:0,inputTokens:0,outputTokens:0},source:{site:'https://example.com',assetCount:0,pages:[]}});
  const html=await readFile(report,'utf8');assert.ok(html.includes('\\u003c/script>'));assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('No generated screenshot is available'));
}));
