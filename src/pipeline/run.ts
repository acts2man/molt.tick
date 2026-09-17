/** Compatibility adapter: old worker tables, new evidence-first reconstruction core. */
import { runReconstruction } from '../reconstruct/agent.js';
import type { ReconstructionResult } from '../reconstruct/types.js';
import { shipToNewRepo } from '../ship/ship.js';

export type Stage = 'crawl' | 'normalize' | 'plan' | 'synthesize' | 'verify' | 'ship';
export type MigrationStatus = 'crawling' | 'normalizing' | 'planning' | 'synthesizing' | 'verifying' | 'shipping' | 'review' | 'shipped' | 'error';
export interface PageResult {
  route:string;title:string;section_count:number;widget_count:number;pixel_match:number|null;
  status:'pending'|'verified'|'flagged';screenshot_path?:string;source_screenshot_path?:string;slug?:string;
}
export interface FlagResult {page_route:string;kind:string;summary:string;detail:string}
export interface ProgressEvent {stage:Stage;status:MigrationStatus;message:string;pages?:PageResult[];flags?:FlagResult[]}
export interface PipelineOptions {
  siteUrl:string;workDir:string;outputRepo?:string;maxPages?:number;reuseCaptureDir?:string;
  scope?:'core'|'all'|'posts';urls?:string[];shipRepo?:string;bundleDir?:string;
  onProgress?:(e:ProgressEvent)=>void|Promise<void>;
}
export interface PipelineResult {
  status:MigrationStatus;site_url:string;output_repo:string;elapsed_seconds:number;pages:PageResult[];
  flags:FlagResult[];assets:number;routeChecks:{passed:number;total:number};outDir:string;
  verification?:ReconstructionResult['evaluation'];error?:string;
}
export async function runPipeline(options:PipelineOptions):Promise<PipelineResult>{
  const started=Date.now();let stage:Stage='crawl';
  let outputRepo=options.outputRepo??'molt-reconstruction';
  let assetCount=0;let outDir=options.workDir;let pages:PageResult[]=[];let flags:FlagResult[]=[];
  const emit=async(e:ProgressEvent)=>{stage=e.stage;await options.onProgress?.(e);};
  const finish=(status:MigrationStatus,error?:string,verification?:ReconstructionResult['evaluation']):PipelineResult=>({
    status,site_url:options.siteUrl,output_repo:outputRepo,elapsed_seconds:Math.round((Date.now()-started)/1000),
    pages,flags,assets:assetCount,routeChecks:{passed:pages.filter(p=>p.pixel_match!==null).length,total:pages.length},outDir,verification,error,
  });
  try{
    if(options.reuseCaptureDir)throw new Error('Legacy capture reuse is not accepted by the new core. Use a saved-page bundle (bundle.json) or recapture the live source.');
    if(options.scope&&options.scope!=='core'&&!options.urls?.length)throw new Error('For all-pages or posts-only jobs, provide the explicit page list. The new core does not guess pages from slug length.');
    const result=await runReconstruction({url:options.bundleDir?undefined:options.siteUrl,bundleDir:options.bundleDir,urls:options.urls,workDir:options.workDir,maxPages:options.maxPages,
      onProgress:async(message)=>{
        const verifying=/^(Building|Measured|Best)/.test(message);
        const capturing=message.startsWith('Capturing');
        // Keep legacy claimed jobs out of the queue's 'crawling' state.
        await emit({stage:capturing?'crawl':verifying?'verify':'synthesize',status:capturing?'normalizing':verifying?'verifying':'synthesizing',message});
      },
    });
    outDir=result.outDir;assetCount=result.source.assetCount;
    const routes=[...new Set(result.evaluation.views.map(v=>v.route))];
    pages=routes.map(route=>{
      const checks=result.evaluation.views.filter(v=>v.route===route),desktop=checks.find(v=>v.viewport==='desktop')??checks[0];
      const source=result.source.pages.find(p=>p.route===route)!;
      return {route,title:source.title,section_count:source.sections,widget_count:source.elements,pixel_match:checks.every(v=>v.score!==null)?Math.min(...checks.map(v=>v.score!)):null,
        status:checks.every(v=>v.pass)?'verified':'flagged',screenshot_path:desktop.candidate,source_screenshot_path:desktop.source,
        slug:route==='/'?'home':Buffer.from(route).toString('hex'),
      };
    });
    flags=[...result.blockers.map(detail=>({page_route:'(project)',kind:'no-backend',summary:'Unresolved integration or source evidence',detail})),
      ...result.evaluation.views.filter(v=>!v.pass).map(v=>({page_route:v.route,kind:'runtime-style',summary:`${v.viewport}: reconstruction needs further work`,detail:v.issues.join('; ')||`Pixel match ${v.score??'not measured'}; worst region ${v.worstBand??'not measured'}`}))];
    await emit({stage:'verify',status:'verifying',message:'Reconstruction and repair results',pages,flags});
    if(!result.evaluation.pass)return finish('error',result.reason??'Measured acceptance did not pass',result.evaluation);
    const target=options.shipRepo??process.env.MOLT_SHIP_REPO;
    if(target&&result.status==='review'&&flags.length===0){
      await emit({stage:'ship',status:'shipping',message:'Exporting verified React source'});
      const shipped=await shipToNewRepo({outDir,repoName:target==='1'?outputRepo:target,commitMessage:'Molt evidence-first React reconstruction'});
      if(!shipped.pushed)throw new Error(shipped.error??'Repository export failed');
      outputRepo=shipped.repoUrl??outputRepo;
      await emit({stage:'ship',status:'shipped',message:'Verified source exported',pages,flags});
      return finish('shipped',undefined,result.evaluation);
    }
    await emit({stage:'verify',status:'review',message:flags.length?'Visual review available; integration decisions block automatic export':'Ready for human review',pages,flags});
    return finish('review',undefined,result.evaluation);
  }catch(error){
    const message=(error as Error).message;
    try{await emit({stage,status:'error',message,pages,flags});}catch{}
    return finish('error',message);
  }
}
