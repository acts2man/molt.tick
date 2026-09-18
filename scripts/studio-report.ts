const clip=(value:any,n=600)=>String(value??'').slice(0,n);
const list=(value:any,count=40,n=600)=>Array.isArray(value)?value.slice(0,count).map(v=>clip(v,n)):[];
export function compactStudioReport(input:any){
  const evaluation=input?.evaluation??{};
  const views=Array.isArray(evaluation.views)?evaluation.views.slice(0,72).map((v:any)=>({
    route:clip(v.route,200),viewport:clip(v.viewport,30),pass:v.pass===true,
    score:typeof v.score==='number'?v.score:null,worstBand:typeof v.worstBand==='number'?v.worstBand:null,
    issues:list(v.issues,20,500),
    sourceImage:clip(v.sourceImage,90)||null,candidateImage:clip(v.candidateImage,90)||null,diffImage:clip(v.diffImage,90)||null,
    interactions:Array.isArray(v.interactions)?v.interactions.slice(0,8).map((i:any)=>({
      id:clip(i.id,120),trigger:{kind:clip(i.trigger?.kind,40),name:clip(i.trigger?.name,180)},pass:i.pass===true,
      score:typeof i.score==='number'?i.score:null,worstBand:typeof i.worstBand==='number'?i.worstBand:null,
      issues:list(i.issues,10,400),sourceImage:clip(i.sourceImage,90)||null,candidateImage:clip(i.candidateImage,90)||null,diffImage:clip(i.diffImage,90)||null
    })):[]
  })):[];
  const usage=input?.usage?{
    calls:Number(input.usage.calls)||0,inputTokens:Number(input.usage.inputTokens)||0,outputTokens:Number(input.usage.outputTokens)||0,
    records:Array.isArray(input.usage.records)?input.usage.records.slice(0,24).map((r:any)=>({
      provider:clip(r.provider,40),model:clip(r.model,80),inputTokens:Number(r.inputTokens)||0,cachedInputTokens:Number(r.cachedInputTokens)||0,
      cacheWriteTokens:Number(r.cacheWriteTokens)||0,outputTokens:Number(r.outputTokens)||0,estimatedUsd:typeof r.estimatedUsd==='number'?r.estimatedUsd:null,
      reported:r.reported===true,outcome:clip(r.outcome,60),pricingReviewed:clip(r.pricingReviewed,30)
    })):[],costEstimate:input.usage.costEstimate??null
  }:null;
  const complexity=input?.complexity?{
    version:clip(input.complexity.version,60),binding:false,firstPassCredits:Number(input.complexity.firstPassCredits)||0,
    pages:Array.isArray(input.complexity.pages)?input.complexity.pages.slice(0,12).map((p:any)=>({
      route:clip(p.route,200),complexity:clip(p.complexity,20),credits:Number(p.credits)||0,reasons:list(p.reasons,12,240)
    })):[]
  }:null;
  return {
    status:clip(input?.status,20),reason:clip(input?.reason,1200),warnings:list(input?.warnings,40,500),
    blockers:list(input?.blockers,40,500),integrations:Array.isArray(input?.integrations)?input.integrations.slice(0,60).map((i:any)=>({kind:clip(i.kind,60),provider:clip(i.provider,120),route:clip(i.route,200),evidence:clip(i.evidence,500),action:clip(i.action,700)})):[],usage,complexity,
    evaluation:{pass:evaluation.pass===true,issues:list(evaluation.issues,40,500),views},
    attempts:Array.isArray(input?.attempts)?input.attempts.slice(0,20).map((a:any)=>({round:a.round,accepted:a.accepted===true,summary:clip(a.summary,800)})):[]
  };
}
export function finalStudioEvent(report:any,handoff:any={}){
  const handoffFailed=typeof handoff?.deploymentError==='string'||typeof handoff?.outputRepoError==='string';
  const message=handoffFailed?'The reconstruction is saved, but its repository or live deployment needs attention.':report?.status==='review'?'Measured checks and delivery handoff passed. Your reconstruction is ready for review.':'The best reconstruction is saved. Differences or integrations still need attention.';
  return {message,report:compactStudioReport(report),
    ...(handoff?.previewReady===true?{previewReady:true}:{}),
    ...(typeof handoff?.outputRepoUrl==='string'?{outputRepoUrl:clip(handoff.outputRepoUrl,500)}:{}),
    ...(typeof handoff?.outputRepoError==='string'?{outputRepoError:clip(handoff.outputRepoError,1000)}:{}),
    ...(typeof handoff?.liveSiteUrl==='string'?{liveSiteUrl:clip(handoff.liveSiteUrl,500)}:{}),
    ...(typeof handoff?.liveSiteAdminUrl==='string'?{liveSiteAdminUrl:clip(handoff.liveSiteAdminUrl,500)}:{}),
    ...(typeof handoff?.deploymentError==='string'?{deploymentError:clip(handoff.deploymentError,1000)}:{}),
  };
}
