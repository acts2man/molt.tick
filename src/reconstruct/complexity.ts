import type { Evidence } from './types.js';
/** Transparent engineering estimate, not a final customer quote or backend migration. */
export function assessComplexity(evidence:Evidence){
 const pages=evidence.pages.map(page=>{
  const g=page.views[0].geometry;
  const sections=g.elements.filter(e=>/^(section|main|header|footer)$/.test(e.tag)).length;
  const images=g.elements.filter(e=>e.tag==='img').length;
  const elements=g.elements.length;
  const reasons:string[]=[];
  let weight=0;
  if(elements>500){weight+=2;reasons.push('More than 500 captured layout elements');}else if(elements>220){weight++;reasons.push('More than 220 captured layout elements');}
  if(g.height>8000){weight+=2;reasons.push('Page taller than 8000 desktop pixels');}else if(g.height>4500){weight++;reasons.push('Page taller than 4500 desktop pixels');}
  if(images>25){weight++;reasons.push('More than 25 image elements');}
  if(sections>12){weight++;reasons.push('More than 12 structural sections');}
  if(g.embeds.length){weight++;reasons.push('Embedded services require separate review');}
  if(g.forms){reasons.push('Forms need backend/delivery integration');}
  const complexity=weight>=4?'complex':weight>=2?'standard':'simple';
  return {route:page.route,complexity,credits:complexity==='complex'?40:complexity==='standard'?20:10,sections,images,elements,height:g.height,reasons};
 });
 return {version:'observed-planning-2026-09-17',binding:false,setupCredits:10,pages,firstPassCredits:10+pages.reduce((n,p)=>n+p.credits,0),
  limitations:['Not a binding quote or customer charge.','Static measurements do not prove plugin complexity or interaction coverage.','Backend integrations require a separate scope.','Refinement, infrastructure cost and human review are not included in this first-pass estimate.']};
}
