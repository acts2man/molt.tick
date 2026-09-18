import { randomUUID, createHash } from 'node:crypto';
import { ACTIVE, BRANCH, HttpError, Job, OWNER, OPENAI_JOB_MODELS, REPOSITORY, Settings, WORKFLOW, newJob, safePath, uuid } from './contracts.ts';
import { assertMutation, runnerIdentity, sealSecret, unsealSecret } from './security.ts';
import { authenticateAccount, type AccountUser } from './account-auth.ts';
import { checkProvider, github, saveSecrets } from './github.ts';
import { readSession } from './sessions.ts';
import { checkNetlify } from './netlify.ts';

export interface Store {
  get(key: string, options?: {type: 'json' | 'arrayBuffer'}): Promise<any>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  set(key: string, value: ArrayBuffer): Promise<unknown>;
  list(options: {prefix: string}): Promise<{blobs: {key: string}[]}>;
  delete(key: string): Promise<unknown>;
}
export interface Environment { secret: string; origin: string; context: string; ownerUserId?: string }
export interface Services {
  store: Store; env: Environment; github?: typeof github;
  identifyRunner?: typeof runnerIdentity; saveSecrets?: typeof saveSecrets; checkProvider?: typeof checkProvider; checkNetlify?: typeof checkNetlify; authenticate?: typeof authenticateAccount;
}
const json = (value: unknown, status = 200, extra: Record<string,string> = {}) => new Response(JSON.stringify(value), { status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra} });
async function bytes(req: Request, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length')) > limit) throw new HttpError(413, 'Upload exceeds the size limit.');
  const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw new HttpError(413, 'Upload exceeds the size limit.'); } chunks.push(value); }
  const out = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}
async function body(req: Request, limit = 65536): Promise<any> {
  if (!req.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, 'Send a JSON request.');
  try { return JSON.parse(new TextDecoder().decode(await bytes(req, limit))); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'The request contains invalid JSON.'); }
}
const dataKey = (owner: string, id: string) => `jobs/${owner}/${uuid(id)}`;
const bundleKey = (owner: string, id: string) => `bundles/${owner}/${uuid(id)}`;
const previewKey = (owner:string,id:string,path:string) => `previews/${owner}/${uuid(id)}/${safePath(path)}`;
const previewType=(path:string)=>({html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml',avif:'image/avif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'}[path.split('.').pop()?.toLowerCase()??'']??'application/octet-stream');
const fileKey = (base: string, path: string) => `${base}/files/${createHash('sha256').update(safePath(path)).digest('hex')}`;
const OWNER_BINDING_KEY='auth/owner-binding-v1';
const OWNER_ACCOUNT_HASH='abc25c3918e8fbd2c645255d22971d80d137aac320029169dcf8b6cb4982026a';
const isConfiguredOwner=(account:AccountUser,env:Environment)=>env.ownerUserId===account.id||createHash('sha256').update(account.id).digest('hex')===OWNER_ACCOUNT_HASH;
const GITHUB_INTEGRATION_KEY='integrations/owner/github-v1';
const NETLIFY_INTEGRATION_KEY='integrations/owner/netlify-v1';
type OwnerBinding={userId:string;email?:string;createdAt:string};
type GithubIntegration={ciphertext:string;login:string;connectedAt:string};
type NetlifyIntegration={ciphertext:string;teamSlug:string;teamName:string;connectedAt:string};
async function ownerBinding(store:Store):Promise<OwnerBinding|null>{return await store.get(OWNER_BINDING_KEY,{type:'json'}) as OwnerBinding|null;}
async function githubIntegration(store:Store,env:Environment):Promise<{token:string;record:GithubIntegration}|null>{
  const record=await store.get(GITHUB_INTEGRATION_KEY,{type:'json'}) as GithubIntegration|null;if(!record)return null;
  const token=unsealSecret(record.ciphertext,env.secret);if(!token)return null;return {token,record};
}
async function netlifyIntegration(store:Store,env:Environment):Promise<{token:string;record:NetlifyIntegration}|null>{
  const record=await store.get(NETLIFY_INTEGRATION_KEY,{type:'json'}) as NetlifyIntegration|null;if(!record)return null;
  const token=unsealSecret(record.ciphertext,env.secret);if(!token)return null;return {token,record};
}
async function requireOwner(store:Store,user:AccountUser):Promise<OwnerBinding>{
  const binding=await ownerBinding(store);if(!binding)throw new HttpError(403,'This Molt account has not been linked to the owner workspace yet. Connect the GitHub owner integration once to claim it.');
  if(binding.userId!==user.id)throw new HttpError(403,'This Molt account is not authorized for the owner workspace.');return binding;
}
async function deletePrefix(store:Store,prefix:string):Promise<void>{
  const {blobs}=await store.list({prefix});for(const blob of blobs)await store.delete(blob.key);
}
async function jobs(store: Store, owner: string): Promise<Job[]> {
  const {blobs} = await store.list({prefix: `jobs/${owner}/`});
  const rows = await Promise.all(blobs.filter(b => b.key.split('/').length === 3).slice(-100).map(b => store.get(b.key, {type: 'json'})));
  return rows.filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
function safeUsage(value:any):any {const clip=(v:unknown,n=2000)=>String(v??'').slice(0,n);return { calls:Number(value?.calls)||0,inputTokens:Number(value?.inputTokens)||0,outputTokens:Number(value?.outputTokens)||0,
      records:Array.isArray(value?.records)?value.records.slice(0,200).map((r:any)=>({call:Number(r.call)||0,provider:clip(r.provider,30),model:clip(r.model,100),inputTokens:typeof r.inputTokens==='number'&&Number.isSafeInteger(r.inputTokens)&&r.inputTokens>=0?r.inputTokens:null,cachedInputTokens:typeof r.cachedInputTokens==='number'&&Number.isSafeInteger(r.cachedInputTokens)&&r.cachedInputTokens>=0?r.cachedInputTokens:null,cacheWriteTokens:typeof r.cacheWriteTokens==='number'&&Number.isSafeInteger(r.cacheWriteTokens)&&r.cacheWriteTokens>=0?r.cacheWriteTokens:null,outputTokens:typeof r.outputTokens==='number'&&Number.isSafeInteger(r.outputTokens)&&r.outputTokens>=0?r.outputTokens:null,estimatedUsd:typeof r.estimatedUsd==='number'&&Number.isFinite(r.estimatedUsd)&&r.estimatedUsd>=0?r.estimatedUsd:null,reported:r.reported===true,outcome:clip(r.outcome,60),pricingReviewed:clip(r.pricingReviewed,30)})):[],
      costEstimate:value?.costEstimate?{estimatedUsd:typeof value.costEstimate.estimatedUsd==='number'&&Number.isFinite(value.costEstimate.estimatedUsd)?value.costEstimate.estimatedUsd:null,complete:value.costEstimate.complete===true,unpricedCalls:Number(value.costEstimate.unpricedCalls)||0,excludes:clip(value.costEstimate.excludes)}:null };}
function safeReport(input: any): any {
  if (!input || !['review','needs-work'].includes(input.status) || !Array.isArray(input.evaluation?.views)) throw new HttpError(400, 'Invalid reconstruction report.');
  const clip = (value: unknown, n = 2000) => String(value ?? '').slice(0,n);
  const list = (value: unknown) => Array.isArray(value) ? value.slice(0,100).map(v => clip(v)) : [];
  return {status:input.status, reason:clip(input.reason), warnings:list(input.warnings), blockers:list(input.blockers),
    usage: safeUsage(input.usage),
    complexity:input.complexity?{version:clip(input.complexity.version,60),binding:false,firstPassCredits:Number(input.complexity.firstPassCredits)||0,pages:Array.isArray(input.complexity.pages)?input.complexity.pages.slice(0,12).map((p:any)=>({route:clip(p.route,200),complexity:clip(p.complexity,20),credits:Number(p.credits)||0,reasons:list(p.reasons)})):[]}:null,
    evaluation:{pass:input.evaluation.pass === true,issues:list(input.evaluation.issues),views:input.evaluation.views.slice(0,72).map((v:any)=>({
      route:clip(v.route,200),viewport:clip(v.viewport,30),pass:v.pass === true,
      score:typeof v.score === 'number' && Number.isFinite(v.score) && v.score>=0 && v.score<=100?v.score:null,
      worstBand:typeof v.worstBand === 'number' && Number.isFinite(v.worstBand)?v.worstBand:null,
      issues:list(v.issues), sourceImage:/^[a-z0-9-]+\.png$/.test(v.sourceImage??'')?v.sourceImage:null,
      candidateImage:/^[a-z0-9-]+\.png$/.test(v.candidateImage??'')?v.candidateImage:null,
      diffImage:/^[a-z0-9-]+\.png$/.test(v.diffImage??'')?v.diffImage:null,
    }))}, attempts:Array.isArray(input.attempts)?input.attempts.slice(0,20).map((a:any)=>({round:a.round,accepted:a.accepted===true,summary:clip(a.summary)})):[]};
}
export async function handle(req: Request, services: Services): Promise<Response> {
  const {store,env}=services, gh=services.github??github;
  const url=new URL(req.url), path=url.pathname.replace(/^\/api\/molt\/?/,'').split('/').filter(Boolean), method=req.method;
  try {
    if (path[0]==='runner') {
      const identity=await (services.identifyRunner??runnerIdentity)(req,env.origin);
      const id=uuid(path[1]??''), key=dataKey(OWNER,id); const job=await store.get(key,{type:'json'}) as Job|null;
      if(!job)throw new HttpError(404,'Job not found.');
      if(job.runId && job.runId!==identity.runId)throw new HttpError(409,'This job belongs to a different workflow run.');
      if (method==='GET' && path.length===2) {
        if(!ACTIVE.has(job.status))throw new HttpError(409,'This job is no longer queued.');
        job.runId=identity.runId;job.runUrl=`https://github.com/${REPOSITORY}/actions/runs/${identity.runId}`;job.status='running';job.updatedAt=new Date().toISOString();await store.setJSON(key,job);return json(job);
      }
      if(method==='GET' && path[2]==='bundle') {
        if(!job.bundleId)throw new HttpError(404,'No page bundle belongs to this job.');
        const base=bundleKey(OWNER,job.bundleId), manifest=await store.get(`${base}/manifest`,{type:'json'});
        if(!manifest?.ready)throw new HttpError(409,'Bundle upload is incomplete.');
        const name=url.searchParams.get('file'); if(!name)return json(manifest);
        safePath(name);if(!manifest.files.some((f:any)=>f.path===name))throw new HttpError(404,'Bundle file not found.');
        const buffer=await store.get(fileKey(base,name),{type:'arrayBuffer'});if(!buffer)throw new HttpError(404,'Bundle file not found.');
        return new Response(buffer,{headers:{'content-type':'application/octet-stream','cache-control':'no-store'}});
      }
      if(method==='PUT' && path[2]==='preview') {
        const name=url.searchParams.get('file')??'';safePath(name);
        const file=await bytes(req,8_000_000);
        await store.set(previewKey(OWNER,id,name),file.buffer as ArrayBuffer);
        return json({saved:true,path:name});
      }
      if(method==='PUT' && path[2]==='images') {
        const name=path[3]??'';if(!/^[a-z0-9-]{1,80}\.png$/.test(name))throw new HttpError(400,'Invalid image identifier.');
        const image=await bytes(req,4_000_000);if(Buffer.from(image.subarray(0,8)).toString('hex')!=='89504e470d0a1a0a')throw new HttpError(415,'Only PNG screenshots are accepted.');
        await store.set(`images/${OWNER}/${id}/${name}`,image.buffer as ArrayBuffer);return json({saved:true});
      }
      if(method==='POST' && path[2]==='events') {
        const event=await body(req,1_000_000);
        if(!ACTIVE.has(job.status))return json({ignored:true});
        const now=new Date().toISOString();job.updatedAt=now;job.runId=identity.runId;job.runUrl=`https://github.com/${REPOSITORY}/actions/runs/${identity.runId}`;
        job.message=String(event.message??'Processing').slice(0,4000);
        if(event.usage)job.usage=safeUsage(event.usage);
        if(typeof event.outputRepoUrl==='string'&&/^https:\/\/github\.com\/acts2man\/[a-z0-9._-]+$/i.test(event.outputRepoUrl))job.outputRepoUrl=event.outputRepoUrl;
        if(typeof event.outputRepoError==='string')job.outputRepoError=String(event.outputRepoError).slice(0,1000);
        if(typeof event.liveSiteUrl==='string'&&/^https:\/\/[a-z0-9.-]+\.netlify\.app\/?$/i.test(event.liveSiteUrl))job.liveSiteUrl=event.liveSiteUrl;
        if(typeof event.liveSiteAdminUrl==='string'&&/^https:\/\/app\.netlify\.com\/(?:sites|projects)\/[a-z0-9-]+\/?$/i.test(event.liveSiteAdminUrl))job.liveSiteAdminUrl=event.liveSiteAdminUrl;
        if(typeof event.deploymentError==='string')job.deploymentError=String(event.deploymentError).slice(0,1000);
        if(event.previewReady===true)job.previewReady=true;
        job.events=[...job.events,{at:now,message:job.message}].slice(-80);
        if(event.report){job.report=safeReport(event.report);job.status=job.report.status;}else if(event.error){job.status='error';job.error=String(event.error).slice(0,4000);}else if(job.status!=='cancelling')job.status='running';
        await store.setJSON(key,job);return json({saved:true});
      }
      throw new HttpError(404,'Runner route not found.');
    }
    const account=await (services.authenticate??authenticateAccount)(req);
    let binding=await ownerBinding(store);
    if(account&&isConfiguredOwner(account,env)&&binding?.userId!==account.id){
      binding={userId:account.id,...(account.email?{email:account.email}:{}),createdAt:binding?.createdAt??new Date().toISOString()};
      await store.setJSON(OWNER_BINDING_KEY,binding);
    }
    let integration=env.secret.length>=40?await githubIntegration(store,env):null;
    let hostingIntegration=env.secret.length>=40?await netlifyIntegration(store,env):null;
    if(account&&binding?.userId===account.id&&!integration&&env.secret.length>=40){
      const legacy=await readSession(req,store,env.secret);
      if(legacy){
        try{
          const user=await gh(legacy.token,'/user');
          if(String(user.login).toLowerCase()===OWNER){
            const record:GithubIntegration={ciphertext:sealSecret(legacy.token,env.secret),login:OWNER,connectedAt:new Date().toISOString()};
            await store.setJSON(GITHUB_INTEGRATION_KEY,record);
            integration={token:legacy.token,record};
          }
        }catch{}
      }
    }
    if(method==='GET' && path[0]==='session'){
      await store.get('system/studio-health',{type:'json'});
      const authorized=!!account&&!!binding&&binding.userId===account.id,claimable=!!account&&!binding;
      return json({authenticated:!!account,authorized,claimable,connected:authorized&&!!integration,hostingConnected:authorized&&!!hostingIntegration,hostingTeam:authorized&&hostingIntegration?hostingIntegration.record.teamSlug:null,login:authorized&&integration?integration.record.login:null,email:account?.email??null,serverReady:true,repository:REPOSITORY,branch:BRANCH,hosting:'Netlify',runner:'GitHub Actions'});
    }
    if(!['GET','HEAD'].includes(method))assertMutation(req);
    if(!account)throw new HttpError(401,'Sign in to your Molt account to continue.');
    if(method==='POST' && path[0]==='connect') {
      if(binding&&binding.userId!==account.id)throw new HttpError(403,'This Molt account is not authorized for the owner workspace.');
      if(env.secret.length<40)throw new HttpError(503,'Secure workspace credential storage is not configured on this deployment.');
      const input=await body(req),token=String(input.token??'').trim();
      if(token.length<20||token.length>255||/\s/.test(token))throw new HttpError(400,'Enter a valid GitHub fine-grained access token.');
      const user=await gh(token,'/user');if(String(user.login).toLowerCase()!==OWNER)throw new HttpError(403,`This workspace belongs to ${OWNER}. Use that GitHub account.`);
      const repo=await gh(token,`/repos/${REPOSITORY}`);if(!repo.permissions?.push)throw new HttpError(403,'This token must have write access to the Molt repository.');
      await gh(token,`/repos/${REPOSITORY}/actions/workflows?per_page=1`);
      await (services.saveSecrets??saveSecrets)(token,{MOLT_GITHUB_EXPORT_TOKEN:token});
      if(!binding)await store.setJSON(OWNER_BINDING_KEY,{userId:account.id,...(account.email?{email:account.email}:{}),createdAt:new Date().toISOString()} satisfies OwnerBinding);
      await store.setJSON(GITHUB_INTEGRATION_KEY,{ciphertext:sealSecret(token,env.secret),login:OWNER,connectedAt:new Date().toISOString()} satisfies GithubIntegration);
      return json({connected:true,login:user.login,accountBound:true});
    }
    await requireOwner(store,account);
    const owner=OWNER,token=integration?.token??null;
    const requiredGithub=()=>{if(!token)throw new HttpError(409,'Connect the GitHub workspace integration once. After that it is available on every device you sign into.');return token;};
    if(method==='POST' && path[0]==='disconnect'){await store.delete(GITHUB_INTEGRATION_KEY);return json({connected:false});}
    if(method==='POST' && path[0]==='netlify-connect'){
      if(env.secret.length<40)throw new HttpError(503,'Secure workspace credential storage is not configured on this deployment.');
      const input=await body(req),hostingToken=String(input.token??'').trim(),teamSlug=String(input.teamSlug??'').trim();
      const checked=await (services.checkNetlify??checkNetlify)(hostingToken,teamSlug);
      await (services.saveSecrets??saveSecrets)(requiredGithub(),{MOLT_NETLIFY_AUTH_TOKEN:hostingToken,MOLT_NETLIFY_TEAM_SLUG:checked.teamSlug});
      const record:NetlifyIntegration={ciphertext:sealSecret(hostingToken,env.secret),teamSlug:checked.teamSlug,teamName:checked.teamName,connectedAt:new Date().toISOString()};
      await store.setJSON(NETLIFY_INTEGRATION_KEY,record);hostingIntegration={token:hostingToken,record};
      return json({connected:true,teamSlug:checked.teamSlug,teamName:checked.teamName});
    }
    if(method==='POST' && path[0]==='netlify-disconnect'){await store.delete(NETLIFY_INTEGRATION_KEY);return json({connected:false});}
    if(method==='GET' && path[0]==='preview'){
      const id=uuid(path[1]??''),job=await store.get(dataKey(owner,id),{type:'json'}) as Job|null;
      if(!job||!job.previewReady)throw new HttpError(404,'Interactive preview is not available for this reconstruction.');
      const name=path.slice(2).join('/')||'index.html';safePath(name);
      const file=await store.get(previewKey(owner,id,name),{type:'arrayBuffer'});
      if(!file)throw new HttpError(404,'Preview file not found.');
      return new Response(file,{headers:{
        'content-type':previewType(name),'cache-control':'private, max-age=300','x-content-type-options':'nosniff','x-frame-options':'SAMEORIGIN',
        'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'"
      }});
    }
    if(path[0]==='settings') {
      if(method==='GET') {
        const settings=await store.get(`settings/${owner}`,{type:'json'}) as Settings|null;
        let permissionsError='',names:string[]=[],workflow=false;
        if(token){try{const secrets=await gh(token,`/repos/${REPOSITORY}/actions/secrets?per_page=100`);names=secrets.secrets.map((s:any)=>s.name);}catch(e){permissionsError=(e as Error).message;}try{const w=await gh(token,`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`);workflow=w.state==='active';}catch{}}else permissionsError='GitHub workspace integration is not connected.'
        const provider=settings?.provider??(names.includes('OPENAI_API_KEY')?'openai':names.includes('ANTHROPIC_API_KEY')?'anthropic':'openai');
        const keyPresent=names.includes(provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY');
        const exportReady=names.includes('MOLT_GITHUB_EXPORT_TOKEN'),hostingReady=names.includes('MOLT_NETLIFY_AUTH_TOKEN')&&names.includes('MOLT_NETLIFY_TEAM_SLUG')&&!!hostingIntegration;
        return json({provider,model:settings?.model??(provider==='openai'?'gpt-5.6-sol':''),keyPresent,modelConfigured:names.includes('MOLT_AI_MODEL'),workflow,exportReady,hostingReady,hostingTeam:hostingIntegration?.record.teamSlug??null,permissionsError,ready:keyPresent&&names.includes('MOLT_AI_MODEL')&&workflow&&exportReady&&hostingReady,configuredAt:settings?.configuredAt??null,accessChecked:settings?.accessChecked??false});
      }
      if(method==='POST') {
        const input=await body(req),provider=input.provider,model=String(input.model??'').trim(),apiKey=String(input.apiKey??'').trim();
        if(!['openai','anthropic'].includes(provider)||!model||model.length>100||!/^[\w.:-]+$/.test(model))throw new HttpError(400,'Choose a provider and enter its exact API model ID.');
        const values:Record<string,string>={MOLT_MODEL_PROVIDER:provider,MOLT_AI_MODEL:model};
        if(apiKey){if(apiKey.length<20||apiKey.length>512||/\s/.test(apiKey))throw new HttpError(400,'The API key format is invalid.');await (services.checkProvider??checkProvider)(provider,model,apiKey);values[provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY']=apiKey;}
        else{const secrets=await gh(requiredGithub(),`/repos/${REPOSITORY}/actions/secrets?per_page=100`);if(!secrets.secrets.some((s:any)=>s.name===(provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY')))throw new HttpError(400,'Enter an API key for the selected provider.');}
        await (services.saveSecrets??saveSecrets)(requiredGithub(),values);
        const settings:Settings={provider,model,configuredAt:new Date().toISOString(),accessChecked:!!apiKey};await store.setJSON(`settings/${owner}`,settings);return json({saved:true,...settings});
      }
    }
    if(path[0]==='jobs') {
      if(method==='GET' && path.length===1){const includeArchived=url.searchParams.get('includeArchived')==='1';const rows=await jobs(store,owner);return json({jobs:includeArchived?rows:rows.filter(j=>!j.archivedAt)});}
      if(method==='POST' && path.length===1) {
        const input=await body(req);if(input.developmentTest!==true)throw new HttpError(400,'This runner is for owner development tests, not customer production jobs. Confirm the test scope in Studio.');
        const configured=await store.get(`settings/${owner}`,{type:'json'}) as Settings|null;
        const job=newJob(input,owner);
        if(configured?.provider==='openai'&&!OPENAI_JOB_MODELS.has(job.model))throw new HttpError(400,'Choose one of the supported OpenAI reconstruction models.');
        if(configured?.provider==='anthropic'&&job.model!==configured.model)throw new HttpError(400,'Anthropic jobs must use the model configured in Owner setup.');
        const key=dataKey(owner,job.id),existing=await store.get(key,{type:'json'});
        if(existing){if(existing.sourceUrl!==job.sourceUrl||JSON.stringify(existing.pages)!==JSON.stringify(job.pages)||existing.bundleId!==job.bundleId||existing.model!==job.model||existing.reasoningEffort!==job.reasoningEffort||existing.outputRepo!==job.outputRepo||existing.maxPages!==job.maxPages||existing.maxRepairs!==job.maxRepairs)throw new HttpError(409,'This request ID was already used for another website.');return json(existing);}
        const recent=await jobs(store,owner);if(recent.some(j=>ACTIVE.has(j.status)))throw new HttpError(409,'A reconstruction is already active. Finish or cancel it before starting another.');
        if(recent.filter(j=>Date.now()-Date.parse(j.createdAt)<3600000).length>=5)throw new HttpError(429,'This workspace allows five new jobs per hour to limit accidental usage.');
        const secrets=await gh(requiredGithub(),`/repos/${REPOSITORY}/actions/secrets?per_page=100`),names=secrets.secrets.map((s:any)=>s.name);
        if(!names.includes('MOLT_AI_MODEL')||(!names.includes('OPENAI_API_KEY')&&!names.includes('ANTHROPIC_API_KEY')))throw new HttpError(409,'Finish the model connection before starting a reconstruction.');
        if(!names.includes('MOLT_GITHUB_EXPORT_TOKEN'))throw new HttpError(409,'Reconnect the GitHub owner workspace once so Molt can create the output React repository.');
        if(!hostingIntegration||!names.includes('MOLT_NETLIFY_AUTH_TOKEN')||!names.includes('MOLT_NETLIFY_TEAM_SLUG'))throw new HttpError(409,'Connect Netlify hosting before starting a paid reconstruction. Molt will not spend model usage without a verified deployment destination.');
        if(job.bundleId){const m=await store.get(`${bundleKey(owner,job.bundleId)}/manifest`,{type:'json'});if(!m?.ready)throw new HttpError(409,'Your page bundle has not finished uploading.');}
        await store.setJSON(key,job);
        try {
          const dispatch=await gh(requiredGithub(),`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,{method:'POST',body:JSON.stringify({ref:BRANCH,inputs:{job_id:job.id}})});
          const latest=await store.get(key,{type:'json'}) as Job;
          if(latest.status==='dispatching'){latest.status='queued';latest.message='Waiting for a GitHub Actions runner';if(dispatch?.workflow_run_id){latest.runId=dispatch.workflow_run_id;latest.runUrl=dispatch.html_url;}await store.setJSON(key,latest);}return json(latest,202);
        }catch(e){job.status='error';job.error=(e as Error).message;job.message='The runner could not be started';await store.setJSON(key,job);throw e;}
      }
      const id=uuid(path[1]??''),key=dataKey(owner,id);let job=await store.get(key,{type:'json'}) as Job|null;if(!job)throw new HttpError(404,'This reconstruction was not found.');
      if(method==='GET' && path[2]==='images') {
        const name=path[3]??'';if(!/^[a-z0-9-]{1,80}\.png$/.test(name))throw new HttpError(400,'Invalid image identifier.');
        const image=await store.get(`images/${owner}/${id}/${name}`,{type:'arrayBuffer'});if(!image)throw new HttpError(404,'This screenshot is unavailable.');
        return new Response(image,{headers:{'content-type':'image/png','cache-control':'private, max-age=300','x-content-type-options':'nosniff'}});
      }
      if(method==='GET' && path.length===2) {
        let workflow:any=null,artifacts:any[]=[];
        if(job.runId&&token){
          try {workflow=await gh(token,`/repos/${REPOSITORY}/actions/runs/${job.runId}`);
            if(ACTIVE.has(job.status)&&workflow.status==='completed') {job.status=workflow.conclusion==='cancelled'?'cancelled':'error';job.message=workflow.conclusion==='cancelled'?'Reconstruction cancelled':'The runner ended without a completed result. Open the run logs for details.';job.updatedAt=new Date().toISOString();await store.setJSON(key,job);}
            if(workflow.status==='completed'){const a=await gh(token,`/repos/${REPOSITORY}/actions/runs/${job.runId}/artifacts`);artifacts=a.artifacts.filter((f:any)=>!f.expired).map((f:any)=>({name:f.name,size:f.size_in_bytes,url:`https://github.com/${REPOSITORY}/actions/runs/${job!.runId}/artifacts/${f.id}`}));}
          }catch{}
        }else if(ACTIVE.has(job.status)&&token) {
          const runs=await gh(token,`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50`);
          const run=runs.workflow_runs.find((r:any)=>r.display_title.includes(id));
          if(run){job.runId=run.id;job.runUrl=run.html_url;await store.setJSON(key,job);}else if(Date.now()-Date.parse(job.createdAt)>600000){job.status='error';job.message='No runner started within ten minutes. Check GitHub Actions permissions and availability.';await store.setJSON(key,job);}
        }
        return json({...job,artifacts,runnerConclusion:workflow?.conclusion??null});
      }
      if(method==='POST' && path[2]==='archive'){
        if(ACTIVE.has(job.status))throw new HttpError(409,'Stop the active reconstruction before archiving it.');
        job.archivedAt=job.archivedAt??new Date().toISOString();job.updatedAt=new Date().toISOString();await store.setJSON(key,job);return json(job);
      }
      if(method==='POST' && path[2]==='restore'){
        delete job.archivedAt;job.updatedAt=new Date().toISOString();await store.setJSON(key,job);return json(job);
      }
      if(method==='DELETE' && path.length===2){
        if(ACTIVE.has(job.status))throw new HttpError(409,'Stop the active reconstruction before deleting it.');
        const outputRepoUrl=job.outputRepoUrl??null;
        await store.delete(key);
        await deletePrefix(store,`images/${owner}/${id}/`);
        await deletePrefix(store,`previews/${owner}/${id}/`);
        return json({deleted:true,outputRepoUrl,note:outputRepoUrl?'The generated GitHub repository was not deleted.':null});
      }
      if(method==='POST' && path[2]==='cancel') {
        if(!ACTIVE.has(job.status))throw new HttpError(409,'This job has already finished.');
        if(!job.runId){const runs=await gh(requiredGithub(),`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50`);const run=runs.workflow_runs.find((r:any)=>r.display_title.includes(id));if(run)job.runId=run.id;}
        if(!job.runId)throw new HttpError(409,'The runner has not assigned an ID yet. Refresh in a few seconds.');
        await gh(requiredGithub(),`/repos/${REPOSITORY}/actions/runs/${job.runId}/cancel`,{method:'POST'});job.status='cancelling';job.message='Cancellation requested; waiting for the runner to stop';await store.setJSON(key,job);return json(job,202);
      }
    }
    if(path[0]==='activity' && method==='GET') {
      const result=await gh(requiredGithub(),`/repos/${REPOSITORY}/actions/runs?per_page=40`);
      return json({runs:result.workflow_runs.map((r:any)=>({id:r.id,name:r.name,title:r.display_title,status:r.status,conclusion:r.conclusion,createdAt:r.created_at,url:r.html_url,branch:r.head_branch,commit:r.head_sha.slice(0,7)}))});
    }
    if(path[0]==='bundles') {
      if(method==='POST' && path.length===1) {
        const input=await body(req);if(!Array.isArray(input.files)||!input.files.length||input.files.length>300)throw new HttpError(400,'Upload 1–300 saved-page files.');
        const names=new Set<string>();let total=0;
        const files=input.files.map((f:any)=>{const path=safePath(f.path),size=Number(f.size);if(names.has(path)||!Number.isInteger(size)||size<0||size>4_000_000)throw new HttpError(400,'Duplicate file or file larger than 4 MB.');names.add(path);total+=size;return{path,size};});
        if(!names.has('bundle.json')||total>50_000_000)throw new HttpError(400,'The bundle needs a manifest and must be under 50 MB.');
        const id=randomUUID();await store.setJSON(`${bundleKey(owner,id)}/manifest`,{id,owner,files,ready:false,createdAt:new Date().toISOString()});return json({id},201);
      }
      const id=uuid(path[1]??''),base=bundleKey(owner,id),m=await store.get(`${base}/manifest`,{type:'json'});if(!m)throw new HttpError(404,'Bundle not found.');
      if(method==='PUT') {
        if(m.ready)throw new HttpError(409,'This upload is already finalized.');const name=safePath(url.searchParams.get('file')??'');const entry=m.files.find((f:any)=>f.path===name);if(!entry)throw new HttpError(400,'File is not in the upload manifest.');
        const content=await bytes(req,4_000_000);if(content.length!==entry.size)throw new HttpError(400,'The uploaded size does not match.');await store.set(fileKey(base,name),content.buffer as ArrayBuffer);return json({saved:true});
      }
      if(method==='POST' && path[2]==='complete') {
        for(const f of m.files){const data=await store.get(fileKey(base,f.path),{type:'arrayBuffer'});if(!data||data.byteLength!==f.size)throw new HttpError(409,`Upload incomplete: ${f.path}`);}
        const manifest=JSON.parse(new TextDecoder().decode(await store.get(fileKey(base,'bundle.json'),{type:'arrayBuffer'})));
        if(!Array.isArray(manifest.pages)||!manifest.pages.length||manifest.pages.length>12)throw new HttpError(400,'Your page manifest must contain 1–12 pages.');
        for(const p of manifest.pages){safePath(p.file);if(!m.files.some((f:any)=>f.path===p.file)||!/^\/(?!\/)/.test(p.route)||/[?#\\]|(?:^|\/)\.\.?\//.test(p.route))throw new HttpError(400,'Invalid page mapping in bundle.');}
        m.ready=true;await store.setJSON(`${base}/manifest`,m);return json({ready:true});
      }
    }
    throw new HttpError(404,'API route not found.');
  } catch(e) {
    if(e instanceof HttpError)return json({error:e.message},e.status);
    return json({error:'The service could not complete this request. Retry once; if it persists, check the deployment function logs.'},500);
  }
}
