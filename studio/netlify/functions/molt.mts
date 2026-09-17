import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { handle, type Store } from '../../server/app.ts';
declare const Netlify: { env: { get(name: string): string | undefined } };
export default async (req: Request, _context: Context) => {
  const context=Netlify.env.get('CONTEXT')??'production';
  const deploy=Netlify.env.get('DEPLOY_ID')??'local';
  const store=getStore({name:context==='production'?'molt-studio':`molt-studio-${deploy.slice(0,20)}`,consistency:'strong'});
  return handle(req,{store:store as unknown as Store,env:{secret:Netlify.env.get('MOLT_SESSION_SECRET')??'',origin:Netlify.env.get('MOLT_STUDIO_ORIGIN')??'https://moltick.netlify.app',context}});
};
export const config: Config = {path:'/api/molt/*'};
