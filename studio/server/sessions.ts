import { createHash, randomBytes } from 'node:crypto';
import { COOKIE, sessionFor, type Session } from './security.ts';
import { OWNER } from './contracts.ts';

/** Private server-side sessions. Only an opaque identifier is held by the browser. */
export interface SessionStore {
  get(key: string, options: {type: 'json'}): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
const LIFETIME = 8 * 60 * 60 * 1000;
const validId = (value: string) => /^s_[A-Za-z0-9_-]{64}$/.test(value);
export function sessionStorageKey(identifier: string): string {
  if (!validId(identifier)) throw new Error('Invalid session identifier');
  return `private-sessions/${createHash('sha256').update(identifier).digest('hex')}`;
}
function identifierFor(req: Request): string | null {
  const value = req.headers.get('cookie')?.split(';').map(s => s.trim())
    .find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && validId(value) ? value : null;
}
export async function readSession(req: Request, store: SessionStore, legacySecret = ''): Promise<Session | null> {
  const identifier = identifierFor(req);
  if (!identifier) return legacySecret.length >= 40 ? sessionFor(req, legacySecret) : null;
  const key = sessionStorageKey(identifier);
  const record = await store.get(key, {type: 'json'}) as {version?: number; session?: Session} | null;
  const value = record?.session;
  if (!value) return null;
  if (record?.version !== 1 || value.login !== OWNER || typeof value.token !== 'string'
    || value.token.length < 20 || value.token.length > 255 || !Number.isFinite(value.expires)
    || value.expires <= Date.now() || value.expires > Date.now() + LIFETIME + 60_000) {
    await store.delete(key);
    return null;
  }
  return value;
}
export async function createSession(store: SessionStore, token: string, login: string): Promise<string> {
  if (login.toLowerCase() !== OWNER || token.length < 20 || token.length > 255 || /\s/.test(token)) {
    throw new Error('Invalid owner session');
  }
  const identifier = 's_' + randomBytes(48).toString('base64url');
  const session: Session = {token, login: OWNER, expires: Date.now() + LIFETIME};
  // Every session has a unique key: concurrent logins never overwrite each other.
  await store.setJSON(sessionStorageKey(identifier), {version: 1, session});
  return identifier;
}
export async function revokeSession(req: Request, store: SessionStore): Promise<void> {
  const identifier = identifierFor(req);
  if (identifier) await store.delete(sessionStorageKey(identifier));
}
