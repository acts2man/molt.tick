import { HttpError } from './contracts.ts';

const SUPABASE_URL='https://xdvnencecwzygfsojuty.supabase.co';
const SUPABASE_KEY='sb_publishable_7aSCb10hgJLMVtnqKS44ew_ZD_1BWIF';

export interface AccountUser { id:string; email?:string }

export async function authenticateAccount(req:Request,fetcher:typeof fetch=fetch):Promise<AccountUser|null>{
  const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'').trim();
  if(!token)return null;
  const response=await fetcher(SUPABASE_URL+'/auth/v1/user',{
    method:'GET',
    redirect:'error',
    signal:AbortSignal.timeout(15000),
    headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${token}`}
  });
  if(response.status===401||response.status===403)return null;
  if(!response.ok)throw new HttpError(502,'Molt could not verify your account session. Retry in a moment.');
  const data=await response.json() as {id?:string;email?:string};
  if(!data.id||!/^[0-9a-f-]{36}$/i.test(data.id))throw new HttpError(401,'Your Molt account session is invalid.');
  return {id:data.id,...(typeof data.email==='string'?{email:data.email}:{})};
}
