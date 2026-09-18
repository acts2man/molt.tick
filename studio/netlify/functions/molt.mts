import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { handle, type Store } from '../../server/app.ts';
declare const Netlify: { env: { get(name: string): string | undefined } };
export default async (req: Request, context: Context) => {
  // Runtime secrets are supplied by Netlify environment configuration.
  const deployContext = context.deploy?.context ?? 'dev';
  const deployId = context.deploy?.id ?? 'local';
  const store = getStore({
    name: deployContext === 'production' ? 'molt-studio' : `molt-studio-${deployId.slice(0, 20)}`,
    consistency: 'strong',
  });
  return handle(req, {
    store: store as unknown as Store,
    env: {
      secret: Netlify.env.get('MOLT_SESSION_SECRET') ?? '',
      origin: Netlify.env.get('MOLT_STUDIO_ORIGIN') ?? 'https://moltick.netlify.app',
      context: deployContext,
      ownerUserId: Netlify.env.get('MOLT_OWNER_USER_ID') ?? undefined,
    },
  });
};
export const config: Config = { path: '/api/molt/*' };
