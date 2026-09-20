import { sealSecret, unsealSecret } from './security.ts';

export const MEDIA_COOKIE='__Host-molt-media';
const TTL_MS=30*60*1000;

export function createMediaSession(userId:string,secret:string):string{
  if(!/^[0-9a-f-]{36}$/i.test(userId))throw new Error('Invalid media-session account.');
  return sealSecret(JSON.stringify({userId,expires:Date.now()+TTL_MS}),secret);
}
export function readMediaSession(req:Request,secret:string):{userId:string}|null{
  try{
    const raw=req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(MEDIA_COOKIE+'='))?.slice(MEDIA_COOKIE.length+1);
    if(!raw)return null;
    const opened=unsealSecret(raw,secret);if(!opened)return null;
    const value=JSON.parse(opened) as {userId?:string;expires?:number};
    if(!value.userId||!/^[0-9a-f-]{36}$/i.test(value.userId)||!Number.isFinite(value.expires)||Number(value.expires)<=Date.now())return null;
    return {userId:value.userId};
  }catch{return null;}
}
export function mediaCookie(value:string,clear=false):string{
  return `${MEDIA_COOKIE}=${clear?'':value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${clear?0:1800}`;
}
