export const SUPABASE_URL='https://xdvnencecwzygfsojuty.supabase.co';
export const SUPABASE_KEY='sb_publishable_7aSCb10hgJLMVtnqKS44ew_ZD_1BWIF';
export const AUTH_STORAGE='molt-customer-session';

export type AuthTokens={access_token:string;refresh_token:string;expires_in:number;token_type:string;user?:{id:string;email?:string}};

export const supabaseHeaders=(token?:string)=>({'content-type':'application/json','apikey':SUPABASE_KEY,...(token?{'authorization':`Bearer ${token}`}:{})});

export async function supabaseRequest<T>(path:string,init:RequestInit={}):Promise<T>{
  const response=await fetch(SUPABASE_URL+path,{...init,headers:{...supabaseHeaders(),...init.headers}});
  const text=await response.text();let data:any={};try{data=text?JSON.parse(text):{};}catch{}
  if(!response.ok)throw new Error(data?.msg||data?.message||data?.error_description||data?.error||`Request failed (${response.status})`);
  return data as T;
}
export function loadAuthTokens():AuthTokens|null{try{return JSON.parse(localStorage.getItem(AUTH_STORAGE)||'null');}catch{return null;}}
export function saveAuthTokens(tokens:AuthTokens|null){if(tokens)localStorage.setItem(AUTH_STORAGE,JSON.stringify(tokens));else localStorage.removeItem(AUTH_STORAGE);}
export async function refreshAuthTokens(tokens?:AuthTokens|null):Promise<AuthTokens>{
  const current=tokens??loadAuthTokens();if(!current?.refresh_token)throw new Error('Sign in to continue.');
  const next=await supabaseRequest<AuthTokens>('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:current.refresh_token})});
  saveAuthTokens(next);return next;
}
export async function accessToken(refreshIfNeeded=false):Promise<string|null>{
  const session=loadAuthTokens();if(!session)return null;
  if(!refreshIfNeeded)return session.access_token;
  return (await refreshAuthTokens(session)).access_token;
}
export async function withAuthToken<T>(fn:(token:string)=>Promise<T>):Promise<T>{
  let session=loadAuthTokens();if(!session)throw new Error('Sign in to continue.');
  try{return await fn(session.access_token);}catch(e){session=await refreshAuthTokens(session);return fn(session.access_token);}
}
export async function ensureMoltAccount(token:string){
  const response=await fetch(SUPABASE_URL+'/rest/v1/rpc/molt_ensure_account',{method:'POST',headers:supabaseHeaders(token),body:'{}'});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.message||'Could not prepare your Molt workspace.');}
}
export async function signOutAccount(){
  const session=loadAuthTokens();try{if(session)await supabaseRequest('/auth/v1/logout',{method:'POST',headers:{authorization:`Bearer ${session.access_token}`}});}catch{}
  saveAuthTokens(null);
}
