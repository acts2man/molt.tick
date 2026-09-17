import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError, OWNER, REPOSITORY, WORKFLOW, BRANCH } from './contracts.ts';
export const COOKIE = '__Host-molt-session';
export interface Session { token: string; login: string; expires: number }
function key(secret: string): Buffer {
  if (secret.length < 40) throw new HttpError(503, 'Session encryption is not configured on this deployment.');
  return createHash('sha256').update(secret).digest();
}
export function seal(value: Session, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
}
export function unseal(value: string, secret: string): Session | null {
  try {
    if (value.length > 2048) return null;
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 30) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(secret), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    const result = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8')) as Session;
    if (typeof result.login !== 'string' || result.login.toLowerCase() !== OWNER || typeof result.token !== 'string' || !result.token || !Number.isFinite(result.expires) || result.expires <= Date.now()) return null;
    return result;
  } catch { return null; }
}
export function sessionFor(req: Request, secret: string): Session | null {
  const raw = req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return raw ? unseal(raw, secret) : null;
}
export function cookie(value: string, clear = false): string { return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 28800}`; }
export function assertMutation(req: Request): void {
  if (req.headers.get('origin') !== new URL(req.url).origin || req.headers.get('x-molt-request') !== '1') throw new HttpError(403, 'This action must originate from Molt Studio.');
}
export async function runnerIdentity(req: Request, audience: string): Promise<{ runId: number }> {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) throw new HttpError(401, 'A runner identity token is required.');
  try {
    const jwks = createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'));
    const { payload: p } = await jwtVerify(token, jwks, { issuer: 'https://token.actions.githubusercontent.com', audience, algorithms: ['RS256'] });
    if (p.repository !== REPOSITORY || p.ref !== `refs/heads/${BRANCH}` || p.workflow_ref !== `${REPOSITORY}/.github/workflows/${WORKFLOW}@refs/heads/${BRANCH}` || p.event_name !== 'workflow_dispatch' || typeof p.run_id !== 'string' || !/^\d+$/.test(p.run_id)) throw new Error('Wrong workflow');
    return { runId: Number(p.run_id) };
  } catch { throw new HttpError(403, 'Runner identity could not be verified.'); }
}
