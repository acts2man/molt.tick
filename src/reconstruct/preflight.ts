import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture, type CaptureOptions } from './capture.js';
import { assessComplexity } from './complexity.js';
import { integer } from './policy.js';
import type { Evidence } from './types.js';

export interface PreflightOptions {
  url?: string;
  urls?: string[];
  bundleDir?: string;
  workDir: string;
  maxPages?: number;
  maxRepairs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface PreflightReport {
  version: string;
  binding: false;
  site: string;
  pages: ReturnType<typeof assessComplexity>['pages'];
  discoveredPages: number;
  firstPassCredits: number;
  refinementCredits: number;
  suggestedReserveCredits: number;
  maxRepairs: number;
  integrations: Evidence['integrations'];
  warnings: string[];
  blockers: string[];
  limitations: string[];
  evidenceDirectory: string;
  reportPath: string;
}

export function preflightCreditCap(firstPassCredits:number,maxRepairs:number){
  if(!Number.isSafeInteger(firstPassCredits)||firstPassCredits<10)throw new Error('Invalid first-pass credit estimate');
  if(!Number.isInteger(maxRepairs)||maxRepairs<0||maxRepairs>6)throw new Error('Invalid correction limit');
  const pageCredits=firstPassCredits-10;
  const refinementCredits=Math.ceil(pageCredits*Math.max(0,maxRepairs-2)*0.15);
  return {refinementCredits,suggestedReserveCredits:firstPassCredits+refinementCredits};
}

/** Capture and scope a site without invoking an AI model or modifying the source website. */
export async function runPreflight(options:PreflightOptions):Promise<PreflightReport>{
  const maxPages=options.maxPages??12,maxRepairs=options.maxRepairs??2;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>50)throw new Error('maxPages must be 1..50');
  if(!Number.isInteger(maxRepairs)||maxRepairs<0||maxRepairs>6)throw new Error('maxRepairs must be 0..6');
  const minutes=integer(process.env.MOLT_PREFLIGHT_MINUTES,12,1,30);
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(minutes*60_000)]);
  await mkdir(options.workDir,{recursive:true});
  const run=await mkdtemp(join(options.workDir,'preflight-')),evidenceDirectory=join(run,'source'),reportPath=join(run,'preflight.json');
  const progress=async(message:string)=>{await options.onProgress?.(message);};
  await progress('Reading the source before any AI generation');
  const evidence=await capture({url:options.url,urls:options.urls,bundleDir:options.bundleDir,directory:evidenceDirectory,maxPages,signal} satisfies CaptureOptions);
  await progress('Measuring pages, interactions, and services that need separate migration');
  const complexity=assessComplexity(evidence);
  const credits=preflightCreditCap(complexity.firstPassCredits,maxRepairs);
  const report:PreflightReport={
    version:'preflight-2026-09-17',
    binding:false,
    site:evidence.site,
    pages:complexity.pages,
    discoveredPages:evidence.pages.length,
    firstPassCredits:complexity.firstPassCredits,
    refinementCredits:credits.refinementCredits,
    suggestedReserveCredits:credits.suggestedReserveCredits,
    maxRepairs,
    integrations:evidence.integrations,
    warnings:evidence.warnings,
    blockers:evidence.blockers,
    limitations:[
      'This is a measured planning estimate, not a charge, invoice, or guaranteed final price.',
      'No AI generation occurs during preflight.',
      'Backend data, private/admin-only behavior, mailbox hosting, and services invisible to the public frontend may require additional migration scope.',
      ...complexity.limitations,
    ],
    evidenceDirectory,
    reportPath,
  };
  await writeFile(reportPath,JSON.stringify(report,null,2));
  await progress(`Preflight complete: ${report.discoveredPages} page(s), suggested reserve ${report.suggestedReserveCredits} planning credits`);
  return report;
}
