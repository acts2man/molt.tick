import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../icons';
import { PublicFrame } from './Landing';

const SUPABASE_URL='https://xdvnencecwzygfsojuty.supabase.co';
const SUPABASE_KEY='sb_publishable_7aSCb10hgJLMVtnqKS44ew_ZD_1BWIF';
const STORAGE='molt-customer-session';

type Tokens={access_token:string;refresh_token:string;expires_in:number;token_type:string;user?:{id:string;email?:string}};
type Workspace={id:string;name:string;plan:string;status:string};
type Subscription={plan:string;status:string;current_period_end:string|null;cancel_at_period_end:boolean};
type CreditAccount={available:number;reserved:number;lifetime_granted:number;lifetime_spent:number};

const headers=(token?:string)=>({'content-type':'application/json','apikey':SUPABASE_KEY,...(token?{'authorization':`Bearer ${token}`}:{})});
async function request<T>(path:string, init:RequestInit={}):Promise<T>{
  const res=await fetch(SUPABASE_URL+path,{...init,headers:{...headers(),...init.headers}});
  const text=await res.text();let data:any={};try{data=text?JSON.parse(text):{};}catch{}
  if(!res.ok)throw new Error(data?.msg||data?.message||data?.error_description||data?.error||`Request failed (${res.status})`);
  return data as T;
}
function loadTokens():Tokens|null{try{return JSON.parse(localStorage.getItem(STORAGE)||'null');}catch{return null;}}
function saveTokens(tokens:Tokens|null){if(tokens)localStorage.setItem(STORAGE,JSON.stringify(tokens));else localStorage.removeItem(STORAGE);}
async function refresh(tokens:Tokens):Promise<Tokens>{
  const next=await request<Tokens>('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:tokens.refresh_token})});
  saveTokens(next);return next;
}
async function withToken<T>(fn:(token:string)=>Promise<T>):Promise<T>{
  let session=loadTokens();if(!session)throw new Error('Sign in to continue.');
  try{return await fn(session.access_token);}catch(e){session=await refresh(session);return fn(session.access_token);}
}
async function rest<T>(path:string,token:string):Promise<T>{
  const res=await fetch(SUPABASE_URL+'/rest/v1/'+path,{headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${token}`}});
  const text=await res.text();let data:any=null;try{data=text?JSON.parse(text):null;}catch{}
  if(!res.ok)throw new Error(data?.message||`Account request failed (${res.status})`);return data as T;
}
async function ensureAccount(token:string){const res=await fetch(SUPABASE_URL+'/rest/v1/rpc/molt_ensure_account',{method:'POST',headers:headers(token),body:'{}'});if(!res.ok){const j=await res.json().catch(()=>({}));throw new Error(j.message||'Could not prepare your Molt workspace.');}}

export function AuthPage(){
  const[mode,setMode]=useState<'signin'|'signup'>('signin'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');setMessage('');try{
    if(mode==='signup'){
      const data=await request<any>('/auth/v1/signup',{method:'POST',body:JSON.stringify({email,password})});
      if(data.access_token){saveTokens(data);await ensureAccount(data.access_token);location.href='/account';}
      else setMessage('Check your email to confirm your account, then return here to sign in.');
    }else{
      const data=await request<Tokens>('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});
      saveTokens(data);await ensureAccount(data.access_token);location.href='/account';
    }
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <PublicFrame><main id="public-main" className="public-inner auth-page"><div className="public-kicker">YOUR MOLT ACCOUNT</div><div className="auth-grid"><section><h1>{mode==='signin'?'Welcome back.':'Create your workspace.'}</h1><p className="page-intro">{mode==='signin'?'Sign in to see your plan, credits, and future reconstructions.':'Create a Molt account now. Paid subscriptions are still disabled while reconstruction quality and production execution are being validated.'}</p><form onSubmit={submit} className="auth-card"><label>Email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" autoComplete={mode==='signin'?'current-password':'new-password'} minLength={8} required value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<div className="notice error">{error}</div>}{message&&<div className="notice neutral">{message}</div>}<button className="public-button primary" disabled={busy}>{busy?'Please wait…':mode==='signin'?'Sign in':'Create account'} <Icon name="arrow" size={16}/></button></form><button className="auth-switch" onClick={()=>{setMode(mode==='signin'?'signup':'signin');setError('');setMessage('');}}>{mode==='signin'?'New to Molt? Create an account':'Already have an account? Sign in'}</button></section><aside className="auth-aside"><div className="section-index">WHAT AN ACCOUNT UNLOCKS</div><h2>One place for your sites, credits, and migration history.</h2><ul><li>Workspace-based reconstruction history</li><li>Plan and credit balance visibility</li><li>Clear scope before a reconstruction starts</li><li>No GitHub or model API key required for future customer plans</li></ul><p>During private beta, paid plans remain unavailable and production customer reconstructions are not yet enabled.</p></aside></div></main></PublicFrame>;
}

export function AccountPage(){
  const[loading,setLoading]=useState(true),[error,setError]=useState(''),[email,setEmail]=useState(''),[workspace,setWorkspace]=useState<Workspace|null>(null),[subscription,setSubscription]=useState<Subscription|null>(null),[credits,setCredits]=useState<CreditAccount|null>(null);
  useEffect(()=>{let live=true;(async()=>{try{await withToken(async token=>{await ensureAccount(token);const user=await request<any>('/auth/v1/user',{headers:{authorization:`Bearer ${token}`}});const ws=(await rest<Workspace[]>('molt_workspaces?select=id,name,plan,status&limit=1',token))[0]||null;let sub:null|Subscription=null,acct:null|CreditAccount=null;if(ws){sub=(await rest<Subscription[]>(`molt_subscriptions?workspace_id=eq.${ws.id}&select=plan,status,current_period_end,cancel_at_period_end&limit=1`,token))[0]||null;acct=(await rest<CreditAccount[]>(`molt_credit_accounts?workspace_id=eq.${ws.id}&select=available,reserved,lifetime_granted,lifetime_spent&limit=1`,token))[0]||null;}if(live){setEmail(user.email||'');setWorkspace(ws);setSubscription(sub);setCredits(acct);}});}catch(e){if(live)setError((e as Error).message);}finally{if(live)setLoading(false);}})();return()=>{live=false};},[]);
  async function signOut(){const s=loadTokens();try{if(s)await request('/auth/v1/logout',{method:'POST',headers:{authorization:`Bearer ${s.access_token}`}});}catch{}saveTokens(null);location.href='/';}
  if(loading)return <PublicFrame><main id="public-main" className="public-inner"><p className="loading-state">Loading your Molt workspace…</p></main></PublicFrame>;
  if(error)return <PublicFrame><main id="public-main" className="public-inner auth-page"><div className="notice error">{error}</div><a className="public-button primary" href="/login">Sign in again</a></main></PublicFrame>;
  return <PublicFrame><main id="public-main" className="public-inner account-page"><div className="account-heading"><div><div className="public-kicker">YOUR WORKSPACE</div><h1>{workspace?.name||'My workspace'}</h1><p>{email}</p></div><button className="public-button outline" onClick={signOut}>Sign out</button></div><section className="account-metrics"><article><span>PLAN</span><strong>{subscription?.plan==='beta'?'Private beta':subscription?.plan||workspace?.plan||'Beta'}</strong><small>{subscription?.status==='active'?'Active subscription':'No paid subscription'}</small></article><article><span>AVAILABLE CREDITS</span><strong>{credits?.available??0}</strong><small>{credits?.reserved??0} reserved</small></article><article><span>LIFETIME USED</span><strong>{credits?.lifetime_spent??0}</strong><small>{credits?.lifetime_granted??0} total granted</small></article></section><section className="account-next"><div><div className="section-index">CURRENT BETA STATUS</div><h2>Your account layer is live. Paid reconstruction access is not.</h2><p>Customer identity, workspace membership, subscription state, and credit balances are now separated from the owner’s GitHub and model credentials. The next production gate is paid billing plus a commercial reconstruction runner.</p></div><a className="public-button primary" href="/how-it-works">Review the workflow <Icon name="arrow" size={16}/></a></section></main></PublicFrame>;
}
