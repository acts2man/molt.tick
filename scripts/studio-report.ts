export function compactStudioReport(input:any){
  const evaluation=input?.evaluation??{};
  const views=Array.isArray(evaluation.views)?evaluation.views.slice(0,72).map((v:any)=>({
    route:v.route,viewport:v.viewport,pass:v.pass===true,
    score:typeof v.score==='number'?v.score:null,worstBand:typeof v.worstBand==='number'?v.worstBand:null,
    issues:Array.isArray(v.issues)?v.issues.slice(0,40):[],
    sourceImage:v.sourceImage??null,candidateImage:v.candidateImage??null,diffImage:v.diffImage??null,
    interactions:Array.isArray(v.interactions)?v.interactions.slice(0,12).map((i:any)=>({
      id:i.id,trigger:i.trigger,pass:i.pass===true,score:typeof i.score==='number'?i.score:null,worstBand:typeof i.worstBand==='number'?i.worstBand:null,
      issues:Array.isArray(i.issues)?i.issues.slice(0,20):[],sourceImage:i.sourceImage??null,candidateImage:i.candidateImage??null,diffImage:i.diffImage??null
    })):[]
  })):[];
  return {
    status:input?.status,reason:input?.reason??'',warnings:Array.isArray(input?.warnings)?input.warnings.slice(0,80):[],
    blockers:Array.isArray(input?.blockers)?input.blockers.slice(0,80):[],usage:input?.usage??null,complexity:input?.complexity??null,
    evaluation:{pass:evaluation.pass===true,issues:Array.isArray(evaluation.issues)?evaluation.issues.slice(0,80):[],views},
    attempts:Array.isArray(input?.attempts)?input.attempts.slice(0,20).map((a:any)=>({round:a.round,accepted:a.accepted===true,summary:String(a.summary??'').slice(0,1200)})):[]
  };
}
export function finalStudioEvent(report:any,handoff:any={}){
  return {message:report?.status==='review'?'Measured checks passed. Your reconstruction is ready for review.':'The best reconstruction is saved. Differences or integrations still need attention.',report:compactStudioReport(report),
    ...(handoff?.previewReady===true?{previewReady:true}:{}),
    ...(typeof handoff?.outputRepoUrl==='string'?{outputRepoUrl:handoff.outputRepoUrl}:{}),
    ...(typeof handoff?.outputRepoError==='string'?{outputRepoError:handoff.outputRepoError}:{}),
  };
}
