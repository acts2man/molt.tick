import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { ImageInput, ReferenceView, ViewCheck } from './types.js';

export async function loadPng(path: string): Promise<PNG> {
  const bytes = await readFile(path);
  if(bytes.length<24||bytes.readUInt32BE(16)*bytes.readUInt32BE(20)>40_000_000)throw new Error('Screenshot exceeds image budget');
  return PNG.sync.read(bytes);
}
function crop(image:PNG,y:number,height:number):PNG {
  y=Math.max(0,Math.min(Math.floor(y),image.height-1));height=Math.min(height,image.height-y);
  const result=new PNG({width:image.width,height});
  image.data.copy(result.data,0,y*image.width*4,(y+height)*image.width*4);return result;
}
function overview(image:PNG):PNG {
  const scale=Math.min(1,1000/image.width,1400/image.height);
  const width=Math.max(1,Math.round(image.width*scale)),height=Math.max(1,Math.round(image.height*scale));
  const out=new PNG({width,height});
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const source=(Math.min(image.height-1,Math.floor(y/scale))*image.width+Math.min(image.width-1,Math.floor(x/scale)))*4;
    image.data.copy(out.data,(y*width+x)*4,source,source+4);
  }return out;
}
function compactPng(png:PNG,maxBytes=900_000):Buffer{
  let current=png,bytes=PNG.sync.write(current);
  for(let attempt=0;bytes.length>maxBytes&&attempt<4;attempt++){
    const scale=Math.max(0.45,Math.min(0.9,Math.sqrt(maxBytes/bytes.length)*0.92));
    const width=Math.max(1,Math.round(current.width*scale)),height=Math.max(1,Math.round(current.height*scale));
    const next=new PNG({width,height});
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const source=(Math.min(current.height-1,Math.floor(y/scale))*current.width+Math.min(current.width-1,Math.floor(x/scale)))*4;
      current.data.copy(next.data,(y*width+x)*4,source,source+4);
    }
    current=next;bytes=PNG.sync.write(current);
  }
  return bytes;
}
const input=(label:string,png:PNG):ImageInput=>({label,base64:compactPng(png).toString('base64')});
export async function referenceImages(views:ReferenceView[]):Promise<ImageInput[]>{
  const result:ImageInput[]=[],interactionCandidates:Array<{view:ReferenceView;state:NonNullable<ReferenceView['interactions']>[number]}>=[],MAX=18;
  // Adaptive breakpoint probes expand what the evaluator measures, but they must not multiply
  // provider vision input without bound. Every measured viewport gets an overview. Baseline
  // desktop/tablet/mobile views get native-resolution top/middle/bottom evidence; source-derived
  // probes get one native detail. Two interaction overviews are then added if budget remains.
  for(const v of views){
    const png=await loadPng(v.screenshot),probe=v.viewport.name.startsWith('probe-');
    result.push(input(`${v.viewport.name} complete source overview; native dimensions ${png.width}x${png.height}`,overview(png)));
    const maxY=Math.max(0,png.height-1100),positions=new Set<number>([0]);
    if(!probe&&png.height>2200)positions.add(Math.max(0,Math.round(png.height/2)-550));
    if(!probe&&png.height>1100)positions.add(maxY);
    for(const y of [...positions].sort((a,b)=>a-b))result.push(input(`${v.viewport.name} source detail y=${y} at native resolution`,crop(png,y,1100)));
    if(!probe)for(const state of (v.interactions??[]))interactionCandidates.push({view:v,state});
  }
  // Five viewport matrices (3 baseline + 2 probes) use at most 16 static images with the
  // policy above, leaving room for the most useful observed interaction states.
  for(const {view,state} of interactionCandidates.slice(0,Math.max(0,Math.min(2,MAX-result.length)))){
    const opened=await loadPng(state.screenshot);
    result.push(input(`${view.viewport.name} INTERACTION ${state.trigger.kind} "${state.trigger.name}" source state`,overview(opened)));
  }
  if(result.length>MAX)throw new Error('Reference image selection exceeded provider budget after bounded selection');
  return result;
}
export async function repairImages(checks:ViewCheck[]):Promise<ImageInput[]>{
  const result:ImageInput[]=[];
  const views=[...checks].sort((a,b)=>{
    if(a.pass!==b.pass)return a.pass?1:-1;
    return (a.worstBand??101)-(b.worstBand??101)||(a.score??101)-(b.score??101);
  }).slice(0,3);
  for(const v of views){
    const source=await loadPng(v.source);const y=Math.max(0,(v.worstY??0)-100);
    result.push(input(`${v.viewport} SOURCE complete overview`,overview(source)));
    result.push(input(`${v.viewport} SOURCE detail y=${y}`,crop(source,y,1100)));
    if(v.candidate){const target=await loadPng(v.candidate);result.push(input(`${v.viewport} CANDIDATE detail y=${y}`,crop(target,y,1100)));}
    if(v.diff){const diff=await loadPng(v.diff);result.push(input(`${v.viewport} DIFF heatmap detail y=${y}; bright pixels are mismatches`,crop(diff,y,1100)));}
  }
  // Interaction evidence is valuable, but only attach the worst failed state so repairs stay below provider image limits.
  const interactionView=[...views].filter(v=>(v.interactions??[]).some(i=>!i.pass)).sort((a,b)=>(a.worstBand??101)-(b.worstBand??101))[0];
  const failed=interactionView?.interactions?.find(state=>!state.pass);
  if(interactionView&&failed){
    const opened=await loadPng(failed.source);
    result.push(input(`${interactionView.viewport} SOURCE INTERACTION ${failed.trigger.kind} "${failed.trigger.name}"`,overview(opened)));
    if(failed.candidate){const candidate=await loadPng(failed.candidate);result.push(input(`${interactionView.viewport} CANDIDATE INTERACTION ${failed.trigger.kind} "${failed.trigger.name}"`,overview(candidate)));}
  }
  if(result.length>18)throw new Error('Repair image selection exceeded provider budget');
  return result;
}
export async function compare(sourcePath:string,candidatePath:string,diffPath:string):Promise<{score:number;worstBand:number;worstY:number}>{
  const a=await loadPng(sourcePath),b=await loadPng(candidatePath);
  const width=Math.max(a.width,b.width),height=Math.max(a.height,b.height);
  if(width*height>40_000_000)throw new Error('Comparison exceeds pixel budget');
  const fit=(src:PNG)=>{const p=new PNG({width,height});p.data.fill(255);for(let y=0;y<src.height;y++)src.data.copy(p.data,y*width*4,y*src.width*4,(y+1)*src.width*4);return p;};
  const A=fit(a),B=fit(b),diff=new PNG({width,height});
  const pixels=pixelmatch(A.data,B.data,diff.data,width,height,{threshold:0.1});
  let worstBand=100,worstY=0;
  // The global score can hide a visibly wrong card, image or text block inside a wide desktop
  // screenshot. Keep the compatibility field name `worstBand`, but measure the weakest local
  // region as well as each full-width strip. Horizontal prefix sums make this linear in pixels.
  const localWidth=Math.min(width,Math.max(320,Math.round(width/3))),xStep=Math.max(160,Math.floor(localWidth/2));
  for(let y=0;y<height;y+=240){
    const h=Math.min(320,height-y),columns=new Uint32Array(width);
    for(let yy=y;yy<y+h;yy++){
      let offset=(yy*width)*4;
      for(let x=0;x<width;x++,offset+=4)if(diff.data[offset]===255&&diff.data[offset+1]===0&&diff.data[offset+2]===0)columns[x]++;
    }
    const prefix=new Uint32Array(width+1);for(let x=0;x<width;x++)prefix[x+1]=prefix[x]+columns[x];
    const scoreRegion=(x:number,w:number)=>100*(1-(prefix[x+w]-prefix[x])/(w*h));
    const fullScore=scoreRegion(0,width);if(fullScore<worstBand){worstBand=fullScore;worstY=y;}
    if(localWidth<width){
      const starts:number[]=[];for(let x=0;x+localWidth<=width;x+=xStep)starts.push(x);starts.push(width-localWidth);
      for(const x of new Set(starts)){const score=scoreRegion(x,localWidth);if(score<worstBand){worstBand=score;worstY=y;}}
    }
  }
  await writeFile(diffPath,PNG.sync.write(diff));
  return {score:100*(1-pixels/(width*height)),worstBand,worstY};
}
