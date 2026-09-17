import { randomUUID, createHash } from 'node:crypto';
import { ACTIVE, BRANCH, HttpError, Job, OWNER, PREFLIGHT_WORKFLOW, REPOSITORY, Settings, WORKFLOW, newJob, safePath, uuid } from './contracts.ts';
import { assertMutation, cookie, runnerIdentity } from './security.ts';
import { createSession, readSession, revokeSession } from './sessions.ts';
import { checkProvider, github, saveSecrets } from './github.ts';

export interface Store {
  get(key: string, options?: {type: 'json' | 'arrayBuffer'}): Promise<any>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  set(key: string, value: ArrayBuffer): Promise<unknown>;
  list(options: {prefix: string}): Promise<{blobs: {key: string}[]}>;
  delete(key: string): Promise<unknown>;
}
export interface Environment { secret: string; origin: string; context: string }
export interface Services {
  store: Store; env: Environment; github?: typeof github;
  identifyRunner?: typeof runnerIdentity; saveSecrets?: typeof saveSecrets; checkProvider?: typeof checkProvider;
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
const fileKey = (base: string, path: string) => `${base}/files/${createHash('sha256').update(safePath(path)).digest('hex')}`;
async function jobs(store: Store, owner: string): Promise<Job[]> {
  const {blobs} = await store.list({prefix: `jobs/${owner}/`});
  const rows = await Promise.all(blobs.filter(b => b.key.split('/').length === 3).slice(-100).map(b => store.get(b.key, {type: 'json'})));
  return rows.filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
function safeUsage(value:any):any {const clip=(v:unknown,n=2000)=>String(v??'').slice(0,n);return { calls:Number(value?.calls)||0,inputTokens:Number(value?.inputTokens)||0,outputTokens:Number(value?.outputTokens)||0,
      records:Array.isArray(value?.records)?value.records.slice(0,200).map((r:any)=>({call:Number(r.call)||0,provider:clip(r.provider,30),model:clip(r.model,100),inputTokens:typeof r.inputTokens==='number'&&Number.isSafeInteger(r.inputTokens)&&r.inputTokens>=0?r.inputTokens:null,outputTokens:typeof r.outputTokens==='number'&&Number.isSafeInteger(r.outputTokens)&&r.outputTokens>=0?r.outputTokens:null,estimatedUsd:typeof r.estimatedUsd==='number'&&Number.isFinite(r.estimatedUsd)&&r.estimatedUsd>=0?r.estimatedUsd:null,reported:r.reported===true,outcome:clip(r.outcome,60),pricingReviewed:clip(r.pricingReviewed,30)})):[],
      costEstimate:value?.costEstimate?{estimatedUsd:typeof value.costEstimate.estimatedUsd==='number'&&Number.isFinite(value.costEstimate.estimatedUsd)?value.costEstimate.estimatedUsd:null,complete:value.costEstimate.complete===true,unpricedCalls:Number(value.costEstimate.unpricedCalls)||0,excludes:clip(value.costEstimate.excludes)}:null };}
function safePreflight(input:any):any {
  if(!input||input.binding!==false||!Array.isArray(input.pages))throw new HttpError(400,'Invalid preflight report.');
  const clip=(value:unknown,n=2000)=>String(value??'').slice(0,n);
  const list=(value:unknown)=>Array.isArray(value)?value.slice(0,100).map(v=>clip(v)):[];
  const credit=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=100000?value:0;
  return {
    version:clip(input.version,60),binding:false,site:clip(input.site,500),discoveredPages:Math.min(50,Math.max(0,Number(input.discoveredPages)||0)),
    firstPassCredits:credit(input.firstPassCredits),refinementCredits:credit(input.refinementCredits),suggestedReserveCredits:credit(input.suggestedReserveCredits),
    maxRepairs:Math.min(6,Math.max(0,Number(input.maxRepairs)||0)),
    pages:input.pages.slice(0,50).map((p:any)=>({route:clip(p.route,200),complexity:clip(p.complexity,20),credits:credit(p.credits),sections:Math.max(0,Number(p.sections)||0),images:Math.max(0,Number(p.images)||0),elements:Math.max(0,Number(p.elements)||0),height:Math.max(0,Number(p.height)||0),reasons:list(p.reasons)})),
    integrations:Array.isArray(input.integrations)?input.integrations.slice(0,100).map((i:any)=>({kind:clip(i.kind,40),provider:clip(i.provider,120),route:clip(i.route,200),evidence:clip(i.evidence,500),action:clip(i.action)})):[],
    warnings:list(input.warnings),blockers:list(input.blockers),limitations:list(input.limitations),
  };
}
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
        job.events=[...job.events,{at:now,message:job.message}].slice(-80);
        if(event.preflight){job.preflight=safePreflight(event.preflight);job.status='scoped';job.message=`Scope analyzed: ${job.preflight.discoveredPages} page(s), up to ${job.preflight.suggestedReserveCredits} planning credits`;}
        else if(event.report){job.report=safeReport(event.report);job.status=job.report.status;}
        else if(event.error){job.status='error';job.error=String(event.error).slice(0,4000);}else if(job.status!=='cancelling')job.status='running';
        await store.setJSON(key,job);return json({saved:true});
      }
      throw new HttpError(404,'Runner route not found.');
    }
    const session=await readSession(req,store,env.secret);
    if(method==='GET' && path[0]==='session'){
      // Read the real automatically provisioned backend before reporting readiness.
      await store.get('system/studio-health',{type:'json'});
      return json({connected:!!session,login:session?.login??null,serverReady:true,repository:REPOSITORY,branch:BRANCH,hosting:'Netlify',runner:'GitHub Actions'});
    }
    if(!['GET','HEAD'].includes(method))assertMutation(req);
    if(method==='POST' && path[0]==='connect') {
      const input=await body(req),token=String(input.token??'').trim();
      if(token.length<20||token.length>255||/\s/.test(token))throw new HttpError(400,'Enter a valid GitHub fine-grained access token.');
      const user=await gh(token,'/user');if(String(user.login).toLowerCase()!==OWNER)throw new HttpError(403,`This workspace belongs to ${OWNER}. Use that GitHub account.`);
      const repo=await gh(token,`/repos/${REPOSITORY}`);if(!repo.permissions?.push)throw new HttpError(403,'This token must have access to the Molt repository.');
      await gh(token,`/repos/${REPOSITORY}/actions/workflows?per_page=1`);
      const identifier=await createSession(store,token,OWNER);
      await revokeSession(req,store);
      return json({connected:true,login:user.login},200,{'set-cookie':cookie(identifier)});
    }
    if(method==='POST' && path[0]==='disconnect'){await revokeSession(req,store);return json({connected:false},200,{'set-cookie':cookie('',true)});}
    if(!session)throw new HttpError(401,'Connect your GitHub workspace to continue.');
    const token=session.token,owner=session.login;
    if(path[0]==='settings') {
      if(method==='GET') {
        const settings=await store.get(`settings/${owner}`,{type:'json'}) as Settings|null;
        let permissionsError='',names:string[]=[],workflow=false;
        try{const secrets=await gh(token,`/repos/${REPOSITORY}/actions/secrets?per_page=100`);names=secrets.secrets.map((s:any)=>s.name);}catch(e){permissionsError=(e as Error).message;}
        try{const w=await gh(token,`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`);workflow=w.state==='active';}catch{}
        const provider=settings?.provider??(names.includes('OPENAI_API_KEY')?'openai':names.includes('ANTHROPIC_API_KEY')?'anthropic':'openai');
        const keyPresent=names.includes(provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY');
        return json({provider,model:settings?.model??(provider==='openai'?'gpt-6-astra':''),keyPresent,modelConfigured:names.includes('MOLT_AI_MODEL'),workflow,permissionsError,ready:keyPresent&&names.includes('MOLT_AI_MODEL')&&workflow,configuredAt:settings?.configuredAt??null,accessChecked:settings?.accessChecked??false});
      }
      if(method==='POST') {
        const input=await body(req),provider=input.provider,model=String(input.model??'').trim(),apiKey=String(input.apiKey??'').trim();
        if(!['openai','anthropic'].includes(provider)||!model||model.length>100||!/^[\w.:-]+$/.test(model))throw new HttpError(400,'Choose a provider and enter its exact API model ID.');
        const values:Record<string,string>={MOLT_MODEL_PROVIDER:provider,MOLT_AI_MODEL:model};
        if(apiKey){if(apiKey.length<20||apiKey.length>512||/\s/.test(apiKey))throw new HttpError(400,'The API key format is invalid.');await (services.checkProvider??checkProvider)(provider,model,apiKey);values[provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY']=apiKey;}
        else{const secrets=await gh(token,`/repos/${REPOSITORY}/actions/secrets?per_page=100`);if(!secrets.secrets.some((s:any)=>s.name===(provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY')))throw new HttpError(400,'Enter an API key for the selected provider.');}
        await (services.saveSecrets??saveSecrets)(token,values);
        const settings:Settings={provider,model,configuredAt:new Date().toISOString(),accessChecked:!!apiKey};await store.setJSON(`settings/${owner}`,settings);return json({saved:true,...settings});
      }
    }
    if(path[0]==='jobs') {
      if(method==='GET' && path.length===1)return json({jobs:await jobs(store,owner)});
      if(method==='POST' && path.length===1) {
        const input=await body(req);if(input.developmentTest!==true)throw new HttpError(400,'This runner is for owner development tests, not customer production jobs. Confirm the test scope in Studio.');const job=newJob(input,owner),key=dataKey(owner,job.id),existing=await store.get(key,{type:'json'});
        if(existing){if(existing.sourceUrl!==job.sourceUrl||JSON.stringify(existing.pages)!==JSON.stringify(job.pages)||existing.bundleId!==job.bundleId||existing.maxPages!==job.maxPages||existing.maxRepairs!==job.maxRepairs)throw new HttpError(409,'This request ID was already used for another website.');return json(existing);}
        const recent=await jobs(store,owner);if(recent.some(j=>ACTIVE.has(j.status)))throw new HttpError(409,'A reconstruction is already active. Finish or cancel it before starting another.');
        if(recent.filter(j=>Date.now()-Date.parse(j.createdAt)<3600000).length>=5)throw new HttpError(429,'This workspace allows five new jobs per hour to limit accidental usage.');
        const secrets=await gh(token,`/repos/${REPOSITORY}/actions/secrets?per_page=100`),names=secrets.secrets.map((s:any)=>s.name);
        if(!names.includes('MOLT_AI_MODEL')||(!names.includes('OPENAI_API_KEY')&&!names.includes('ANTHROPIC_API_KEY')))throw new HttpError(409,'Finish the model connection before starting a reconstruction.');
        if(job.bundleId){const m=await store.get(`${bundleKey(owner,job.bundleId)}/manifest`,{type:'json'});if(!m?.ready)throw new HttpError(409,'Your page bundle has not finished uploading.');}
        await store.setJSON(key,job);
        try {
          const dispatch=await gh(token,`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,{method:'POST',body:JSON.stringify({ref:BRANCH,inputs:{job_id:job.id}})});
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
        if(job.runId){
          try {workflow=await gh(token,`/repos/${REPOSITORY}/actions/runs/${job.runId}`);
            if(ACTIVE.has(job.status)&&workflow.status==='completed') {job.status=workflow.conclusion==='cancelled'?'cancelled':'error';job.message=workflow.conclusion==='cancelled'?'Reconstruction cancelled':'The runner ended without a completed result. Open the run logs for details.';job.updatedAt=new Date().toISOString();await store.setJSON(key,job);}
            if(workflow.status==='completed'){const a=await gh(token,`/repos/${REPOSITORY}/actions/runs/${job.runId}/artifacts`);artifacts=a.artifacts.filter((f:any)=>!f.expired).map((f:any)=>({name:f.name,size:f.size_in_bytes,url:`https://github.com/${REPOSITORY}/actions/runs/${job!.runId}/artifacts/${f.id}`}));}
          }catch{}
        }else if(ACTIVE.has(job.status)) {
          const runs=await gh(token,`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50`);
          const run=runs.workflow_runs.find((r:any)=>r.display_title.includes(id));
          if(run){job.runId=run.id;job.runUrl=run.html_url;await store.setJSON(key,job);}else if(Date.now()-Date.parse(job.createdAt)>600000){job.status='error';job.message='No runner started within ten minutes. Check GitHub Actions permissions and availability.';await store.setJSON(key,job);}
        }
        return json({...job,artifacts,runnerConclusion:workflow?.conclusion??null});
      }
      if(method==='POST' && path[2]==='cancel') {
        if(!ACTIVE.has(job.status))throw new HttpError(409,'This job has already finished.');
        if(!job.runId){const runs=await gh(token,`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50`);const run=runs.workflow_runs.find((r:any)=>r.display_title.includes(id));if(run)job.runId=run.id;}
        if(!job.runId)throw new HttpError(409,'The runner has not assigned an ID yet. Refresh in a few seconds.');
        await gh(token,`/repos/${REPOSITORY}/actions/runs/${job.runId}/cancel`,{method:'POST'});job.status='cancelling';job.message='Cancellation requested; waiting for the runner to stop';await store.setJSON(key,job);return json(job,202);
      }
    }
    if(path[0]==='activity' && method==='GET') {
      const result=await gh(token,`/repos/${REPOSITORY}/actions/runs?per_page=40`);
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
