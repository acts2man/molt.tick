import { randomUUID } from 'node:crypto';
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

async function saveSecretsToRepo(token:string,repository:string,values:Record<string,string>):Promise<void>{
  if(!/^acts2man\/[a-z0-9._-]+$/i.test(repository))throw new HttpError(400,'Invalid GitHub repository target.');
  const publicKey = await github(token, `/repos/${repository}/actions/secrets/public-key`);
  await sodium.ready;
  const key = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
  for (const [name, value] of Object.entries(values)) {
    const encrypted_value = sodium.to_base64(sodium.crypto_box_seal(value, key), sodium.base64_variants.ORIGINAL);
    await github(token, `/repos/${repository}/actions/secrets/${name}`, { method: 'PUT', body: JSON.stringify({ encrypted_value, key_id: publicKey.key_id }) });
  }
}

export async function saveSecrets(token: string, values: Record<string, string>): Promise<void> {
  await saveSecretsToRepo(token,REPOSITORY,values);
}

function deliveryError(stage:string,hint:string,error:unknown):HttpError{
  const detail=error instanceof Error?error.message:String(error);
  return new HttpError(409,`GitHub delivery verification failed at ${stage}. ${hint} (${detail})`);
}

export async function checkGithubDelivery(token:string):Promise<{verifiedAt:string}>{
  const name=`molt-delivery-check-${randomUUID().slice(0,8)}`,repository=`acts2man/${name}`;
  let created=false;
  try{
    try{
      await github(token,'/user/repos',{method:'POST',body:JSON.stringify({name,private:true,auto_init:true,description:'Temporary Molt delivery permission verification'})});
      created=true;
    }catch(error){
      throw deliveryError('repository creation','Set Resource owner to acts2man, Repository access to All repositories, and Administration to Read & write.',error);
    }
    try{
      await github(token,`/repos/${repository}`);
    }catch(error){
      throw deliveryError('new repository access','The token can create a repository but cannot access the repository it just created. Edit the fine-grained token and set Repository access to All repositories.',error);
    }
    try{
      await saveSecretsToRepo(token,repository,{MOLT_DELIVERY_CHECK:'verified'});
      await github(token,`/repos/${repository}/actions/secrets/MOLT_DELIVERY_CHECK`,{method:'DELETE'});
    }catch(error){
      throw deliveryError('Actions secret write','Set Secrets to Read & write on the fine-grained token.',error);
    }
    try{
      const probe=`name: Molt delivery permission check
on:
  workflow_dispatch:
jobs:
  permission-check:
    if: \${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: echo permission-check
`;
      const result=await github(token,`/repos/${repository}/contents/.github/workflows/molt-delivery-check.yml`,{method:'PUT',body:JSON.stringify({message:'Verify Molt workflow delivery permission',content:Buffer.from(probe,'utf8').toString('base64')})});
      const sha=String(result?.content?.sha??'');
      if(!sha)throw new Error('GitHub did not return the workflow file SHA.');
      await github(token,`/repos/${repository}/contents/.github/workflows/molt-delivery-check.yml`,{method:'DELETE',body:JSON.stringify({message:'Remove Molt workflow delivery permission check',sha})});
    }catch(error){
      throw deliveryError('workflow file write','Set Contents to Read & write and Workflows to Read & write on the fine-grained token.',error);
    }
    return {verifiedAt:new Date().toISOString()};
  }finally{
    if(created){
      try{await github(token,`/repos/${repository}`,{method:'DELETE'});}catch{}
    }
  }
}

export async function checkProvider(provider: 'openai' | 'anthropic', model: string, token: string): Promise<void> {
  const response = await fetch(`${provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1'}/models/${encodeURIComponent(model)}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: provider === 'openai' ? { Authorization: `Bearer ${token}` } : { 'x-api-key': token, 'anthropic-version': '2023-06-01' } });
  if (!response.ok) throw new HttpError(400, `The provider could not confirm access to that model (HTTP ${response.status}). Check the API key, model ID, and API account access. Nothing has been saved.`);
}
