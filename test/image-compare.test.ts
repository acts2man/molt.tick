import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { compare } from '../src/reconstruct/images.js';

test('localized visual mismatches cannot hide inside a high global desktop score',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'molt-compare-'));
  try{
    const width=1440,height=640,source=new PNG({width,height}),candidate=new PNG({width,height});
    source.data.fill(255);candidate.data.fill(255);
    for(let y=100;y<220;y++)for(let x=600;x<720;x++){const i=(y*width+x)*4;candidate.data[i]=0;candidate.data[i+1]=0;candidate.data[i+2]=0;candidate.data[i+3]=255;}
    const sourcePath=join(dir,'source.png'),candidatePath=join(dir,'candidate.png'),diffPath=join(dir,'diff.png');
    await writeFile(sourcePath,PNG.sync.write(source));await writeFile(candidatePath,PNG.sync.write(candidate));
    const metrics=await compare(sourcePath,candidatePath,diffPath);
    assert.ok(metrics.score>97,`global score should demonstrate dilution, got ${metrics.score}`);
    assert.ok(metrics.worstBand<92,`localized region must expose the visible defect, got ${metrics.worstBand}`);
  }finally{await rm(dir,{recursive:true,force:true});}
});
