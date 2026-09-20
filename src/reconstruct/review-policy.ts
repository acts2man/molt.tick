export type ReconstructionReviewStatus='review'|'needs-work';

const VISUAL_REVIEW_NONBLOCKING=[
  /form submission needs a backend integration/i,
] as const;

/** Integration work that does not invalidate the measured frontend reconstruction stays visible
 * in blockers/integrations, but does not masquerade as a visual-engine failure. */
export function reviewBlockingEvidence(blockers:string[]):string[]{
  return blockers.filter(blocker=>!VISUAL_REVIEW_NONBLOCKING.some(pattern=>pattern.test(blocker)));
}

export function reconstructionReviewStatus(evaluationPass:boolean,blockers:string[]):ReconstructionReviewStatus{
  return evaluationPass&&reviewBlockingEvidence(blockers).length===0?'review':'needs-work';
}
