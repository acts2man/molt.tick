export type ReasoningEffort='low'|'medium'|'high'|'xhigh'|'max';

export function effectiveRepairRounds(pages:number,requested:number):number{
  if(!Number.isInteger(pages)||pages<1||pages>50||!Number.isInteger(requested)||requested<0||requested>20)throw new Error('Invalid reconstruction repair scope');
  if(requested===0)return 0;
  // Economy settings remain literal. The high-fidelity settings guarantee at least one
  // direct repair opportunity per page, while the loop still stops early when all views pass.
  return requested>=4?Math.min(20,Math.max(requested,pages)):requested;
}

export function productionRunBudget(pages:number,requestedRepairs:number,effort:ReasoningEffort){
  const repairRounds=effectiveRepairRounds(pages,requestedRepairs);
  const effortMinutes={low:0,medium:0,high:5,xhigh:8,max:10}[effort];
  const agentMinutes=Math.min(65,Math.max(25,15+pages*4+repairRounds*2+effortMinutes));
  const requestMs={low:180000,medium:180000,high:300000,xhigh:420000,max:540000}[effort];
  const maxOutputTokens={low:16000,medium:16000,high:24000,xhigh:32000,max:40000}[effort];
  // Includes headroom for one malformed first reply per page plus bounded provider retries.
  // This is a request-attempt ceiling, not a promise that every attempt is billable.
  const maxModelCalls=Math.min(60,Math.max(8,pages*3+repairRounds*2+4));
  return {pages,requestedRepairs,repairRounds,agentMinutes,requestMs,maxOutputTokens,maxModelCalls};
}
