import sodium from 'libsodium-wrappers';
import { HttpError, REPOSITORY } from './contracts.ts';
export async function github(token: string, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<any> {
  const response = await fetcher(`https://api.github.com${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your GitHub connection expired. Reconnect with a valid token.' : response.status === 403 ? 'GitHub denied this action. Check the token permissions for this repository.' : response.status === 404 ? 'GitHub could not find this resource, or the token cannot access it.' : `GitHub could not complete the request (HTTP ${response.status}).`;
    throw new HttpError(response.status === 401 ? 401 : 502, message);
  }
  return response.status === 204 || response.headers.get('content-length') === '0' ? null : response.json();
}
export async function saveSecrets(token: string, values: Record<string, string>): Promise<void> {
  const publicKey = await github(token, `/repos/${REPOSITORY}/actions/secrets/public-key`);
  await sodium.ready;
  const key = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
  for (const [name, value] of Object.entries(values)) {
    const encrypted_value = sodium.to_base64(sodium.crypto_box_seal(value, key), sodium.base64_variants.ORIGINAL);
    await github(token, `/repos/${REPOSITORY}/actions/secrets/${name}`, { method: 'PUT', body: JSON.stringify({ encrypted_value, key_id: publicKey.key_id }) });
  }
}
export async function checkProvider(provider: 'openai' | 'anthropic', model: string, token: string): Promise<void> {
  const response = await fetch(`${provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1'}/models/${encodeURIComponent(model)}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: provider === 'openai' ? { Authorization: `Bearer ${token}` } : { 'x-api-key': token, 'anthropic-version': '2023-06-01' } });
  if (!response.ok) throw new HttpError(400, `The provider could not confirm access to that model (HTTP ${response.status}). Check the API key, model ID, and API account access. Nothing has been saved.`);
}
