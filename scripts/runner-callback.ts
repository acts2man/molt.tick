export interface RunnerFetchOptions{
  origin:string;id:string;path:string;init?:RequestInit;
  getToken:(force:boolean)=>Promise<string>;
  fetcher?:typeof fetch;attempts?:number;
  wait?:(ms:number)=>Promise<void>;
}
export async function runnerFetch(options:RunnerFetchOptions):Promise<Response>{
  const fetcher=options.fetcher??fetch,attempts=options.attempts??3,wait=options.wait??(ms=>new Promise(r=>setTimeout(r,ms)));
  let last='';
  for(let attempt=0;attempt<attempts;attempt++){
    const token=await options.getToken(attempt>0);
    const response=await fetcher(`${options.origin}/api/molt/runner/${options.id}${options.path}`,{
      ...(options.init??{}),redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{Authorization:`Bearer ${token}`,...(options.init?.headers??{})}
    });
    if(response.ok)return response;
    last=`Studio callback failed (HTTP ${response.status}): ${(await response.text()).slice(0,400)}`;
    if(![401,403,429,500,502,503,504].includes(response.status)||attempt===attempts-1)break;
    await wait(350*(attempt+1));
  }
  throw new Error(last||'Studio callback failed.');
}
