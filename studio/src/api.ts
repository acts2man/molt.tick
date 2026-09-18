import { accessToken } from './auth';

async function call<T>(path:string,init:RequestInit,token:string|null):Promise<{response:Response;data:any}>{
  const response=await fetch(`/api/molt/${path}`,{credentials:'same-origin',...init,headers:{'content-type':'application/json','x-molt-request':'1',...(token?{authorization:`Bearer ${token}`}:{}),...init.headers}});
  const content=response.headers.get('content-type')??'';
  if(!content.includes('application/json'))throw new Error('The Molt API is unavailable on this deployment. The server function may not have deployed.');
  const data=await response.json();return{response,data};
}
export async function api<T=any>(path:string,init:RequestInit={}):Promise<T>{
  let token=await accessToken(false),result=await call<T>(path,init,token);
  if(result.response.status===401&&token){try{token=await accessToken(true);result=await call<T>(path,init,token);}catch{}}
  if(!result.response.ok)throw new Error(result.data.error??`Request failed (${result.response.status})`);return result.data as T;
}
export const post=(path:string,data:unknown={})=>api(path,{method:'POST',body:JSON.stringify(data)});
export const active=(status:string)=>['dispatching','queued','running','cancelling'].includes(status);
export const label=(status:string)=>({dispatching:'Submitting',queued:'Queued',running:'Reconstructing',cancelling:'Stopping',cancelled:'Cancelled',review:'Ready for review','needs-work':'Needs refinement',error:'Needs attention'}[status]??status);
export const date=(s:string)=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(s));
