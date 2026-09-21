import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runReconstruction } from '../src/reconstruct/agent.js';
import { productionRunBudget } from '../src/reconstruct/budgets.js';
import { reserveOutputRepository, publishReservedOutputRepository, deleteReservedOutputRepository } from './publish-output.js';
import { preflightNetlify, createNetlifySite, configureContinuousNetlifyDeploy, deleteNetlifySite, type NetlifySite } from './publish-netlify.js';

const target='https://ceballostreeservices.com';
const selectedPages=5,selectedRepairs=4,effort='medium' as const;
const budget=productionRunBudget(selectedPages,selectedRepairs,effort);
process.env.MOLT_AGENT_MINUTES=String(budget.agentMinutes);
process.env.MOLT_MAX_MODEL_CALLS=String(budget.maxModelCalls);
process.env.MOLT_MAX_TRANSPORT_ATTEMPTS=String(budget.maxTransportAttempts);
process.env.MOLT_AI_MAX_TOKENS=String(budget.maxOutputTokens);
process.env.MOLT_MODEL_TIMEOUT_MS=String(budget.requestMs);
const githubToken=process.env.MOLT_GITHUB_EXPORT_TOKEN??'';
const netlifyToken=process.env.MOLT_NETLIFY_AUTH_TOKEN??'';
const teamSlug=process.env.MOLT_NETLIFY_TEAM_SLUG??'';
const runId=(process.env.GITHUB_RUN_ID??Date.now().toString()).replace(/[^0-9]/g,'').slice(-10);
const root=resolve('paid-benchmark'),workDir=join(root,'work');
const baseName=`molt-ceballos-sol-medium-${runId}`;
let repository:string|undefined,site:NetlifySite|undefined,published=false;

await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
const summary:any={
  ok:false,target,configuration:{provider:'openai',model:'gpt-5.6-sol',reasoningEffort:effort,maxPages:selectedPages,selectedCorrectionRounds:selectedRepairs,effectiveRepairCeiling:budget.repairRounds},
  budget:{agentMinutes:budget.agentMinutes,maxModelCalls:budget.maxModelCalls,maxTransportAttempts:budget.maxTransportAttempts,maxOutputTokens:budget.maxOutputTokens,requestMs:budget.requestMs},
  startedAt:new Date().toISOString()
};
try{
  if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is not configured.');
  if(!githubToken||!netlifyToken||!teamSlug)throw new Error('GitHub/Netlify delivery secrets are not configured.');

  // Delivery readiness is proven before the first paid model call.
  const reserved=await reserveOutputRepository(process.cwd(),'acts2man',baseName,githubToken);repository=reserved.repository;
  await preflightNetlify(teamSlug,netlifyToken);
  site=await createNetlifySite(teamSlug,baseName,netlifyToken);
  summary.deliveryPreflight={repository,site:site.url,passed:true};
  await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));

  const result=await runReconstruction({
    url:target,workDir,maxPages:selectedPages,maxRepairs:selectedRepairs,
    onProgress:message=>console.log('[paid-benchmark]',message)
  });
  summary.reconstruction={
    status:result.status,
    pages:result.source.pages,
    views:result.evaluation.views.map(v=>({
      route:v.route,viewport:v.viewport,pass:v.pass,score:v.score,worstRegion:v.worstBand,worstY:v.worstY,
      issues:v.issues,interactions:(v.interactions??[]).map(i=>({name:i.trigger.name,kind:i.trigger.kind,pass:i.pass,score:i.score,worstRegion:i.worstBand,issues:i.issues}))
    })),
    evaluationPass:result.evaluation.pass,evaluationIssues:result.evaluation.issues,
    attempts:result.attempts.map(a=>({round:a.round,accepted:a.accepted,summary:a.summary})),
    warnings:result.warnings,blockers:result.blockers,integrations:result.integrations,usage:result.usage,
    reportPath:result.reportPath
  };
  await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));

  const publishedRepo=await publishReservedOutputRepository(result.outDir,repository,githubToken);
  const deployed=await configureContinuousNetlifyDeploy(result.outDir,repository,site,githubToken,netlifyToken);
  published=true;
  summary.ok=true;
  summary.delivery={repository:publishedRepo.repository,repositoryUrl:publishedRepo.url,liveSiteUrl:deployed.url,netlifyAdminUrl:deployed.adminUrl,deployWorkflowUrl:deployed.workflowUrl};
  summary.completedAt=new Date().toISOString();
  await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));
  console.log('MOLT_PAID_BENCHMARK_COMPLETE',JSON.stringify({status:result.status,repository:publishedRepo.url,site:deployed.url,usage:result.usage}));
}catch(error){
  summary.error=error instanceof Error?error.message:String(error);summary.completedAt=new Date().toISOString();
  await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));
  if(!published){
    if(site)await deleteNetlifySite(site.id,netlifyToken);
    if(repository)await deleteReservedOutputRepository(process.cwd(),repository,githubToken);
  }
  throw error;
}
