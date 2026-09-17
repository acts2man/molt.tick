export async function api<T=any>(path:string, init:RequestInit={}):Promise<T>{
  const response=await fetch(`/api/molt/${path}`,{credentials:'same-origin',...init,headers:{'content-type':'application/json','x-molt-request':'1',...init.headers}});
  const content=response.headers.get('content-type')??'';
  if(!content.includes('application/json'))throw new Error('The Molt API is unavailable on this deployment. The server function may not have deployed.');
  const result=await response.json();if(!response.ok)throw new Error(result.error??`Request failed (${response.status})`);return result as T;
}
export const post=(path:string,data:unknown={})=>api(path,{method:'POST',body:JSON.stringify(data)});
export const active=(status:string)=>['dispatching','queued','running','cancelling'].includes(status);
export const label=(status:string)=>({dispatching:'Submitting',queued:'Queued',running:'Reconstructing',cancelling:'Stopping',cancelled:'Cancelled',review:'Ready for review','needs-work':'Needs refinement',error:'Needs attention'}[status]??status);
export const date=(s:string)=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(s));
