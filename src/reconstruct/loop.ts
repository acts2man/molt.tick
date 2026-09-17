import { improves, validEvaluation } from './policy.js';
import type { Attempt, Evaluation, ModelReply } from './types.js';

/** A bounded state machine; injected effects make rollback and failure paths testable. */
export interface LoopPorts<Snapshot> {
  snapshot():Promise<Snapshot>;
  restore(snapshot:Snapshot):Promise<void>;
  digest(snapshot:Snapshot):string;
  evaluate(round:number):Promise<Evaluation>;
  propose(best:Evaluation,history:Attempt[],round:number):Promise<ModelReply>;
  apply(reply:ModelReply):Promise<void>;
  save(best:Evaluation,history:Attempt[]):Promise<void>;
}
export async function repairLoop<S>(ports:LoopPorts<S>,options:{maxRounds:number;signal:AbortSignal}):Promise<{evaluation:Evaluation;attempts:Attempt[];reason?:string}>{
  if(!Number.isInteger(options.maxRounds)||options.maxRounds<0||options.maxRounds>20)throw new Error('Repair limit must be 0..20');
  options.signal.throwIfAborted();
  let bestSnapshot=await ports.snapshot();let best=await ports.evaluate(0);
  if(!validEvaluation(best))throw new Error('Evaluator returned an invalid initial result');
  const attempts:Attempt[]=[{round:0,accepted:true,summary:'Initial reconstruction',evaluation:best,digest:ports.digest(bestSnapshot)}];
  const seen=new Set([ports.digest(bestSnapshot)]);await ports.save(best,attempts);
  let reason:string|undefined;
  for(let round=1;!best.pass&&round<=options.maxRounds;round++){
    if(options.signal.aborted){reason='Reconstruction cancelled or time budget exhausted';break;}
    let summary='',accepted=false,evaluation=best,candidateDigest=ports.digest(bestSnapshot);
    try{
      const reply=await ports.propose(best,attempts,round);summary=reply.summary;
      options.signal.throwIfAborted();await ports.apply(reply);
      const candidate=await ports.snapshot();candidateDigest=ports.digest(candidate);
      if(seen.has(candidateDigest)){summary='Rejected repeated or unchanged repair';}
      else{
        seen.add(candidateDigest);evaluation=await ports.evaluate(round);
        if(improves(best,evaluation)){best=evaluation;bestSnapshot=candidate;accepted=true;}
        else summary=`Rejected regression or non-improving repair: ${summary}`;
      }
    }catch(error){summary=`Repair failed: ${(error as Error).message}`;}
    // Always restore after a failed/partial write or rejected candidate.
    if(!accepted)await ports.restore(bestSnapshot);
    attempts.push({round,accepted,summary,evaluation,digest:candidateDigest});
    await ports.save(best,attempts);
  }
  await ports.restore(bestSnapshot);
  if(!best.pass&&!reason)reason='Repair budget exhausted; best measured version retained for review';
  return {evaluation:best,attempts,reason};
}
