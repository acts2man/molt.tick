import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSession,readSession,revokeSession,sessionStorageKey} from '../server/sessions.ts';
import {handle,type Services,type Store} from '../server/app.ts';
import {cookie,sealSecret} from '../server/security.ts';

const ORIGIN='https://moltick.netlify.app';
const SECRET='a-secure-test-only-value-012345678901234567890123456789';
const USER='11111111-1111-4111-8111-111111111111';

function setup(){
 const map=new Map<string,any>();const store:Store={get:async(k)=>map.get(k)??null,setJSON:async(k,v)=>{map.set(k,structuredClone(v));},set:async(k,v)=>{map.set(k,v);},list:async({prefix})=>({blobs:[...map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}),delete:async(k)=>{map.delete(k);}};
 const session='s_'+'a'.repeat(64);map.set(sessionStorageKey(session),{version:1,session:{token:'github_pat_test_not_real_0123456789',login:'acts2man',expires:Date.now()+100000}});
 map.set('auth/owner-binding-v1',{userId:USER,email:'owner@example.test',createdAt:new Date().toISOString()});
 map.set('integrations/owner/github-v1',{ciphertext:sealSecret('github_pat_test_not_real_0123456789',SECRET),login:'acts2man',connectedAt:new Date().toISOString()});
 const services:Services={store,env:{secret:SECRET,origin:ORIGIN,context:'production'},authenticate:async req=>req.headers.get('authorization')?{id:USER,email:'owner@example.test'}:null,github:async(_t,p)=>p==='/user'?{login:'acts2man'}:{permissions:{push:true},workflows:[]},saveSecrets:async()=>{}};
 const req=(path:string,authenticated=true)=>new Request(ORIGIN+'/api/molt/'+path,{headers:{...(authenticated?{authorization:'Bearer account-session'}:{})}});
 return{map,services,req,session};
}

test('legacy opaque sessions remain encrypted and expose no access token',async()=>{
 const s=setup(),token='github_pat_live_format_test_only_0123456789';
 const id=await createSession(s.services.store,token,'acts2man');
 assert.match(cookie(id),/__Host-molt-session=s_[A-Za-z0-9_-]{64};/);
 assert.ok(!cookie(id).includes(token));
 const req=new Request(ORIGIN,{headers:{cookie:cookie(id)}});
 assert.equal((await readSession(req,s.services.store))?.token,token);
});

test('concurrent legacy owner sessions are distinct and independently revocable',async()=>{
 const s=setup(),token='github_pat_test_not_real_0123456789';
 const ids=await Promise.all([createSession(s.services.store,token,'acts2man'),createSession(s.services.store,token,'acts2man')]);assert.notEqual(ids[0],ids[1]);
 const req=(id:string)=>new Request(ORIGIN,{headers:{cookie:cookie(id)}});
 assert.equal((await readSession(req(ids[0]),s.services.store))?.token,token);
 await revokeSession(req(ids[0]),s.services.store);assert.equal(await readSession(req(ids[0]),s.services.store),null);
 assert.equal((await readSession(req(ids[1]),s.services.store))?.token,token);
});

test('expired or non-owner legacy sessions are rejected and removed',async()=>{
 const s=setup();for(const value of [{login:'other',expires:Date.now()+10000},{login:'acts2man',expires:1}]){
 const id='s_'+'b'.repeat(64);s.map.set(sessionStorageKey(id),{version:1,session:{token:'github_pat_test_not_real_0123456789',...value}});
 assert.equal(await readSession(new Request(ORIGIN,{headers:{cookie:cookie(id)}}),s.services.store),null);assert.equal(s.map.has(sessionStorageKey(id)),false);
 }
});

test('legacy browser cookie alone no longer authenticates the Studio API',async()=>{
 const s=setup();const req=new Request(ORIGIN+'/api/molt/jobs',{headers:{cookie:cookie(s.session)}});
 assert.equal((await handle(req,s.services)).status,401);
});

test('readiness fails when the actual storage backend is unavailable',async()=>{
 const s=setup();s.services.store.get=async()=>{throw new Error('store unavailable');};
 const r=await handle(s.req('session'),s.services);assert.equal(r.status,500);
 assert.ok(!(await r.text()).includes('serverReady'));
});

test('unknown or malformed legacy session identifiers never authenticate',async()=>{
 const s=setup();for(const value of ['bad','s_'+'c'.repeat(64),'s_../credentials'])assert.equal(await readSession(new Request(ORIGIN,{headers:{cookie:cookie(value)}}),s.services.store),null);
});
