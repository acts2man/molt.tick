export const REPOSITORY = 'acts2man/molt.tick';
export const OWNER = 'acts2man';
export const WORKFLOW = 'reconstruct-site.yml';
export const PREFLIGHT_WORKFLOW = 'preflight-site.yml';
export const BRANCH = 'main';
export const ACTIVE = new Set(['dispatching', 'queued', 'running', 'cancelling']);
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function uuid(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new HttpError(400, 'Invalid request identifier.');
  return value;
}
export function safePath(value: string): string {
  if (typeof value !== 'string' || value.length > 200 || !value || value.startsWith('/') || /[\\\u0000-\u001f?#]/.test(value) || value.split('/').some(s => !s || s.startsWith('.'))) throw new HttpError(400, 'Unsafe bundle file path.');
  if (!/\.(html?|css|js|json|png|jpe?g|svg|webp|gif|avif|ico|woff2?|ttf|otf)$/i.test(value)) throw new HttpError(400, 'Unsupported file type in page bundle.');
  if (/^(?:package(?:-lock)?\.json|netlify\.toml)$/i.test(value)) throw new HttpError(400, 'Upload saved website pages, not an executable project.');
  return value;
}
export function sourceUrl(value: string): string {
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); } catch { throw new HttpError(400, 'Enter a valid website address.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !host.includes('.') || url.search || host === 'localhost' || /\.(local|internal|localhost)$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) throw new HttpError(400, 'Use a public website domain, without credentials or query parameters.');
  url.hash = '';
  return url.href;
}
export function sourcePages(source: string, text: string): string[] {
  const result: string[] = [], base = new URL(source);
  for (const value of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const u = new URL(value, base);
    if (u.origin !== base.origin || u.search || u.username || u.password) throw new HttpError(400, 'Every page must belong to the same website and have no query parameters.');
    u.hash = '';
    if (!result.includes(u.href)) result.push(u.href);
  }
  if (result.length > 12) throw new HttpError(400, 'Choose up to 12 pages per reconstruction.');
  return result;
}
export interface Settings { provider: 'openai' | 'anthropic'; model: string; configuredAt: string; accessChecked: boolean }
export interface Job {
  id: string; owner: string; kind: 'preflight' | 'reconstruction'; name: string; sourceUrl: string; pages: string[]; bundleId?: string;
  maxPages: number; maxRepairs: number; status: string; message: string; createdAt: string; updatedAt: string;
  runId?: number; runUrl?: string; events: Array<{ at: string; message: string }>;
  report?: any; preflight?: any; usage?: any; error?: string; sourcePreflightId?: string; reconstructionId?: string;
}
export function newJob(input: any, owner: string, kind:'preflight'|'reconstruction'='reconstruction'): Job {
  const id = uuid(input.id), source = sourceUrl(String(input.url || ''));
  const pages = sourcePages(source, String(input.pages || ''));
  const maxPages = Number(input.maxPages ?? 5), maxRepairs = Number(input.maxRepairs ?? 3);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 12 || !Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 6) throw new HttpError(400, 'Invalid reconstruction limits.');
  if (pages.length > maxPages) throw new HttpError(400, 'Your explicit page list exceeds the page limit.');
  const now = new Date().toISOString();
  return { id, owner, kind, sourceUrl: source, name: new URL(source).hostname.replace(/^www\./, ''), pages, ...(input.bundleId ? {bundleId: uuid(input.bundleId)} : {}), maxPages, maxRepairs, status: 'dispatching', message: kind==='preflight'?'Submitting to the scope scanner':'Submitting to the reconstruction runner', createdAt: now, updatedAt: now, events: [] };
}
