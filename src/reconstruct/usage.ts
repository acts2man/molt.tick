/** Provider-reported usage, retained even when its generated code is rejected.
 * Rates are estimates for standard API pricing, never a provider invoice.
 */
export const PRICING_REVIEWED = '2026-09-17';
export interface UsageRecord {
 call:number; provider:string; model:string; inputTokens:number|null; cachedInputTokens:number|null;
 outputTokens:number|null; estimatedUsd:number|null; reported:boolean; outcome:string; pricingReviewed:string;
}
export function usageRecord(call:number,provider:string,model:string,raw:unknown,outcome:string):UsageRecord{
 const value=raw as Record<string,any>|null;
 const n=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
 const input=n(value?.input_tokens),output=n(value?.output_tokens);
 // Anthropic's input/cached-token accounting differs; do not invent a USD rate.
 const cached=provider==='openai'?n(value?.input_tokens_details?.cached_tokens??0):null;
 const reported=input!==null&&output!==null;
 let cost:number|null=null;
 if(provider==='openai'&&model==='gpt-6-astra'&&reported&&cached!==null&&cached<=input!){
  const long=input!>272000;
  cost=((input!-cached)*10*(long?2:1)+cached*1*(long?2:1)+output!*50*(long?1.5:1))/1000000;
 }
 return{call,provider,model,inputTokens:input,cachedInputTokens:cached,outputTokens:output,estimatedUsd:cost,reported,outcome:outcome.slice(0,60),pricingReviewed:PRICING_REVIEWED};
}
export function usageSummary(records:UsageRecord[]){
 const priced=records.filter(r=>r.estimatedUsd!==null);
 return{estimatedUsd:priced.reduce((n,r)=>n+r.estimatedUsd!,0),pricedCalls:priced.length,unpricedCalls:records.length-priced.length,
  complete:records.length>0&&priced.length===records.length,pricingReviewed:PRICING_REVIEWED,
  excludes:'Compute, storage, regional or priority pricing, taxes, and usage without a provider report. Not a customer-credit charge or a provider invoice.'};
}
