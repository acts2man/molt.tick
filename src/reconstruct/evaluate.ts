import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, build, restrictNetwork, serve } from './runtime.js';
import { activateInteraction, geometry, settle } from './capture.js';
import { compare } from './images.js';
import { routeFile } from './policy.js';
import type { Evidence, Evaluation, ViewCheck, Geometry, ElementEvidence } from './types.js';

const normalize=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
const TEXT_TAG=/^(h[1-6]|p|li|button|label|blockquote|strong|b|em|i|span|a|small)$/;
const INLINE_TEXT_TAG=/^(strong|b|em|i|span|a|small)$/;
const FORM_CONTROL_TAG=/^(input|select|textarea)$/;
const FORM_STATE_ATTRS=['placeholder','aria-label','checked','selected-text','disabled','readonly'] as const;
const FORM_STYLE_PROPS=['font-family','font-size','font-weight','line-height','letter-spacing','text-align','color','background','border','border-radius','box-shadow','padding','appearance','accent-color'] as const;
const TYPOGRAPHY_PROPS=['font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','color'] as const;
const short=(e:ElementEvidence)=>{const value=normalize(e.text);return value.length>54?value.slice(0,51)+'…':value||e.tag;};
function typographyDiffs(source:ElementEvidence,candidate:ElementEvidence):string[]{
  const diffs:string[]=[];
  for(const property of TYPOGRAPHY_PROPS){
    const expected=source.style[property]??'',actual=candidate.style[property]??'';
    if(expected===actual)continue;
    diffs.push(`${property} source ${expected||'unset'}, generated ${actual||'unset'}`);
  }
  return diffs;
}
function cssNumber(value:string|undefined):number|null{const n=Number.parseFloat(value??'');return Number.isFinite(n)?n:null;}
export function typographyIssues(source:Geometry,candidate:Geometry):string[]{
  const ranked:Array<{score:number;message:string}>=[];
  for(const pair of matchedTextElements(source,candidate)){
    const diffs=typographyDiffs(pair.source,pair.candidate);if(!diffs.length)continue;
    const sourceSize=cssNumber(pair.source.style['font-size']),candidateSize=cssNumber(pair.candidate.style['font-size']);
    const sizeDelta=sourceSize!==null&&candidateSize!==null?Math.abs(candidateSize-sourceSize):0;
    const priority=/^h[1-6]$/.test(pair.source.tag)?140:(pair.source.tag==='a'||pair.source.tag==='button'?90:30);
    const position=Math.abs(pair.candidate.y-pair.source.y)+Math.abs(pair.candidate.x-pair.source.x)*0.25;
    ranked.push({score:priority+sizeDelta*8+Math.min(80,position),message:'Typography "'+short(pair.source)+'" ('+pair.source.tag+'): '+diffs.join('; ')});
  }
  return ranked.sort((a,b)=>b.score-a.score).slice(0,14).map(item=>item.message);
}
function matchedTextElements(source:Geometry,candidate:Geometry):Array<{source:ElementEvidence;candidate:ElementEvidence}>{
  const visibleCandidate=candidate.elements.filter(e=>normalize(e.text)&&TEXT_TAG.test(e.tag));
  const key=(e:ElementEvidence,text:string)=>(INLINE_TEXT_TAG.test(e.tag)?'inline':e.tag)+'\0'+text;
  const pools=new Map<string,ElementEvidence[]>();
  for(const e of visibleCandidate){
    const text=normalize(e.text),k=key(e,text),items=pools.get(k)??[];items.push(e);pools.set(k,items);
  }
  const out:Array<{source:ElementEvidence;candidate:ElementEvidence}>=[];
  for(const e of source.elements){
    const text=normalize(e.text);if(!text||!TEXT_TAG.test(e.tag))continue;
    const items=pools.get(key(e,text));let actual=items?.shift();
    // If emphasized inline text was flattened into its surrounding paragraph, still compare the
    // fragment against the smallest candidate text box containing it so lost bold/italic is visible.
    if(!actual&&INLINE_TEXT_TAG.test(e.tag)&&text.length>=3){
      actual=visibleCandidate.filter(c=>normalize(c.text).includes(text)).sort((a,b)=>normalize(a.text).length-normalize(b.text).length)[0];
    }
    if(actual)out.push({source:e,candidate:actual});
  }
  return out;
}
const overlapX=(a:ElementEvidence,b:ElementEvidence)=>{
  const left=Math.max(a.x,b.x),right=Math.min(a.x+a.width,b.x+b.width);
  return Math.max(0,right-left)/Math.max(1,Math.min(a.width,b.width));
};
const STRUCTURAL_SOURCE_TAG=/^(header|nav|main|section|article|footer|form)$/;
const STRUCTURAL_CANDIDATE_TAG=/^(header|nav|main|section|article|footer|form|div|aside|figure)$/;
const BOX_STYLE_PROPS=['background','background-image','background-size','background-position','border','border-radius','box-shadow','padding','gap','overflow','filter','backdrop-filter','clip-path'] as const;
const FRAME_STYLE_PROPS=['margin','padding','background','background-image'] as const;
const PSEUDO_STYLE_PROPS=['content','position','top','left','right','bottom','width','height','background','background-image','border','border-radius','transform','opacity'] as const;
function styleDifferences(source:Record<string,string>|undefined,candidate:Record<string,string>|undefined,properties:readonly string[]):string[]{
  if(!source||!candidate)return [];
  return properties.flatMap(property=>{
    const expected=source[property]??'',actual=candidate[property]??'';
    return expected===actual?[]:[`${property} source ${expected||'unset'}, generated ${actual||'unset'}`];
  });
}
function significantVisualSurface(e:ElementEvidence):boolean{
  if(!/^(div|aside|figure)$/.test(e.tag))return false;
  const s=e.style??{},background=String(s.background??'');
  const hasBackground=Boolean(s['background-image']&&s['background-image']!=='none')||Boolean(background&&!/^(?:rgba\(0, 0, 0, 0\)|transparent)(?:\s|$)/i.test(background));
  const hasBorder=Boolean(s.border&&!/^0px\s+none\b/i.test(String(s.border)));
  const hasRadius=Boolean(s['border-radius']&&!/^0px(?:\s+0px){0,3}$/.test(String(s['border-radius'])));
  const hasShadow=Boolean(s['box-shadow']&&s['box-shadow']!=='none');
  const hasEffect=Boolean((s.filter&&s.filter!=='none')||(s['backdrop-filter']&&s['backdrop-filter']!=='none')||(s['clip-path']&&s['clip-path']!=='none'));
  return hasBackground||hasBorder||hasRadius||hasShadow||hasEffect;
}
function pseudoElementIssues(label:string,source:ElementEvidence,candidate:ElementEvidence):string[]{
  const out:string[]=[];
  for(const side of ['before','after'] as const){
    const expected=source[side],actual=candidate[side];
    if(expected&&!actual){out.push(`${label} ::${side} is missing in generated output`);continue;}
    if(!expected&&actual){out.push(`${label} has unexpected generated ::${side}`);continue;}
    if(!expected||!actual)continue;
    const diffs=styleDifferences(expected,actual,PSEUDO_STYLE_PROPS);
    if(diffs.length)out.push(`${label} ::${side}: ${diffs.slice(0,6).join('; ')}`);
  }
  return out;
}
function matchedVisualContainers(source:Geometry,candidate:Geometry):Array<{source:ElementEvidence;candidate:ElementEvidence;ordinal:number}>{
  const expected=source.elements.filter(e=>(STRUCTURAL_SOURCE_TAG.test(e.tag)||significantVisualSurface(e))&&e.width>0&&e.height>0).sort((a,b)=>a.y-b.y||a.x-b.x);
  const available=candidate.elements.filter(e=>STRUCTURAL_CANDIDATE_TAG.test(e.tag)&&e.width>0&&e.height>0),used=new Set<string>();
  const counts=new Map<string,number>(),pairs:Array<{source:ElementEvidence;candidate:ElementEvidence;ordinal:number}>=[];
  for(const item of expected){
    const ordinal=(counts.get(item.tag)??0)+1;counts.set(item.tag,ordinal);
    let best:ElementEvidence|undefined,bestScore=Infinity;
    for(const actual of available){
      if(used.has(actual.key))continue;
      const tagPenalty=actual.tag===item.tag?0:24;
      const score=Math.abs(actual.x-item.x)+Math.abs(actual.y-item.y)+Math.abs(actual.width-item.width)*0.35+Math.abs(actual.height-item.height)*0.35+tagPenalty;
      if(score<bestScore){best=actual;bestScore=score;}
    }
    if(best){used.add(best.key);pairs.push({source:item,candidate:best,ordinal});}
  }
  return pairs;
}
export function visualLayoutIssues(source:Geometry,candidate:Geometry):string[]{
  const issues:Array<{amount:number;message:string}>=[];
  const frame=styleDifferences(source.bodyStyle,candidate.bodyStyle,FRAME_STYLE_PROPS);
  if(frame.length)issues.push({amount:50,message:`Page frame: ${frame.slice(0,4).join('; ')}`});
  for(const pair of matchedVisualContainers(source,candidate)){
    const delta=geometryDelta(pair.source,pair.candidate),amount=Math.max(...Object.values(delta).map(Math.abs));
    if(geometryMismatch(delta,8))issues.push({amount,message:geometryMessage(`Container ${pair.source.tag} #${pair.ordinal}`,pair.source,pair.candidate)});
    const styles=styleDifferences(pair.source.style,pair.candidate.style,BOX_STYLE_PROPS);
    if(styles.length)issues.push({amount:Math.max(20,amount),message:`Container ${pair.source.tag} #${pair.ordinal} treatment: ${styles.slice(0,5).join('; ')}`});
    for(const message of pseudoElementIssues(`Container ${pair.source.tag} #${pair.ordinal}`,pair.source,pair.candidate))issues.push({amount:Math.max(20,amount),message});
  }
  for(const pair of matchedTextElements(source,candidate)){
    if(!/^(p|li|blockquote|button|label|a)$/.test(pair.source.tag))continue;
    const width=Math.abs(pair.candidate.width-pair.source.width),height=Math.abs(pair.candidate.height-pair.source.height);
    if(width>8||height>6)issues.push({amount:Math.max(width,height),message:geometryMessage(`Text box "${short(pair.source)}"`,pair.source,pair.candidate)});
    for(const message of pseudoElementIssues(`Text "${short(pair.source)}"`,pair.source,pair.candidate))issues.push({amount:Math.max(20,width,height),message});
  }
  for(const message of formControlPresentationIssues(source,candidate))issues.push({amount:20,message});
  return issues.sort((a,b)=>b.amount-a.amount).slice(0,12).map(i=>i.message);
}
export function mediaPresentationIssues(source:Geometry,candidate:Geometry,evidence:Evidence):string[]{
  const issues:string[]=[],assetByOriginal=new Map(evidence.assets.map(asset=>[asset.original,asset.publicPath]));
  const generatedImages=candidate.elements.filter(e=>e.tag==='img'&&e.src);
  for(const image of source.elements.filter(e=>e.tag==='img'&&e.src)){
    const local=assetByOriginal.get(image.src!);if(!local)continue;
    const match=generatedImages.find(e=>assetPath(e.src)===local);if(!match)continue;
    const diffs=styleDifferences(image.style,match.style,['object-fit','object-position','border-radius','filter','clip-path']);
    if(diffs.length)issues.push(`Image ${image.attributes?.alt?`"${String(image.attributes.alt).slice(0,70)}"`:local} crop/presentation: ${diffs.join('; ')}`);
  }
  const sourceBackgrounds=source.elements.filter(e=>e.style['background-image']&&e.style['background-image']!=='none');
  const candidateBackgrounds=candidate.elements.filter(e=>e.style['background-image']&&e.style['background-image']!=='none');
  for(const box of sourceBackgrounds){
    const original=[...box.style['background-image'].matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m=>m[1]).find(url=>assetByOriginal.has(url));
    if(!original)continue;const local=assetByOriginal.get(original)!;
    const match=candidateBackgrounds.find(e=>e.style['background-image'].includes(local));if(!match)continue;
    const diffs=styleDifferences(box.style,match.style,['background-size','background-position','border-radius']);
    if(diffs.length)issues.push(`Background ${local} presentation: ${diffs.join('; ')}`);
  }
  return issues.slice(0,8);
}

const geometryDelta=(source:ElementEvidence,candidate:ElementEvidence)=>({
  x:candidate.x-source.x,y:candidate.y-source.y,width:candidate.width-source.width,height:candidate.height-source.height
});
const geometryMismatch=(delta:{x:number;y:number;width:number;height:number},tolerance=4)=>
  Math.max(Math.abs(delta.x),Math.abs(delta.y),Math.abs(delta.width),Math.abs(delta.height))>tolerance;
const geometryMessage=(label:string,source:ElementEvidence,candidate:ElementEvidence)=>{
  const d=geometryDelta(source,candidate);
  return `${label}: source x/y ${Math.round(source.x)}/${Math.round(source.y)}px, ${Math.round(source.width)}×${Math.round(source.height)}px; generated ${Math.round(candidate.x)}/${Math.round(candidate.y)}px, ${Math.round(candidate.width)}×${Math.round(candidate.height)}px; delta x ${Math.round(d.x)}, y ${Math.round(d.y)}, width ${Math.round(d.width)}, height ${Math.round(d.height)}px`;
};
function assetPath(value:string|undefined):string{
  if(!value)return '';
  try{return new URL(value,'https://molt.invalid').pathname;}catch{return value;}
}
function localizedAssetUrls(value:string|undefined,assetByOriginal:Map<string,string>):string[]{
  if(!value||value==='none')return [];
  const urls=[...value.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match=>match[1]);
  return urls.flatMap(url=>{const local=assetByOriginal.get(url);return local?[local]:[];});
}
function generatedAssetPaths(candidate:Geometry):Set<string>{
  const found=new Set<string>();
  for(const element of candidate.elements){
    if(element.src){const path=assetPath(element.src);if(path.startsWith('/assets/'))found.add(path);}
    for(const value of [element.style['background-image'],element.before?.['background-image'],element.after?.['background-image']]){
      if(!value)continue;
      for(const match of value.matchAll(/url\(["']?([^"')]+)["']?\)/g)){
        const path=assetPath(match[1]);if(path.startsWith('/assets/'))found.add(path);
      }
    }
  }
  return found;
}
export function mediaAssetPresenceIssues(source:Geometry,candidate:Geometry,evidence:Evidence):string[]{
  // A truncated candidate geometry is an intentionally sampled inventory. Never infer absence from incomplete evidence.
  if(candidate.truncated)return [];
  const assetByOriginal=new Map(evidence.assets.map(asset=>[asset.original,asset.publicPath])),used=generatedAssetPaths(candidate);
  const expected=new Map<string,string>();
  for(const element of source.elements){
    if(element.width*element.height<256)continue;
    if(element.tag==='img'&&element.src){
      const local=assetByOriginal.get(element.src);
      if(local)expected.set(local,element.attributes?.alt?`image "${String(element.attributes.alt).slice(0,70)}"`:'image');
    }
    for(const [kind,value] of [['background',element.style['background-image']],['::before background',element.before?.['background-image']],['::after background',element.after?.['background-image']]] as const){
      for(const local of localizedAssetUrls(value,assetByOriginal))if(!expected.has(local))expected.set(local,kind);
    }
  }
  return [...expected].filter(([local])=>!used.has(local)).map(([local,label])=>`Visible source ${label} asset is missing from generated output: ${local}`).slice(0,8);
}
export function mediaGeometryIssues(source:Geometry,candidate:Geometry,evidence:Evidence):string[]{
  const issues:Array<{amount:number;message:string}>=[],assetByOriginal=new Map(evidence.assets.map(asset=>[asset.original,asset.publicPath]));
  const generatedImages=candidate.elements.filter(e=>e.tag==='img'&&e.src);
  for(const image of source.elements.filter(e=>e.tag==='img'&&e.src)){
    const local=assetByOriginal.get(image.src!);if(!local)continue;
    const match=generatedImages.find(e=>assetPath(e.src)===local);if(!match)continue;
    const delta=geometryDelta(image,match);if(!geometryMismatch(delta))continue;
    issues.push({amount:Math.max(...Object.values(delta).map(Math.abs)),message:geometryMessage(`Image ${image.attributes?.alt?`"${String(image.attributes.alt).slice(0,70)}"`:local}`,image,match)});
  }
  const sourceBackgrounds=source.elements.filter(e=>e.style['background-image']&&e.style['background-image']!=='none');
  const candidateBackgrounds=candidate.elements.filter(e=>e.style['background-image']&&e.style['background-image']!=='none');
  for(const box of sourceBackgrounds){
    const original=[...box.style['background-image'].matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m=>m[1]).find(url=>assetByOriginal.has(url));
    if(!original)continue;const local=assetByOriginal.get(original)!;
    const match=candidateBackgrounds.find(e=>e.style['background-image'].includes(local));if(!match)continue;
    const delta=geometryDelta(box,match);if(!geometryMismatch(delta))continue;
    issues.push({amount:Math.max(...Object.values(delta).map(Math.abs)),message:geometryMessage(`Background ${local}`,box,match)});
  }
  return issues.sort((a,b)=>b.amount-a.amount).slice(0,8).map(i=>i.message);
}
export function controlGeometryIssues(source:Geometry,candidate:Geometry):string[]{
  const issues:Array<{amount:number;message:string}>=[];
  for(const pair of matchedTextElements(source,candidate)){
    const role=pair.source.attributes?.role??'';
    if(pair.source.tag!=='button'&&role!=='button')continue;
    const delta=geometryDelta(pair.source,pair.candidate);if(!geometryMismatch(delta))continue;
    issues.push({amount:Math.max(...Object.values(delta).map(Math.abs)),message:geometryMessage(`Control "${short(pair.source)}"`,pair.source,pair.candidate)});
  }
  return issues.sort((a,b)=>b.amount-a.amount).slice(0,6).map(i=>i.message);
}
function visibleFormControls(value:Geometry):ElementEvidence[]{return value.elements.filter(e=>FORM_CONTROL_TAG.test(e.tag));}
function formControlLabel(control:ElementEvidence,index:number):string{
  const attr=control.attributes??{},name=attr['aria-label']||attr.placeholder||attr['selected-text'];
  if(name)return `${control.tag} "${String(name).slice(0,70)}"`;
  const type=control.tag==='input'?(attr.type||'text'):control.tag;
  return `${type} control #${index+1}`;
}
export function formControlIssues(source:Geometry,candidate:Geometry):string[]{
  const expected=visibleFormControls(source),actual=visibleFormControls(candidate),issues:string[]=[];
  if(expected.length!==actual.length)issues.push(`Visible form control count differs: source ${expected.length}, generated ${actual.length}`);
  const count=Math.min(expected.length,actual.length);
  for(let i=0;i<count;i++){
    const before=expected[i],after=actual[i],label=formControlLabel(before,i);
    if(before.tag!==after.tag)issues.push(`${label}: source element ${before.tag}, generated ${after.tag}`);
    if(before.tag==='input'&&after.tag==='input'){
      const a=String(before.attributes?.type||'text').toLowerCase(),b=String(after.attributes?.type||'text').toLowerCase();
      if(a!==b)issues.push(`${label}: type source ${a}, generated ${b}`);
    }
    for(const key of FORM_STATE_ATTRS){
      const a=String(before.attributes?.[key]??''),b=String(after.attributes?.[key]??'');
      if(normalize(a)!==normalize(b))issues.push(`${label}: ${key} source ${a||'unset'}, generated ${b||'unset'}`);
    }
    const delta=geometryDelta(before,after);if(geometryMismatch(delta,4))issues.push(geometryMessage(`Form ${label}`,before,after));
  }
  return issues.slice(0,12);
}
function formControlPresentationIssues(source:Geometry,candidate:Geometry):string[]{
  const expected=visibleFormControls(source),actual=visibleFormControls(candidate),issues:string[]=[];
  for(let i=0;i<Math.min(expected.length,actual.length);i++){
    const diffs=styleDifferences(expected[i].style,actual[i].style,FORM_STYLE_PROPS);
    if(diffs.length)issues.push(`Form ${formControlLabel(expected[i],i)} styling: ${diffs.slice(0,7).join('; ')}`);
  }
  return issues.slice(0,6);
}
export function spacingIssues(source:Geometry,candidate:Geometry):string[]{
  const pairs=matchedTextElements(source,candidate),problems:string[]=[...typographyIssues(source,candidate)];
  const horizontal:Array<{amount:number;message:string}>=[],vertical:Array<{amount:number;message:string}>=[];
  for(const pair of pairs){
    if(INLINE_TEXT_TAG.test(pair.source.tag))continue;
    const leftDelta=pair.candidate.x-pair.source.x;
    const sourceCenter=pair.source.x+pair.source.width/2,candidateCenter=pair.candidate.x+pair.candidate.width/2;
    const centerDelta=candidateCenter-sourceCenter;
    if(Math.abs(leftDelta)>8&&Math.abs(centerDelta)>8)horizontal.push({amount:Math.max(Math.abs(leftDelta),Math.abs(centerDelta)),message:`Horizontal alignment "${short(pair.source)}": source x ${Math.round(pair.source.x)}px, generated x ${Math.round(pair.candidate.x)}px; source center ${Math.round(sourceCenter)}px, generated center ${Math.round(candidateCenter)}px`});
    const yDelta=pair.candidate.y-pair.source.y;
    if(Math.abs(yDelta)>10)vertical.push({amount:Math.abs(yDelta),message:`Vertical placement "${short(pair.source)}": source y ${Math.round(pair.source.y)}px, generated y ${Math.round(pair.candidate.y)}px (${Math.round(Math.abs(yDelta))}px ${yDelta>0?'too low':'too high'})`});
  }
  horizontal.sort((a,b)=>b.amount-a.amount);vertical.sort((a,b)=>b.amount-a.amount);
  problems.push(...horizontal.slice(0,5).map(item=>item.message),...vertical.slice(0,6).map(item=>item.message));

  const byParent=new Map<string,typeof pairs>();
  for(const pair of pairs){
    const parent=pair.source.parent;if(!parent)continue;
    const items=byParent.get(parent)??[];items.push(pair);byParent.set(parent,items);
  }
  const gaps:Array<{amount:number;message:string}>=[];
  for(const items of byParent.values()){
    items.sort((a,b)=>a.source.y-b.source.y||a.source.x-b.source.x);
    for(let i=0;i<items.length-1;i++){
      const a=items[i],b=items[i+1];
      if(b.source.y<a.source.y+a.source.height-2||overlapX(a.source,b.source)<0.12)continue;
      const sourceGap=b.source.y-(a.source.y+a.source.height);
      if(sourceGap<0||sourceGap>500)continue;
      const candidateGap=b.candidate.y-(a.candidate.y+a.candidate.height),delta=candidateGap-sourceGap;
      const tolerance=Math.max(5,Math.min(12,sourceGap*0.12));
      if(Math.abs(delta)<=tolerance)continue;
      gaps.push({amount:Math.abs(delta),message:`Spacing "${short(a.source)}" → "${short(b.source)}": source ${Math.round(sourceGap)}px, generated ${Math.round(candidateGap)}px (${Math.round(Math.abs(delta))}px too ${delta>0?'large':'small'})`});
    }
  }
  gaps.sort((a,b)=>b.amount-a.amount);
  problems.push(...gaps.slice(0,8).map(g=>g.message));
  return problems;
}
export function internalLinkIssues(source:Geometry,candidate:Geometry,captureOrigin:string,generatedOrigin:string,known:Set<string>,originalOrigin=captureOrigin):string[]{
  const problems:string[]=[],expected=new Set<string>(),actual=new Set<string>();
  const routeOf=(raw:string)=>{try{const u=new URL(raw);if(![captureOrigin,originalOrigin].includes(u.origin)||u.search)return null;return u.pathname.replace(/\/+$/,'')||'/';}catch{return null;}};
  for(const raw of source.links){const route=routeOf(raw);if(route&&known.has(route))expected.add(route);}
  for(const raw of candidate.links){
    try{
      const u=new URL(raw),route=u.pathname.replace(/\/+$/,'')||'/';
      if(u.origin===generatedOrigin){if(known.has(route))actual.add(route);else if(!u.pathname.startsWith('/assets/'))problems.push(`Unresolved internal link: ${route}`);}
      else if(u.origin===originalOrigin&&known.has(route))problems.push(`Internal link still points to the source website instead of the reconstructed route: ${route}`);
    }catch{}
  }
  for(const route of expected)if(!actual.has(route))problems.push(`Missing reconstructed internal link target: ${route}`);
  return [...new Set(problems)];
}
export function contentIssues(source:Geometry,candidate:Geometry):string[]{
  const problems:string[]=[];
  if(normalize(source.text)!==normalize(candidate.text))problems.push('Visible copy or reading order differs from the source');
  if(candidate.brokenImages)problems.push(`${candidate.brokenImages} generated images failed to load`);
  if(candidate.overflow&&!source.overflow)problems.push('Generated layout overflows the viewport');
  if(candidate.embeds.length)problems.push('Unapproved embedded runtime in generated output');
  const headings=candidate.elements.filter(e=>/^h[1-6]$/.test(e.tag));
  for(const original of source.elements.filter(e=>/^h[1-6]$/.test(e.tag))){
    const index=headings.findIndex(e=>e.tag===original.tag&&normalize(e.text)===normalize(original.text));
    if(index<0){problems.push(`Missing heading: ${original.text}`);continue;}
    const actual=headings.splice(index,1)[0];
    const mismatches=['x','y','width','height'].filter(k=>Math.abs(original[k as 'x'|'y'|'width'|'height']-actual[k as 'x'|'y'|'width'|'height'])>2);
    for(const property of TYPOGRAPHY_PROPS)if(original.style[property]!==actual.style[property])mismatches.push(property);
    if(mismatches.length)problems.push(`Heading ${original.text}: ${mismatches.join(', ')} differ`);
  }
  problems.push(...spacingIssues(source,candidate),...controlGeometryIssues(source,candidate),...formControlIssues(source,candidate));
  if(Math.abs(source.height-candidate.height)>Math.max(3,source.height*0.005))problems.push(`Page height differs: source ${source.height}px, generated ${candidate.height}px`);
  return problems;
}
export function emptyEvaluation(evidence:Evidence,issue:string):Evaluation{
  return {pass:false,issues:[issue],views:evidence.pages.flatMap(p=>p.views.map(v=>({route:p.route,viewport:v.viewport.name,score:null,worstBand:null,pass:false,issues:[issue],source:v.screenshot})))};
}
export async function evaluate(outDir:string,evidence:Evidence,directory:string,signal:AbortSignal,threshold=97,bandThreshold=92):Promise<Evaluation>{
  if(!Number.isFinite(threshold)||threshold<=0||threshold>100||!Number.isFinite(bandThreshold)||bandThreshold<=0||bandThreshold>100)throw new Error('Invalid visual acceptance thresholds');
  await mkdir(directory,{recursive:true});
  // A failed compilation must never reuse an earlier dist directory.
  await rm(join(outDir,'dist'),{recursive:true,force:true});
  const compilation=await build(outDir,AbortSignal.any([signal,AbortSignal.timeout(120000)]));
  await writeFile(join(directory,'build.log'),compilation.log);
  if(!compilation.ok)return emptyEvaluation(evidence,`Production compilation failed: ${compilation.log}`);
  const aliases=Object.fromEntries(evidence.pages.map(p=>[p.route,'index.html']));
  const host=await serve(join(outDir,'dist'),aliases);
  let engine:Awaited<ReturnType<typeof browser>>|undefined;
  const stop=()=>{void engine?.close();};signal.addEventListener('abort',stop,{once:true});
  const result:Evaluation={pass:false,issues:[],views:[]};
  try{
    signal.throwIfAborted();engine=await browser();
    for(const pageRef of evidence.pages){for(const reference of pageRef.views){
      signal.throwIfAborted();
      const slug=routeFile(pageRef.route).split('/').pop()!.replace('.tsx','');
      const stem=`${slug}-${reference.viewport.name}`;
      const check:ViewCheck={route:pageRef.route,viewport:reference.viewport.name,source:reference.screenshot,score:null,worstBand:null,pass:false,issues:[]};
      const ctx=await engine.newContext({viewport:reference.viewport,deviceScaleFactor:1,colorScheme:'light',locale:'en-US',serviceWorkers:'block',acceptDownloads:false});
      try{
        await restrictNetwork(ctx,host.origin,true);const page=await ctx.newPage();
        const errors:string[]=[];
        page.on('pageerror',e=>errors.push(e.message));
        page.on('requestfailed',r=>{if(['image','font','stylesheet','script'].includes(r.resourceType())&&!r.url().endsWith('favicon.ico'))errors.push(`Failed resource: ${r.url().replace(host.origin,'')}`);});
        const response=await page.goto(host.origin+pageRef.route,{waitUntil:'load',timeout:30000});
        if(!response?.ok())throw new Error(`Generated route HTTP ${response?.status()}`);
        await settle(page,signal);
        check.candidate=join(directory,`${stem}.png`);check.diff=join(directory,`${stem}.diff.png`);
        await page.screenshot({path:check.candidate,fullPage:true,animations:'disabled',scale:'css',timeout:15000});
        const generated=await geometry(page);
        check.issues.push(...contentIssues(reference.geometry,generated),...mediaGeometryIssues(reference.geometry,generated,evidence),...mediaAssetPresenceIssues(reference.geometry,generated,evidence),...errors);
        // Literal DOM links are checked after rendering, including shared components. Same-site links
        // must point to the reconstructed host rather than silently sending users back to the source site.
        const known=new Set(evidence.pages.map(p=>p.route));
        check.issues.push(...internalLinkIssues(reference.geometry,generated,new URL(pageRef.url).origin,host.origin,known,new URL(evidence.site).origin));
        const metrics=await compare(check.source,check.candidate,check.diff);Object.assign(check,metrics);
        if(metrics.score<threshold||metrics.worstBand<bandThreshold)check.issues.push(...visualLayoutIssues(reference.geometry,generated),...mediaPresentationIssues(reference.geometry,generated,evidence));
        check.interactions=[];
        for(let stateIndex=0;stateIndex<(reference.interactions??[]).length;stateIndex++){
          const state=reference.interactions![stateIndex];
          if(stateIndex>0){
            const reset=await page.goto(host.origin+pageRef.route,{waitUntil:'load',timeout:30000});
            if(!reset?.ok()){check.issues.push(`Interaction reset failed before "${state.trigger.name}"`);break;}
            await page.mouse.move(0,0);await settle(page,signal);
          }
          const stateCheck={id:state.id,trigger:state.trigger,score:null,worstBand:null,pass:false,issues:[],source:state.screenshot} as NonNullable<ViewCheck['interactions']>[number];
          if(!await activateInteraction(page,state.trigger)){
            stateCheck.issues.push(`Generated page is missing interactive control: ${state.trigger.name}`);
          }else{
            await page.waitForTimeout(250);
            await page.evaluate(`(() => { for(const a of document.getAnimations()){try{if(a.effect.getComputedTiming().iterations!==Infinity)a.finish();}catch{}} })()`);
            stateCheck.candidate=join(directory,`${stem}-${state.id}.png`);
            stateCheck.diff=join(directory,`${stem}-${state.id}.diff.png`);
            await page.screenshot({path:stateCheck.candidate,fullPage:true,animations:'disabled',scale:'css',timeout:15000});
            const stateGenerated=await geometry(page);
            stateCheck.issues.push(...contentIssues(state.geometry,stateGenerated),...mediaGeometryIssues(state.geometry,stateGenerated,evidence),...mediaAssetPresenceIssues(state.geometry,stateGenerated,evidence));
            const stateMetrics=await compare(stateCheck.source,stateCheck.candidate,stateCheck.diff);Object.assign(stateCheck,stateMetrics);
            if(stateMetrics.score<threshold||stateMetrics.worstBand<bandThreshold)stateCheck.issues.push(...visualLayoutIssues(state.geometry,stateGenerated),...mediaPresentationIssues(state.geometry,stateGenerated,evidence));
            stateCheck.pass=stateCheck.issues.length===0&&stateMetrics.score>=threshold&&stateMetrics.worstBand>=bandThreshold;
            await writeFile(join(directory,`${stem}-${state.id}.json`),JSON.stringify({source:state.geometry,generated:stateGenerated,check:stateCheck},null,2));
          }
          if(!stateCheck.pass)check.issues.push(`Interaction "${state.trigger.name}" does not match its observed source state`);
          check.interactions.push(stateCheck);
        }
        check.pass=check.issues.length===0&&metrics.score>=threshold&&metrics.worstBand>=bandThreshold&&check.interactions.every(i=>i.pass);
        await writeFile(join(directory,`${stem}.json`),JSON.stringify({source:reference.geometry,generated,check},null,2));
      }catch(error){check.issues.push((error as Error).message);check.pass=false;}
      finally{await ctx.close().catch(()=>{});}
      result.views.push(check);
    }}
    result.pass=result.views.length>0&&result.views.every(v=>v.pass);
    return result;
  }finally{signal.removeEventListener('abort',stop);await engine?.close().catch(()=>{});await host.close();}
}
