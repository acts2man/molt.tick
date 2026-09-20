import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { Evaluation, Viewport } from './types.js';

export function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max || value?.trim() === '') throw new Error(`Expected integer ${min}..${max}, got ${value}`);
  return n;
}
export function routePath(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\?#\u0000-\u001f]/.test(value)) throw new Error(`Invalid route: ${value}`);
  const decoded = decodeURIComponent(value);
  if (/[\\?#\u0000-\u001f]/.test(decoded) || decoded.startsWith('//') || decoded.split('/').some(s => s === '.' || s === '..')) throw new Error('Unsafe route');
  return value.replace(/\/+$/, '') || '/';
}
export const routeFile = (route: string) => {
  const normalized = routePath(route);
  const name = normalized === '/' ? 'home' : decodeURIComponent(normalized).slice(1).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60) || 'page';
  return `src/pages/${name}-${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}.tsx`;
};
export function publicUrl(value: string): URL {
  const raw = value.trim();
  if (!raw) throw new Error('A source URL is required');
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) throw new Error('Use an http(s) URL');
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search) throw new Error('Use an http(s) URL without credentials or query parameters');
  u.hash = '';
  return u;
}
export function publicIP(ip: string): boolean {
  if (isIP(ip) === 6) return /^[23]/i.test(ip) && !/^(2001:(db8|0):|2001::|2002:)/i.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))
    || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}
/** Defense in depth; an egress firewall is still required against DNS rebinding. */
export async function assertPublicUrl(value: string): Promise<void> {
  const u = new URL(value), host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Unsupported network URL');
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) throw new Error('Local network URLs are not permitted');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw new Error('Private or reserved network destination');
}
export async function inside(root: string, name: string): Promise<string> {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.') || name.includes('\0')) throw new Error('Unsafe file path');
  const base = await realpath(root), file = await realpath(resolve(base, name));
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !(await stat(file)).isFile()) throw new Error('File escapes its bundle');
  return file;
}
export function validateViewports(views: Viewport[]): void {
  if (!views.length || views.length > 6 || new Set(views.map(v => v.name)).size !== views.length) throw new Error('Provide 1..6 unique viewports');
  for (const v of views) if (!/^[a-z][a-z0-9-]{0,20}$/.test(v.name) || !Number.isInteger(v.width) || v.width < 320 || v.width > 2000 || !Number.isInteger(v.height) || v.height < 320 || v.height > 1500) throw new Error('Invalid viewport');
}
const key = (v: Evaluation['views'][number]) => `${v.route}\0${v.viewport}`;
export function validEvaluation(e: Evaluation): boolean {
  return e.views.length > 0 && new Set(e.views.map(key)).size === e.views.length
    && e.views.every(v => [v.score, v.worstBand].every(n => n === null || Number.isFinite(n) && n >= 0 && n <= 100)
      && (!v.pass || v.score !== null && v.worstBand !== null && !v.issues.length))
    && e.pass === (e.issues.length === 0 && e.views.every(v => v.pass));
}
function interactionKey(v: Evaluation['views'][number], i: NonNullable<Evaluation['views'][number]['interactions']>[number]) {
  return `${key(v)}\0${i.id}`;
}
/** Keep already-correct views intact, while allowing a targeted repair to trade tiny
 * antialiasing/layout noise in one failing viewport for a material gain in the worst region.
 * Human-visible local fidelity matters more than preserving every failing score to 0.35 points. */
export function improves(best: Evaluation, next: Evaluation): boolean {
  if (!validEvaluation(next) || next.views.length !== best.views.length) return false;
  const before = new Map(best.views.map(v => [key(v), v]));
  if (before.size !== best.views.length || next.issues.some(i => !best.issues.includes(i))) return false;

  let passGain = 0, measurementGain = 0, issueGain = best.issues.length - next.issues.length;
  let beforeScore = 0, nextScore = 0, beforeWorst = 0, nextWorst = 0, count = 0;
  let beforeMinWorst = 101, nextMinWorst = 101;
  const addMeasured=(os:number,ns:number,ow:number,nw:number)=>{if(os<0||ns<0||ow<0||nw<0)return;beforeScore+=os;nextScore+=ns;beforeWorst+=ow;nextWorst+=nw;count++;beforeMinWorst=Math.min(beforeMinWorst,ow);nextMinWorst=Math.min(nextMinWorst,nw);};

  for (const v of next.views) {
    const old = before.get(key(v));
    if (!old) return false;
    if (old.pass && !v.pass) return false;

    if(old.score!==null&&v.score===null||old.worstBand!==null&&v.worstBand===null)return false;
    if(old.score===null&&v.score!==null||old.worstBand===null&&v.worstBand!==null)measurementGain++;
    const os=old.score ?? -1, ns=v.score ?? -1, ow=old.worstBand ?? -1, nw=v.worstBand ?? -1;
    // Failing views may move slightly as shared typography/geometry is repaired, but never accept
    // a material regression on an untouched viewport.
    if (ns < os - 1.5 || nw < ow - 1.5) return false;

    if (v.pass && !old.pass) passGain++;
    issueGain += old.issues.length - v.issues.length;
    addMeasured(os,ns,ow,nw);

    const oldInteractions = new Map((old.interactions??[]).map(i => [interactionKey(old,i), i]));
    const nextInteractions = new Map((v.interactions??[]).map(i => [interactionKey(v,i), i]));
    // A repair may not make previously measured interaction evidence disappear. Missing states can
    // otherwise hide a broken menu/carousel/accordion behind an improved page-level screenshot.
    if(oldInteractions.size!==nextInteractions.size)return false;
    for(const interaction of oldInteractions.keys())if(!nextInteractions.has(interaction))return false;
    for (const state of v.interactions??[]) {
      const prior = oldInteractions.get(interactionKey(v,state));
      if (!prior) return false;
      if (prior.pass && !state.pass) return false;
      if(prior.score!==null&&state.score===null||prior.worstBand!==null&&state.worstBand===null)return false;
      if(prior.score===null&&state.score!==null||prior.worstBand===null&&state.worstBand!==null)measurementGain++;
      const pis=prior.score ?? -1, sis=state.score ?? -1, piw=prior.worstBand ?? -1, siw=state.worstBand ?? -1;
      // Apply the same material-regression guard used for page views. Small rendering noise is
      // tolerated, but a page-wide gain may never conceal a substantially worse interaction state.
      if(sis<pis-1.5||siw<piw-1.5)return false;
      if (state.pass && !prior.pass) passGain++;
      issueGain += prior.issues.length - state.issues.length;
      addMeasured(pis,sis,piw,siw);
    }
  }

  if (!count) return passGain > 0 || measurementGain > 0 || issueGain > 0;
  const beforeComposite=(beforeScore/count)*0.35+(beforeWorst/count)*0.65;
  const nextComposite=(nextScore/count)*0.35+(nextWorst/count)*0.65;
  // New passes and resolved diagnostics are valuable, but they still cannot hide a meaningful
  // combined visual regression across the page and its interaction states.
  if (passGain > 0 && nextComposite >= beforeComposite - 0.5) return true;
  if ((measurementGain > 0 || issueGain > 0) && nextComposite >= beforeComposite - 0.15) return true;
  // Prefer improving the weakest visible band; otherwise require a meaningful weighted gain.
  if (nextMinWorst >= beforeMinWorst + 0.35 && nextComposite >= beforeComposite - 0.15) return true;
  return nextComposite >= beforeComposite + 0.25;
}
export function safeEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) if (process.env[name]) result[name] = process.env[name];
  result.CI = '1';
  return result;
}
