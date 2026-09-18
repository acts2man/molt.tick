import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSession,readSession,revokeSession,sessionStorageKey} from '../server/sessions.ts';
import {handle,type Services,type Store} from '../server/app.ts';
import {cookie} from '../server/security.ts';
const ORIGIN='https://moltick.netlify.app';
function setup(){
 const map=new Map<string,any>();const store:Store={get:async(k)=>map.get(k)??null,setJSON:async(k,v)=>{map.set(k,structuredClone(v));},set:async(k,v)=>{map.set(k,v);},list:async({prefix})=>({blobs:[...map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}),delete:async(k)=>{map.delete(k);}};
 const session='s_'+'a'.repeat(64);map.set(sessionStorageKey(session),{version:1,session:{token:'github_pat_test_not_real_0123456789',login:'acts2man',expires:Date.now()+100000}});
 const services:Services={store,env:{secret:'',origin:ORIGIN,context:'production'},github:async(_t,p)=>p==='/user'?{login:'acts2man'}:{permissions:{push:true},workflows:[]},saveSecrets:async()=>{}};
 const req=(path:string,method='GET',body?:any,authenticated=true)=>new Request(ORIGIN+'/api/molt/'+path,{method,headers:{origin:ORIGIN,'x-molt-request':'1','content-type':'application/json',...(authenticated?{cookie:cookie(session)}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return{map,services,req};
}
test('opaque sessions need no deployment secret and expose no access token',async()=>{
 const s=setup(),token='github_pat_live_format_test_only_0123456789';
 const r=await handle(s.req('connect','POST',{token},false),s.services);
 assert.equal(r.status,200);const setCookie=r.headers.get('set-cookie')!;
 assert.match(setCookie,/__Host-molt-session=s_[A-Za-z0-9_-]{64};/);
 assert.ok(!setCookie.includes(token));assert.ok(!(await r.text()).includes(token));
 const req=new Request(ORIGIN+'/api/molt/session',{headers:{cookie:setCookie}});
 const body=await(await handle(req,s.services)).json();assert.equal(body.connected,true);assert.equal(body.serverReady,true);
});
test('concurrent owner sessions are distinct and independently revocable',async()=>{
 const s=setup(),token='github_pat_test_not_real_0123456789';
 const ids=await Promise.all([createSession(s.services.store,token,'acts2man'),createSession(s.services.store,token,'acts2man')]);assert.notEqual(ids[0],ids[1]);
 const req=(id:string)=>new Request(ORIGIN,{headers:{cookie:cookie(id)}});
 assert.equal((await readSession(req(ids[0]),s.services.store))?.token,token);
 await revokeSession(req(ids[0]),s.services.store);assert.equal(await readSession(req(ids[0]),s.services.store),null);
 assert.equal((await readSession(req(ids[1]),s.services.store))?.token,token);
});
test('expired or non-owner sessions are rejected and removed',async()=>{
 const s=setup();for(const value of [{login:'other',expires:Date.now()+10000},{login:'acts2man',expires:1}]){
 const id='s_'+'b'.repeat(64);s.map.set(sessionStorageKey(id),{version:1,session:{token:'github_pat_test_not_real_0123456789',...value}});
 assert.equal(await readSession(new Request(ORIGIN,{headers:{cookie:cookie(id)}}),s.services.store),null);assert.equal(s.map.has(sessionStorageKey(id)),false);
 }
});
test('logout revokes the server session, not only the cookie',async()=>{
 const s=setup();assert.equal((await handle(s.req('disconnect','POST'),s.services)).status,200);assert.equal((await handle(s.req('jobs'),s.services)).status,401);
});
test('readiness fails when the actual storage backend is unavailable',async()=>{
 const s=setup();s.services.store.get=async()=>{throw new Error('store unavailable');};
 const r=await handle(s.req('session','GET',undefined,false),s.services);assert.equal(r.status,500);
 assert.ok(!(await r.text()).includes('serverReady'));
});
test('unknown or malformed session identifiers never authenticate',async()=>{
 const s=setup();for(const value of ['bad','s_'+'c'.repeat(64),'s_../credentials'])assert.equal(await readSession(new Request(ORIGIN,{headers:{cookie:cookie(value)}}),s.services.store),null);
});
