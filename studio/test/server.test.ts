import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle, type Services, type Store } from '../server/app.ts';
import { HttpError, sourceUrl, sourcePages, safePath, newJob } from '../server/contracts.ts';
import { seal, unseal, cookie, assertMutation, sealSecret } from '../server/security.ts';
import { createMediaSession, mediaCookie } from '../server/media-session.ts';
const SECRET='a-secure-test-only-value-012345678901234567890123456789';
const ORIGIN='https://moltick.netlify.app';
const ID='3bc27a4d-0bd2-4c1e-a688-97399545bc12';
const USER='11111111-1111-4111-8111-111111111111';
function setup(){
  const map=new Map<string,any>();const store:Store={get:async(k)=>map.get(k)??null,setJSON:async(k,v)=>{map.set(k,structuredClone(v));},set:async(k,v)=>{map.set(k,v);},list:async({prefix})=>({blobs:[...map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}),delete:async(k)=>{map.delete(k);}};
  const calls:any[]=[];
  map.set('auth/owner-binding-v1',{userId:USER,email:'owner@example.test',createdAt:new Date().toISOString()});
  map.set('integrations/owner/github-v1',{ciphertext:sealSecret('github_pat_test_not_real_0123456789',SECRET),login:'acts2man',connectedAt:new Date().toISOString(),deliveryVerifiedAt:new Date().toISOString(),deliveryVersion:1});
  map.set('integrations/owner/netlify-v1',{ciphertext:sealSecret('netlify_test_token_not_real_0123456789',SECRET),teamSlug:'test-team',teamName:'Test Team',connectedAt:new Date().toISOString()});
  const services:Services={store,env:{secret:SECRET,origin:ORIGIN,context:'production'},authenticate:async req=>req.headers.get('authorization')?{id:USER,email:'owner@example.test'}:null,github:async(_t,p,init)=>{calls.push({p,init});if(p==='/user')return{login:'acts2man'};if(p.endsWith('/actions/secrets?per_page=100'))return{secrets:['OPENAI_API_KEY','MOLT_AI_MODEL','MOLT_GITHUB_EXPORT_TOKEN','MOLT_NETLIFY_AUTH_TOKEN','MOLT_NETLIFY_TEAM_SLUG'].map(name=>({name}))};if(p.endsWith('/actions/workflows/reconstruct-site.yml'))return{state:'active'};if(p.includes('dispatches'))return null;if(p.includes('workflows?'))return{workflows:[]};return{permissions:{push:true}};},identifyRunner:async()=>({runId:123}),saveSecrets:async()=>{},checkProvider:async()=>{},checkGithubDelivery:async()=>({verifiedAt:new Date().toISOString()}),checkNetlify:async()=>({teamSlug:'test-team',teamName:'Test Team'})};
  const session=seal({token:'github_pat_test_not_real_0123456789',login:'acts2man',expires:Date.now()+100000},SECRET);
  const req=(path:string,method='GET',body?:any,authenticated=true)=>new Request(ORIGIN+'/api/molt/'+path,{method,headers:{origin:ORIGIN,'x-molt-request':'1','content-type':'application/json',...(authenticated?{authorization:'Bearer supabase-test-session'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{map,services,calls,req};
}
test('public URLs normalize and reject credentials, scripts and private literals',()=>{assert.equal(sourceUrl('ceballostreeservices.com'),'https://ceballostreeservices.com/');for(const u of ['javascript:alert(1)','http://127.0.0.1','https://user:pass@example.com','https://a.local','https://example.com?a=1'])assert.throws(()=>sourceUrl(u));});
test('explicit pages are same-origin and deduplicated',()=>{assert.deepEqual(sourcePages('https://example.com','/\n/about\n/about#team'),['https://example.com/','https://example.com/about']);assert.throws(()=>sourcePages('https://example.com','https://evil.com'));});
test('unsafe bundle paths and executable project manifests are rejected',()=>{for(const p of ['../a.html','/a.html','.env','assets/../secret.txt','package.json','a.sh'])assert.throws(()=>safePath(p));assert.equal(safePath('images/tree.webp'),'images/tree.webp');});
test('sessions are encrypted, authenticated, owner-scoped and expiring',()=>{const original={token:'never-leak-this-token',login:'acts2man',expires:Date.now()+100000};const encoded=seal(original,SECRET);assert.ok(!encoded.includes(original.token));assert.deepEqual(unseal(encoded,SECRET),original);assert.equal(unseal(encoded.slice(1),SECRET),null);assert.equal(unseal(encoded,SECRET+'wrong'),null);assert.equal(unseal(seal({...original,expires:1},SECRET),SECRET),null);assert.equal(unseal(seal({...original,login:'other'},SECRET),SECRET),null);});
test('cookie has security attributes',()=>{for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(cookie('opaque').includes(flag));});
test('cross-origin writes are denied',()=>{assert.throws(()=>assertMutation(new Request(ORIGIN,{method:'POST',headers:{origin:'https://evil.test','x-molt-request':'1'}})));});
test('account session health never returns a credential and reports the shared workspace integration',async()=>{const s=setup();const r=await handle(s.req('session'),s.services);const text=await r.text();assert.ok(!text.includes('github_pat'));const data=JSON.parse(text);assert.equal(data.authenticated,true);assert.equal(data.authorized,true);assert.equal(data.connected,true);assert.equal(data.email,'owner@example.test');});
test('legacy desktop GitHub session migrates into the account-bound workspace without re-entering the token',async()=>{
 const s=setup();s.map.delete('integrations/owner/github-v1');
 const legacy=seal({token:'github_pat_test_not_real_0123456789',login:'acts2man',expires:Date.now()+100000},SECRET);
 const req=new Request(ORIGIN+'/api/molt/session',{headers:{authorization:'Bearer supabase-test-session',cookie:cookie(legacy)}});
 const r=await handle(req,s.services);assert.equal(r.status,200);const info=await r.json();assert.equal(info.connected,true);
 const stored=s.map.get('integrations/owner/github-v1');assert.ok(stored?.ciphertext);assert.ok(!stored.ciphertext.includes('github_pat_test_not_real'));
});
test('configured owner account automatically reclaims the existing owner workspace history',async()=>{
 const s=setup();s.map.delete('auth/owner-binding-v1');s.services.env.ownerUserId=USER;
 s.map.set('jobs/acts2man/'+ID,{...newJob({id:ID,url:'https://example.com'},'acts2man'),status:'needs-work'});
 const session=await handle(s.req('session'),s.services);const info=await session.json();assert.equal(info.authorized,true);
 const binding=s.map.get('auth/owner-binding-v1');assert.equal(binding.userId,USER);
 const rows=await (await handle(s.req('jobs'),s.services)).json();assert.equal(rows.jobs.length,1);
});
test('configured owner account repairs a stale workspace binding',async()=>{
 const s=setup();s.map.set('auth/owner-binding-v1',{userId:'22222222-2222-4222-8222-222222222222',createdAt:new Date().toISOString()});s.services.env.ownerUserId=USER;
 const session=await handle(s.req('session'),s.services);const info=await session.json();assert.equal(info.authorized,true);
 assert.equal(s.map.get('auth/owner-binding-v1').userId,USER);
});
test('a signed-in device sees the same persisted runs without a browser GitHub session',async()=>{
 const s=setup();s.map.set('jobs/acts2man/'+ID,{...newJob({id:ID,url:'https://example.com'},'acts2man'),status:'needs-work'});
 const r=await handle(s.req('jobs'),s.services);assert.equal(r.status,200);const data=await r.json();assert.equal(data.jobs.length,1);
});
test('a different Molt account cannot enter the bound owner workspace',async()=>{
 const s=setup();s.services.authenticate=async()=>({id:'22222222-2222-4222-8222-222222222222',email:'other@example.test'});
 const session=await handle(s.req('session'),s.services);const info=await session.json();assert.equal(info.authenticated,true);assert.equal(info.authorized,false);
 assert.equal((await handle(s.req('jobs'),s.services)).status,403);
});
test('anonymous readers cannot inspect private jobs',async()=>{const s=setup();assert.equal((await handle(s.req('jobs','GET',undefined,false),s.services)).status,401);});
test('no unconfigured model can start a paid job',async()=>{const s=setup();s.services.github=async()=>({secrets:[]});const r=await handle(s.req('jobs','POST',{id:ID,url:'https://example.com',developmentTest:true}),s.services);assert.equal(r.status,409);assert.equal(s.map.size,3);});
test('output repository defaults from the source host and rejects unsafe names',()=>{assert.equal(newJob({id:ID,url:'https://www.example.com'},'acts2man').outputRepo,'example-com-react');assert.throws(()=>newJob({id:ID,url:'https://example.com',outputRepo:'../bad'},'acts2man'));});
test('dispatch calls the actual workflow and a repeated id is not resubmitted',async()=>{const s=setup();for(let i=0;i<2;i++){const r=await handle(s.req('jobs','POST',{id:ID,url:'https://example.com',developmentTest:true}),s.services);assert.ok([200,202].includes(r.status));}assert.equal(s.calls.filter(c=>c.p.includes('dispatches')).length,1);assert.equal(s.map.get('jobs/acts2man/'+ID).status,'queued');});
test('finished reconstructions can be archived restored and filtered from the default list',async()=>{
 const s=setup();const job={...newJob({id:ID,url:'https://example.com'},'acts2man'),status:'needs-work'};s.map.set('jobs/acts2man/'+ID,job);
 assert.equal((await (await handle(s.req('jobs/'+ID+'/archive','POST'),s.services)).json()).archivedAt!=null,true);
 let rows=await (await handle(s.req('jobs'),s.services)).json();assert.equal(rows.jobs.length,0);
 rows=await (await handle(s.req('jobs?includeArchived=1'),s.services)).json();assert.equal(rows.jobs.length,1);assert.ok(rows.jobs[0].archivedAt);
 const restored=await (await handle(s.req('jobs/'+ID+'/restore','POST'),s.services)).json();assert.equal(restored.archivedAt,undefined);
 rows=await (await handle(s.req('jobs'),s.services)).json();assert.equal(rows.jobs.length,1);
});
test('permanent delete removes Molt job images and preview but preserves the generated GitHub repository',async()=>{
 const s=setup();const job={...newJob({id:ID,url:'https://example.com'},'acts2man'),status:'needs-work',outputRepoUrl:'https://github.com/acts2man/example-com-react'};s.map.set('jobs/acts2man/'+ID,job);
 s.map.set('images/acts2man/'+ID+'/view.png',new ArrayBuffer(8));s.map.set('previews/acts2man/'+ID+'/index.html',new ArrayBuffer(8));
 const r=await handle(s.req('jobs/'+ID,'DELETE'),s.services);assert.equal(r.status,200);const body=await r.json();assert.equal(body.deleted,true);assert.equal(body.outputRepoUrl,job.outputRepoUrl);
 assert.equal(s.map.has('jobs/acts2man/'+ID),false);assert.equal([...s.map.keys()].some(k=>k.startsWith('images/acts2man/'+ID+'/')||k.startsWith('previews/acts2man/'+ID+'/')),false);
});
test('active reconstructions cannot be archived or deleted',async()=>{
 const s=setup();s.map.set('jobs/acts2man/'+ID,{...newJob({id:ID,url:'https://example.com'},'acts2man'),status:'running'});
 assert.equal((await handle(s.req('jobs/'+ID+'/archive','POST'),s.services)).status,409);assert.equal((await handle(s.req('jobs/'+ID,'DELETE'),s.services)).status,409);
});
test('dispatch failure is not a success toast or a stuck queued record',async()=>{const s=setup(),gh=s.services.github!;s.services.github=async(t,p,i)=>{if(p.includes('dispatches'))throw new Error('failed');return gh(t,p,i);};const r=await handle(s.req('jobs','POST',{id:ID,url:'https://example.com',developmentTest:true}),s.services);assert.equal(r.status,500);assert.equal(s.map.get('jobs/acts2man/'+ID).status,'error');});
test('GitHub connection validates ownership',async()=>{const s=setup();s.services.github=async()=>({login:'other'});const r=await handle(s.req('connect','POST',{token:'github_pat_not_real_0123456789'}),s.services);assert.equal(r.status,403);});
test('GitHub connection stores the owner token server-side and as an encrypted Actions secret without returning it',async()=>{const s=setup();let saved='';s.services.saveSecrets=async(_t,v)=>{saved=String(v.MOLT_GITHUB_EXPORT_TOKEN??'');};const r=await handle(s.req('connect','POST',{token:'github_pat_not_real_0123456789'}),s.services);assert.equal(r.status,200);assert.equal(saved,'github_pat_not_real_0123456789');assert.ok(!(await r.text()).includes('github_pat_not_real'));const stored=s.map.get('integrations/owner/github-v1');assert.ok(stored?.ciphertext);assert.ok(!stored.ciphertext.includes('github_pat_not_real'));});
test('settings save checks the new model credential and does not persist it in app data',async()=>{const s=setup();let checked=false,saved=false;s.services.checkProvider=async()=>{checked=true;};s.services.saveSecrets=async(_t,v)=>{saved=!!v.OPENAI_API_KEY;};const r=await handle(s.req('settings','POST',{provider:'openai',model:'model-id',apiKey:'private-test-key-0123456789012345'}),s.services);assert.equal(r.status,200);assert.ok(checked&&saved);assert.ok(!JSON.stringify([...s.map.values()]).includes('private-test-key'));assert.ok(!(await r.text()).includes('private-test-key'));});
test('unverified model credential changes nothing',async()=>{const s=setup();s.services.checkProvider=async()=>{throw new Error('bad key');};let saved=false;s.services.saveSecrets=async()=>{saved=true;};const r=await handle(s.req('settings','POST',{provider:'openai',model:'m',apiKey:'private-test-key-0123456789'}),s.services);assert.equal(r.status,500);assert.equal(saved,false);});
test('runner cannot change another workflow run',async()=>{const s=setup();s.map.set('jobs/acts2man/'+ID,{...newJob({id:ID,url:'example.com'},'acts2man'),runId:999});const r=await handle(s.req('runner/'+ID),s.services);assert.equal(r.status,409);});
test('runner data is not accepted without identity verification',async()=>{const s=setup();s.services.identifyRunner=async()=>{throw new Error('invalid identity');};const r=await handle(s.req('runner/'+ID+'/events','POST',{message:'fake'}),s.services);assert.equal(r.status,500);assert.equal(s.map.size,3);});
test('runner progress updates existing work and preserves the run identity',async()=>{const s=setup();s.map.set('jobs/acts2man/'+ID,newJob({id:ID,url:'example.com'},'acts2man'));const r=await handle(s.req('runner/'+ID+'/events','POST',{message:'Capturing desktop'}),s.services);assert.equal(r.status,200);const job=s.map.get('jobs/acts2man/'+ID);assert.equal(job.runId,123);assert.equal(job.status,'running');assert.equal(job.events.length,1);});
test('terminal runner events purge uploaded source bundles',async()=>{
 const s=setup(),prefix='bundles/acts2man/'+ID+'/';
 s.map.set('jobs/acts2man/'+ID,newJob({id:ID,url:'example.com',bundleId:ID},'acts2man'));
 s.map.set(prefix+'manifest',{ready:true});s.map.set(prefix+'files/example',new ArrayBuffer(4));
 const r=await handle(s.req('runner/'+ID+'/events','POST',{message:'done',report:{status:'needs-work',evaluation:{pass:false,issues:[],views:[]},attempts:[],warnings:[],blockers:[]}}),s.services);
 assert.equal(r.status,200);assert.equal([...s.map.keys()].some(k=>k.startsWith(prefix)),false);
});
test('runner milestone progress is stored and never moves backward',async()=>{
 const s=setup();s.map.set('jobs/acts2man/'+ID,newJob({id:ID,url:'example.com'},'acts2man'));
 await handle(s.req('runner/'+ID+'/events','POST',{message:'Generating React',progress:38,progressStage:'Generating React'}),s.services);
 await handle(s.req('runner/'+ID+'/events','POST',{message:'Late preflight callback',progress:12,progressStage:'Preflight complete'}),s.services);
 const job=s.map.get('jobs/acts2man/'+ID);assert.equal(job.progress,38);assert.equal(job.progressStage,'Generating React');assert.ok(job.progressUpdatedAt);
});
test('runner uploads an interactive preview and embedded media uses a short-lived owner cookie',async()=>{
 const s=setup();s.map.set('jobs/acts2man/'+ID,newJob({id:ID,url:'example.com'},'acts2man'));
 const upload=new Request(ORIGIN+'/api/molt/runner/'+ID+'/preview?file=index.html',{method:'PUT',body:new TextEncoder().encode('<!doctype html><title>Preview</title>')});
 assert.equal((await handle(upload,s.services)).status,200);
 await handle(s.req('runner/'+ID+'/events','POST',{message:'preview ready',previewReady:true}),s.services);
 const r=await handle(s.req('preview/'+ID+'/'),s.services);
 assert.equal(r.status,200);assert.match(r.headers.get('content-type')??'',/text\/html/);assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(r.headers.get('content-security-policy')??'',/frame-ancestors 'self'/);assert.match(await r.text(),/Preview/);
 assert.equal((await handle(s.req('preview/'+ID+'/','GET',undefined,false),s.services)).status,401);
 const issued=await handle(s.req('media-session','POST',{}),s.services);assert.equal(issued.status,200);const setCookie=issued.headers.get('set-cookie')??'';assert.match(setCookie,/__Host-molt-media=/);assert.match(setCookie,/Path=\/(?:;|$)/);assert.doesNotMatch(setCookie,/Path=\/api\/molt/);
 const token=mediaCookie(createMediaSession(USER,SECRET));
 const embedded=new Request(ORIGIN+'/api/molt/preview/'+ID+'/',{headers:{cookie:token}});
 const framed=await handle(embedded,s.services);assert.equal(framed.status,200);assert.match(await framed.text(),/Preview/);
});
test('image callback rejects HTML payloads',async()=>{const s=setup();s.map.set('jobs/acts2man/'+ID,newJob({id:ID,url:'example.com'},'acts2man'));const r=await handle(s.req('runner/'+ID+'/images/image.png','PUT',{html:'<script>alert(1)</script>'}),s.services);assert.equal(r.status,415);});

test('production jobs cannot use the owner development runner',async()=>{const s=setup();const r=await handle(s.req('jobs','POST',{id:ID,url:'https://example.com'}),s.services);assert.equal(r.status,400);assert.equal(s.calls.filter(c=>c.p.includes('dispatches')).length,0);});

test('paid development tests are blocked when Netlify deployment is not connected',async()=>{
 const s=setup();s.map.delete('integrations/owner/netlify-v1');
 const r=await handle(s.req('jobs','POST',{id:ID,url:'https://example.com',developmentTest:true}),s.services);
 assert.equal(r.status,409);assert.match(await r.text(),/Connect Netlify hosting/);
});
test('Netlify connection is verified and saved as GitHub Actions secrets without returning the token',async()=>{
 const s=setup();let saved:any={};s.services.saveSecrets=async(_t,v)=>{saved={...saved,...v};};
 const r=await handle(s.req('netlify-connect','POST',{token:'netlify_test_token_not_real_0123456789',teamSlug:'test-team'}),s.services);
 assert.equal(r.status,200);const body=await r.text();assert.ok(!body.includes('netlify_test_token'));
 assert.equal(saved.MOLT_NETLIFY_TEAM_SLUG,'test-team');assert.ok(saved.MOLT_NETLIFY_AUTH_TOKEN);
});
test('runner handoff preserves repository and live Netlify URLs',async()=>{
 const s=setup();s.map.set('jobs/acts2man/'+ID,newJob({id:ID,url:'example.com'},'acts2man'));
 await handle(s.req('runner/'+ID+'/events','POST',{message:'handoff',outputRepoUrl:'https://github.com/acts2man/example-com-react',liveSiteUrl:'https://example-com-react.netlify.app',liveSiteAdminUrl:'https://app.netlify.com/sites/example-com-react'}),s.services);
 const job=s.map.get('jobs/acts2man/'+ID);assert.equal(job.outputRepoUrl,'https://github.com/acts2man/example-com-react');assert.equal(job.liveSiteUrl,'https://example-com-react.netlify.app');
});

test('old GitHub connections are not run-ready until delivery permissions are verified',async()=>{
 const s=setup();const record=s.map.get('integrations/owner/github-v1');delete record.deliveryVerifiedAt;delete record.deliveryVersion;s.map.set('integrations/owner/github-v1',record);
 const settings=await (await handle(s.req('settings'),s.services)).json();assert.equal(settings.githubDeliveryReady,false);assert.equal(settings.ready,false);
 const r=await handle(s.req('jobs','POST',{id:ID,url:'https://example.com',developmentTest:true}),s.services);
 assert.equal(r.status,409);assert.match(await r.text(),/Verify GitHub delivery permissions/);assert.equal(s.calls.filter(c=>c.p.includes('dispatches')).length,0);
});
test('GitHub delivery verification upgrades the stored connection before any job is submitted',async()=>{
 const s=setup();const record=s.map.get('integrations/owner/github-v1');delete record.deliveryVerifiedAt;delete record.deliveryVersion;s.map.set('integrations/owner/github-v1',record);
 const r=await handle(s.req('github-delivery-check','POST'),s.services);assert.equal(r.status,200);
 const stored=s.map.get('integrations/owner/github-v1');assert.equal(stored.deliveryVersion,1);assert.ok(stored.deliveryVerifiedAt);
});
test('failed GitHub delivery verification clears readiness and returns the exact verification error',async()=>{
 const s=setup();s.services.checkGithubDelivery=async()=>{throw new HttpError(409,'GitHub delivery verification failed at workflow file write. Set Workflows to Read & write.');};
 const r=await handle(s.req('github-delivery-check','POST'),s.services);assert.equal(r.status,409);assert.match(await r.text(),/Workflows to Read & write/);
 const stored=s.map.get('integrations/owner/github-v1');assert.equal(stored.deliveryVerifiedAt,undefined);assert.equal(stored.deliveryVersion,undefined);
});
