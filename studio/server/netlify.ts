import { HttpError } from './contracts.ts';

export interface NetlifyConnectionCheck { teamSlug:string; teamName:string }

async function request(token:string,path:string,init:RequestInit={},fetcher:typeof fetch=fetch):Promise<any>{
  const response=await fetcher(`https://api.netlify.com${path}`,{
    ...init,redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...init.headers}
  });
  const text=await response.text();let data:any=null;try{data=text?JSON.parse(text):null;}catch{}
  if(!response.ok){
    const message=response.status===401?'Netlify rejected this token. Create a current personal access token and reconnect hosting.'
      :response.status===403?'Netlify denied this action. The token needs access to the team that will host reconstructed sites.'
      :`Netlify could not complete the request (HTTP ${response.status}).`;
    throw new HttpError(response.status===401||response.status===403?403:502,message);
  }
  return data;
}

export async function checkNetlify(token:string,requestedTeam='',fetcher:typeof fetch=fetch):Promise<NetlifyConnectionCheck>{
  if(token.length<20||token.length>512||/\s/.test(token))throw new HttpError(400,'Enter a valid Netlify personal access token.');
  const [user,accounts]=await Promise.all([
    request(token,'/api/v1/user',{},fetcher),
    request(token,'/api/v1/accounts',{},fetcher)
  ]);
  const rows=Array.isArray(accounts)?accounts.filter((a:any)=>typeof a?.slug==='string'&&a.slug):[];
  if(!rows.length)throw new HttpError(403,'This Netlify token does not expose a team Molt can deploy into.');
  let team=requestedTeam?rows.find((a:any)=>a.slug===requestedTeam):null;
  if(requestedTeam&&!team)throw new HttpError(400,'That Netlify team slug is not available to this token.');
  if(!team&&user?.preferred_account_id)team=rows.find((a:any)=>a.id===user.preferred_account_id);
  if(!team&&rows.length===1)team=rows[0];
  if(!team)throw new HttpError(400,'This Netlify account has more than one team. Enter the team slug Molt should use.');
  return {teamSlug:String(team.slug),teamName:String(team.name||team.slug)};
}
