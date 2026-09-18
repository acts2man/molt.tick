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
const input=(label:string,png:PNG):ImageInput=>({label,base64:PNG.sync.write(png).toString('base64')});
export async function referenceImages(views:ReferenceView[]):Promise<ImageInput[]>{
  const result:ImageInput[]=[];
  for(const v of views){const png=await loadPng(v.screenshot);
    result.push(input(`${v.viewport.name} complete source overview; native dimensions ${png.width}x${png.height}`,overview(png)));
    result.push(input(`${v.viewport.name} source y=0 at native resolution`,crop(png,0,1100)));
    if(png.height>2200){
      const middle=Math.max(0,Math.round(png.height/2)-550);
      result.push(input(`${v.viewport.name} source middle y=${middle} at native resolution`,crop(png,middle,1100)));
    }
    if(png.height>1100)result.push(input(`${v.viewport.name} source bottom y=${png.height-1100}`,crop(png,png.height-1100,1100)));
    for(const state of (v.interactions??[]).slice(0,2)){
      const opened=await loadPng(state.screenshot);
      result.push(input(`${v.viewport.name} INTERACTION ${state.trigger.kind} "${state.trigger.name}" source state`,overview(opened)));
    }
  }return result;
}
export async function repairImages(checks:ViewCheck[]):Promise<ImageInput[]>{
  const result:ImageInput[]=[];
  const views=checks.slice(0,3);
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
  for(let y=0;y<height;y+=320){const h=Math.min(320,height-y);const mismatch=pixelmatch(A.data.subarray(y*width*4,(y+h)*width*4),B.data.subarray(y*width*4,(y+h)*width*4),undefined,width,h,{threshold:0.1});const score=100*(1-mismatch/(width*h));if(score<worstBand){worstBand=score;worstY=y;}}
  await writeFile(diffPath,PNG.sync.write(diff));
  return {score:100*(1-pixels/(width*height)),worstBand,worstY};
}
