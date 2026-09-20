import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { improves, routePath, routeFile, publicUrl, publicIP, inside, integer, validateViewports, safeEnvironment } from '../src/reconstruct/policy.js';
import { validateChanges, apply, snapshot, restore } from '../src/reconstruct/workspace.js';
import { repairLoop } from '../src/reconstruct/loop.js';
import { createModel, parseReply } from '../src/reconstruct/provider.js';
import { readBundle, adaptiveViewports, geometryFingerprint, prioritizeDiscoveredLinks } from '../src/reconstruct/capture.js';
import { serve } from '../src/reconstruct/runtime.js';
import { referenceImages, repairImages } from '../src/reconstruct/images.js';
import { PNG } from 'pngjs';
import type { Evaluation, FileChange, ModelReply, Evidence, Geometry } from '../src/reconstruct/types.js';
import { reconstructionPrompt, rejectedRepairAutopsy, protectedPromptPaths, assertNoPartialFileRewrite, assertInitialGenerationIsolation, selectRepairRoute } from '../src/reconstruct/agent.js';
import { effectiveRepairRounds, productionRunBudget } from '../src/reconstruct/budgets.js';
import { spacingIssues, contentIssues, internalLinkIssues, mediaGeometryIssues, controlGeometryIssues } from '../src/reconstruct/evaluate.js';
const score=(n:number|null,pass=false):Evaluation=>({pass,issues:[],views:[{route:'/',viewport:'desktop',source:'source.png',score:n,worstBand:n,pass,issues:[]}]});
const signal=()=>new AbortController().signal;
async function temporary(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'molt-agent-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('route mapping prevents collisions across nested, dotted and punctuation routes',()=>assert.equal(new Set(['/a/b','/a.b','/a-b','/'].map(routeFile)).size,4));
test('route validation rejects traversal, encoded traversal and protocol-relative routes',()=>{for(const s of ['//evil','/../outside','/%2e%2e/out','/a?x=1','/a\\b','/%2f%2fevil'])assert.throws(()=>routePath(s));});
test('same route has stable filename and trailing slash normalization',()=>{assert.equal(routeFile('/about/'),routeFile('/about'));assert.equal(routePath('/'),' /'.trim());});
test('internal navigation must stay inside the reconstructed route map',()=>{
  const source=simpleGeometry([]),candidate=simpleGeometry([]);
  source.links=['https://example.com/','https://example.com/about'];
  candidate.links=['http://127.0.0.1:4173/','https://example.com/about'];
  const issues=internalLinkIssues(source,candidate,'https://example.com','http://127.0.0.1:4173',new Set(['/','/about']));
  assert.ok(issues.some(i=>/source website.*\/about/.test(i)),issues.join('\n'));
  assert.ok(issues.some(i=>/Missing reconstructed internal link target: \/about/.test(i)),issues.join('\n'));
});
test('partially supplied current files are protected from full replacement',()=>{
  const prompt=JSON.stringify({currentFiles:[{path:'src/site.css',content:'partial',complete:false},{path:'src/pages/home.tsx',content:'full',complete:true}]});
  assert.deepEqual([...protectedPromptPaths(prompt)],['src/site.css']);
  assert.throws(()=>assertNoPartialFileRewrite(prompt,[{path:'src/site.css',content:'replacement'}]),/partially supplied/);
  assert.doesNotThrow(()=>assertNoPartialFileRewrite(prompt,[{path:'src/pages/home.tsx',content:'replacement'}]));
});
test('source URL validation rejects unsafe schemes and credentials',()=>{for(const u of ['file:///etc/passwd','data:text/html,a','javascript:alert(1)','https://user:password@example.com'])assert.throws(()=>publicUrl(u));assert.equal(publicUrl('example.com').origin,'https://example.com');});
test('reserved networks are denied',()=>{for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1','198.51.100.1'])assert.equal(publicIP(ip),false,ip);assert.equal(publicIP('8.8.8.8'),true);});
test('numeric and viewport limits are explicit',()=>{assert.equal(integer(undefined,6,0,20),6);for(const n of ['','-1','21','NaN','1.5'])assert.throws(()=>integer(n,6,0,20));assert.throws(()=>validateViewports([]));assert.throws(()=>validateViewports([{name:'../x',width:390,height:844}]));});
test('adaptive viewport probes derive meaningful source breakpoints without duplicating the base matrix',()=>{
  const probes=adaptiveViewports(['(max-width: 1200px)','(max-width: 1024px)','(max-width: 430px)','(min-width: 375px)'],[
    {name:'desktop',width:1440,height:900},{name:'tablet',width:768,height:1024},{name:'mobile',width:390,height:844}
  ]);
  assert.deepEqual(probes.map(v=>v.width),[1024,430]);
  assert.ok(probes.every(v=>!['desktop','tablet','mobile'].includes(v.name)));
});
test('child environment excludes provider credentials',()=>{process.env.MOLT_TEST_PRIVATE_VALUE='secret';assert.equal(safeEnvironment().MOLT_TEST_PRIVATE_VALUE,undefined);delete process.env.MOLT_TEST_PRIVATE_VALUE;});
test('high-fidelity repair scope expands only enough to cover multi-page jobs',()=>{
  assert.equal(effectiveRepairRounds(1,4),4);
  assert.equal(effectiveRepairRounds(7,4),7);
  assert.equal(effectiveRepairRounds(7,2),2);
  assert.equal(effectiveRepairRounds(7,0),0);
});
test('production budgets scale time and provider ceilings without changing low-cost defaults',()=>{
  const one=productionRunBudget(1,2,'medium');assert.equal(one.repairRounds,2);assert.equal(one.agentMinutes,25);assert.equal(one.requestMs,180000);
  const multi=productionRunBudget(7,4,'medium');assert.equal(multi.repairRounds,7);assert.ok(multi.agentMinutes>=55);assert.ok(multi.maxModelCalls>=35);
  const max=productionRunBudget(7,4,'max');assert.equal(max.requestMs,540000);assert.equal(max.maxOutputTokens,40000);
});
test('later initial pages cannot rewrite existing shared or earlier-route files',()=>{
  const before:FileChange[]=[{path:'src/site.css',content:'body{margin:0}'},{path:'src/components/Header.tsx',content:'export const Header=()=>null'},{path:'src/pages/home.tsx',content:'export default()=>null'}];
  assert.throws(()=>assertInitialGenerationIsolation(before,[{path:'src/site.css',content:'body{margin:10px}'}],'src/pages/about.tsx',1),/cannot rewrite existing/);
  assert.doesNotThrow(()=>assertInitialGenerationIsolation(before,[{path:'src/styles/about.css',content:'.about{}'},{path:'src/pages/about.tsx',content:'export default()=>null'}],'src/pages/about.tsx',1));
  assert.doesNotThrow(()=>assertInitialGenerationIsolation(before,[{path:'src/site.css',content:'body{margin:10px}'}],'src/pages/home.tsx',0));
});
test('multi-page repair scheduling gives unattempted failing routes priority',()=>{
  const evaluation:Evaluation={pass:false,issues:[],views:[
    {route:'/a',viewport:'desktop',source:'a.png',score:70,worstBand:30,pass:false,issues:['bad']},
    {route:'/b',viewport:'desktop',source:'b.png',score:80,worstBand:50,pass:false,issues:['bad']},
  ]};
  const attempts=new Map<string,number>();
  assert.equal(selectRepairRoute(evaluation,attempts),'/a');attempts.set('/a',1);
  assert.equal(selectRepairRoute(evaluation,attempts),'/b');
});
const simpleGeometry=(elements:Geometry['elements']):Geometry=>({text:elements.map(e=>e.text).filter(Boolean).join(' '),title:'Spacing test',height:1000,overflow:false,brokenImages:0,elements,links:[],embeds:[],forms:0,fontFaces:[],mediaQueries:[],truncated:false});
test('source geometry fingerprints are stable for identical evidence and change for visible layout changes',()=>{
  const base=simpleGeometry([{key:'1',tag:'h1',text:'Stable title',x:40,y:80,width:600,height:60,style:{}}]);
  const same=structuredClone(base),changed=structuredClone(base);changed.elements[0].y=120;
  assert.equal(geometryFingerprint(base),geometryFingerprint(same));
  assert.notEqual(geometryFingerprint(base),geometryFingerprint(changed));
});
test('media geometry diagnostics identify exact localized image placement deltas without guessing by DOM order',()=>{
  const source=simpleGeometry([{key:'1',tag:'img',text:'',x:100,y:200,width:500,height:300,style:{},src:'https://source.example/hero.jpg',attributes:{alt:'Hero'}}]);
  const candidate=simpleGeometry([
    {key:'a',tag:'img',text:'',x:5,y:5,width:20,height:20,style:{},src:'http://generated.test/assets/other.jpg'},
    {key:'b',tag:'img',text:'',x:124,y:222,width:460,height:320,style:{},src:'http://generated.test/assets/hero-hash.jpg',attributes:{alt:'Hero'}}
  ]);
  const evidence={site:'https://source.example',directory:'',pages:[],assets:[{original:'https://source.example/hero.jpg',file:'/tmp/hero.jpg',publicPath:'/assets/hero-hash.jpg'}],fontFaces:[],warnings:[],blockers:[],integrations:[]} as Evidence;
  const issues=mediaGeometryIssues(source,candidate,evidence);assert.equal(issues.length,1);assert.match(issues[0],/Image "Hero"/);assert.match(issues[0],/delta x 24, y 22, width -40, height 20px/);
});
test('control geometry diagnostics report measured button box mismatch',()=>{
  const source=simpleGeometry([{key:'1',tag:'button',text:'Get Started',x:100,y:200,width:180,height:48,style:{},attributes:{}}]);
  const candidate=simpleGeometry([{key:'2',tag:'button',text:'Get Started',x:100,y:212,width:204,height:56,style:{},attributes:{}}]);
  const issues=controlGeometryIssues(source,candidate);assert.equal(issues.length,1);assert.match(issues[0],/Control "Get Started"/);assert.match(issues[0],/delta x 0, y 12, width 24, height 8px/);
});

test('spacing evaluator reports exact element-to-element gap deltas',()=>{
  const style={'font-family':'Arvo','font-size':'16px','line-height':'24px','letter-spacing':'0px',margin:'0px',padding:'0px'};
  const source=simpleGeometry([
    {key:'1',parent:'p',tag:'h2',text:'Our Services',x:100,y:100,width:400,height:40,style},
    {key:'2',parent:'p',tag:'p',text:'Professional tree care for Sacramento.',x:100,y:168,width:500,height:48,style},
  ]);
  const candidate=simpleGeometry([
    {key:'a',parent:'q',tag:'h2',text:'Our Services',x:100,y:100,width:400,height:40,style},
    {key:'b',parent:'q',tag:'p',text:'Professional tree care for Sacramento.',x:100,y:190,width:500,height:48,style},
  ]);
  const issues=spacingIssues(source,candidate);
  assert.ok(issues.some(i=>/source 28px, generated 50px \(22px too large\)/.test(i)),issues.join('\n'));
});
test('spacing evaluator grades paragraph line-height and letter spacing',()=>{
  const base={'font-family':'Arvo','font-size':'16px','line-height':'24px','letter-spacing':'0px',margin:'0px',padding:'0px'};
  const source=simpleGeometry([{key:'1',parent:'p',tag:'p',text:'Measured paragraph rhythm.',x:20,y:20,width:400,height:48,style:base}]);
  const candidate=simpleGeometry([{key:'a',parent:'q',tag:'p',text:'Measured paragraph rhythm.',x:20,y:20,width:400,height:56,style:{...base,'line-height':'28px','letter-spacing':'0.5px'}}]);
  const issues=spacingIssues(source,candidate);
  assert.ok(issues.some(i=>/line-height source 24px, generated 28px/.test(i)&&/letter-spacing source 0px, generated 0.5px/.test(i)),issues.join('\n'));
});
test('typography evaluator catches lost bold italic and text alignment',()=>{
  const normal={'font-family':'Arvo','font-size':'16px','font-weight':'400','font-style':'normal','line-height':'24px','letter-spacing':'0px','text-align':'left','text-transform':'none',margin:'0px',padding:'0px'};
  const source=simpleGeometry([
    {key:'1',parent:'root',tag:'strong',text:'Free estimate',x:100,y:20,width:90,height:24,style:{...normal,'font-weight':'700'}},
    {key:'2',parent:'root',tag:'em',text:'Family owned',x:100,y:52,width:100,height:24,style:{...normal,'font-style':'italic'}},
    {key:'3',parent:'root',tag:'p',text:'Centered promise',x:300,y:90,width:400,height:24,style:{...normal,'text-align':'center'}},
  ]);
  const candidate=simpleGeometry([
    {key:'a',parent:'root2',tag:'span',text:'Free estimate',x:100,y:20,width:90,height:24,style:normal},
    {key:'b',parent:'root2',tag:'span',text:'Family owned',x:100,y:52,width:100,height:24,style:normal},
    {key:'c',parent:'root2',tag:'p',text:'Centered promise',x:100,y:90,width:400,height:24,style:normal},
  ]);
  const issues=spacingIssues(source,candidate);
  assert.ok(issues.some(i=>/Free estimate/.test(i)&&/font-weight source 700, generated 400/.test(i)),issues.join('\n'));
  assert.ok(issues.some(i=>/Family owned/.test(i)&&/font-style source italic, generated normal/.test(i)),issues.join('\n'));
  assert.ok(issues.some(i=>/Centered promise/.test(i)&&/text-align source center, generated left/.test(i)),issues.join('\n'));
  assert.ok(issues.some(i=>/Horizontal alignment "Centered promise"/.test(i)),issues.join('\n'));
});
test('lost strong text is detected even when flattened into an ordinary paragraph',()=>{
  const normal={'font-family':'Arvo','font-size':'16px','font-weight':'400','font-style':'normal','line-height':'24px','letter-spacing':'0px','text-align':'left','text-transform':'none',margin:'0px',padding:'0px'};
  const source=simpleGeometry([
    {key:'1',parent:'p',tag:'p',text:'Call today for a .',x:50,y:20,width:420,height:24,style:normal},
    {key:'2',parent:'p',tag:'strong',text:'free estimate',x:180,y:20,width:95,height:24,style:{...normal,'font-weight':'700'}},
  ]);
  const candidate=simpleGeometry([{key:'a',parent:'q',tag:'p',text:'Call today for a free estimate.',x:50,y:20,width:420,height:24,style:normal}]);
  const issues=spacingIssues(source,candidate);
  assert.ok(issues.some(i=>/free estimate/.test(i)&&/font-weight source 700, generated 400/.test(i)),issues.join('\n'));
});
test('heading evaluator also enforces italic and text alignment',()=>{
  const base={'font-family':'Arvo','font-size':'42px','font-weight':'700','font-style':'italic','line-height':'48px','letter-spacing':'0px','text-align':'center','text-transform':'none'};
  const source=simpleGeometry([{key:'1',parent:'root',tag:'h2',text:'Tree Experts',x:200,y:40,width:600,height:50,style:base}]);
  const candidate=simpleGeometry([{key:'a',parent:'root2',tag:'h2',text:'Tree Experts',x:200,y:40,width:600,height:50,style:{...base,'font-style':'normal','text-align':'left'}}]);
  const issues=contentIssues(source,candidate);
  assert.ok(issues.some(i=>/Heading Tree Experts/.test(i)&&/font-style/.test(i)&&/text-align/.test(i)),issues.join('\n'));
});
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
test('large page gains can be retained while a still-failing interaction temporarily regresses',()=>{
  const make=(viewport:string,scoreValue:number,worst:number,menuScore:number,menuWorst:number):Evaluation['views'][number]=>({
    route:'/',viewport,source:'source.png',score:scoreValue,worstBand:worst,pass:false,issues:['page mismatch'],
    interactions:[{id:'menu',trigger:{kind:'button',name:'Navigation Menu'},source:'source-menu.png',score:menuScore,worstBand:menuWorst,pass:false,issues:['menu mismatch']}]
  });
  const before:Evaluation={pass:false,issues:[],views:[
    make('desktop',85.66,37.97,89.89,65.44),make('tablet',82.21,23.37,86.39,60.89),make('mobile',83.10,19.54,85.83,43.74)
  ]};
  const after:Evaluation={pass:false,issues:[],views:[
    make('desktop',87.93,55.51,83.11,34.91),make('tablet',84.75,59.66,81.84,52.83),make('mobile',86.02,55.08,82.40,23.05)
  ]};
  assert.equal(improves(before,after),true);
});
test('a passing interaction can never be broken to improve the rest of the page',()=>{
  const before=score(85);before.views[0].worstBand=38;before.views[0].interactions=[{id:'menu',trigger:{kind:'button',name:'Navigation Menu'},source:'menu.png',score:98,worstBand:95,pass:true,issues:[]}];
  const after=structuredClone(before);after.views[0].score=96;after.views[0].worstBand=90;after.views[0].interactions![0].score=70;after.views[0].interactions![0].worstBand=45;after.views[0].interactions![0].pass=false;after.views[0].interactions![0].issues=['menu mismatch'];
  assert.equal(improves(before,after),false);
});

test('rejected repair autopsy exposes gains and regressions for the next model round',()=>{
  const best=score(90);best.views[0].worstBand=70;best.views.push({...best.views[0],viewport:'mobile',score:88,worstBand:68,pass:false,issues:['mobile spacing']});
  const rejected=structuredClone(best);rejected.views[0].score=93;rejected.views[0].worstBand=78;rejected.views[1].score=86.5;rejected.views[1].worstBand=66;rejected.views[1].issues=['mobile spacing','new overflow'];
  const autopsy=rejectedRepairAutopsy(best,[{round:1,accepted:false,summary:'Rejected regression',evaluation:rejected,digest:'x'}],'/');
  assert.equal(autopsy?.round,1);
  assert.deepEqual(autopsy?.views.map(v=>[v.viewport,v.delta.score,v.delta.worstBand]),[['desktop',3,8],['mobile',-1.5,-2]]);
  assert.deepEqual(autopsy?.views[1].issues.added,['new overflow']);
});
test('malformed evaluator success and changed scope cannot pass',()=>{assert.equal(improves(score(50),score(null,true)),false);const next=score(99,true);next.views[0].viewport='mobile';assert.equal(improves(score(50),next),false);});
test('asset paths cannot escape a bundle through a symlink',()=>temporary(async dir=>{await writeFile(join(dir,'page.html'),'x');assert.equal(await inside(dir,'page.html'),join(dir,'page.html'));await symlink('/etc/passwd',join(dir,'escape'));await assert.rejects(inside(dir,'escape'));await assert.rejects(inside(dir,'../outside'));}));
test('page discovery keeps navigation first while filling scope from main and footer links',()=>{
  const links=prioritizeDiscoveredLinks([
    {href:'https://example.com/privacy',region:'footer',index:8},
    {href:'https://example.com/service',region:'main',index:4},
    {href:'https://example.com/about',region:'header',index:2},
    {href:'https://example.com/about',region:'footer',index:9},
    {href:'https://example.com/contact',region:'nav',index:1},
  ]);
  assert.deepEqual(links,['https://example.com/contact','https://example.com/about','https://example.com/service','https://example.com/privacy']);
});
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

test('initial reconstruction prompt includes explicit source spacing measurements',()=>{
  const style={display:'block','font-family':'Arvo','font-size':'18px','line-height':'27px','letter-spacing':'0px',margin:'0px',padding:'0px'};
  const geometry=simpleGeometry([
    {key:'1',parent:'section-1',tag:'h2',text:'Welcome',x:100,y:100,width:500,height:42,style},
    {key:'2',parent:'section-1',tag:'p',text:'Exact spacing should be reconstructed.',x:100,y:174,width:600,height:54,style},
  ]);
  const page={route:'/',url:'https://example.com/',title:'Spacing',views:[{viewport:{name:'desktop',width:1440,height:900},screenshot:'source.png',geometry}]};
  const evidence:Evidence={site:'https://example.com',directory:'/tmp',pages:[page],assets:[],fontFaces:[],warnings:[],blockers:[],integrations:[]};
  const prompt=JSON.parse(reconstructionPrompt(evidence,page,[],'Implement spacing exactly'));
  assert.equal(prompt.reference.views[0].spacing.between[0].gap,32);
  assert.equal(prompt.reference.views[0].spacing.textRhythm[0].lineHeight,'27px');
});
test('initial reconstruction prompt preserves emphasis and alignment measurements',()=>{
  const style={display:'block','font-family':'Arvo','font-size':'18px','font-weight':'700','font-style':'italic','line-height':'27px','letter-spacing':'0px','text-align':'center','text-transform':'uppercase',margin:'0px',padding:'0px'};
  const geometry=simpleGeometry([{key:'1',parent:'section-1',tag:'strong',text:'Important',x:300,y:100,width:120,height:27,style}]);
  const page={route:'/',url:'https://example.com/',title:'Type',views:[{viewport:{name:'desktop',width:1440,height:900},screenshot:'source.png',geometry}]};
  const evidence:Evidence={site:'https://example.com',directory:'/tmp',pages:[page],assets:[],fontFaces:[],warnings:[],blockers:[],integrations:[]};
  const prompt=JSON.parse(reconstructionPrompt(evidence,page,[],'Implement typography exactly'));
  const evidenceRow=prompt.reference.views[0].spacing.textRhythm[0];
  assert.equal(evidenceRow.fontWeight,'700');assert.equal(evidenceRow.fontStyle,'italic');assert.equal(evidenceRow.textAlign,'center');assert.equal(evidenceRow.textTransform,'uppercase');
});
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
  const saved={html:'<html>'+('saved-structure '.repeat(12000))+'</html>',styles:Array.from({length:24},(_,i)=>({path:'style-'+i+'.css',content:('selector{font-family:Arvo;padding:24px;}').repeat(500)})),note:'saved evidence'};
  const hybrid=reconstructionPrompt(evidence,page,[{path:'src/site.css',content:'a{display:block}'.repeat(30000)}],'Implement hybrid page',saved);
  assert.ok(hybrid.length<=300000,'hybrid prompt was '+hybrid.length+' chars');
  const baseline=reconstructionPrompt(evidence,page,[{path:'src/site.css',content:'a{display:block}'.repeat(30000)}],'Implement hybrid page');
  const parsed=JSON.parse(hybrid),baseParsed=JSON.parse(baseline);
  const liveGeometry=(value:any)=>value.reference?.views?.[0]?.geometry?.length??0;
  assert.ok(liveGeometry(parsed)>=liveGeometry(baseParsed),'saved evidence reduced live geometry from '+liveGeometry(baseParsed)+' to '+liveGeometry(parsed));
  assert.equal(Boolean(parsed.reference?.views?.[0]?.outline),Boolean(baseParsed.reference?.views?.[0]?.outline),'saved evidence changed the live-evidence fallback mode');
  if(parsed.savedSource)assert.ok(parsed.savedSource.html.length<=26001,'saved HTML should be supplemental and bounded');
});
test('adaptive viewport reference evidence stays within provider image count while retaining every viewport overview',async()=>temporary(async dir=>{
  const path=join(dir,'reference.png'),png=new PNG({width:320,height:3600});png.data.fill(240);for(let i=3;i<png.data.length;i+=4)png.data[i]=255;await writeFile(path,PNG.sync.write(png));
  const names=['desktop','tablet','mobile','probe-1024','probe-430'],widths=[1440,768,390,1024,430];
  const views=names.map((name,index)=>({viewport:{name,width:widths[index],height:900},screenshot:path,geometry:simpleGeometry([]),interactions:[]}));
  const images=await referenceImages(views as any);assert.ok(images.length<=18,images.map(i=>i.label).join('\n'));
  for(const name of names)assert.ok(images.some(image=>image.label.startsWith(name+' complete source overview')),name);
}));
test('repair evidence prioritizes the worst failing adaptive viewport instead of the first three widths',async()=>temporary(async dir=>{
  const path=join(dir,'repair-priority.png'),png=new PNG({width:320,height:900});png.data.fill(230);for(let i=3;i<png.data.length;i+=4)png.data[i]=255;await writeFile(path,PNG.sync.write(png));
  const checks=[
    {route:'/',viewport:'desktop',source:path,candidate:path,diff:path,score:99,worstBand:98,worstY:0,pass:true,issues:[]},
    {route:'/',viewport:'tablet',source:path,candidate:path,diff:path,score:98,worstBand:97,worstY:0,pass:true,issues:[]},
    {route:'/',viewport:'mobile',source:path,candidate:path,diff:path,score:96,worstBand:90,worstY:0,pass:false,issues:['mobile']},
    {route:'/',viewport:'probe-1024',source:path,candidate:path,diff:path,score:80,worstBand:35,worstY:0,pass:false,issues:['breakpoint']}
  ];
  const images=await repairImages(checks as any);assert.ok(images.some(image=>image.label.startsWith('probe-1024 SOURCE')),images.map(i=>i.label).join('\n'));
}));
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
