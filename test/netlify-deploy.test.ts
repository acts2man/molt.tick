import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployNetlifyDirectory } from '../scripts/publish-netlify.js';

test('Netlify preflight publishes built files through the deploy API without invoking a build',async()=>{
  const root=await mkdtemp(join(tmpdir(),'molt-netlify-api-'));
  try{
    await mkdir(join(root,'assets'),{recursive:true});
    const html='<!doctype html><title>preflight</title>',js='console.log("ok")';
    await writeFile(join(root,'index.html'),html);await writeFile(join(root,'assets/app.js'),js);
    const required=[createHash('sha1').update(html).digest('hex'),createHash('sha1').update(js).digest('hex')];
    const calls:Array<{url:string;method:string}>=[];
    const uploaded:string[]=[];
    const fetcher=async(input:RequestInfo|URL,init:RequestInit={})=>{
      const url=String(input),method=String(init.method??'GET').toUpperCase();calls.push({url,method});
      if(url.endsWith('/api/v1/sites/site-123/deploys')&&method==='POST'){
        const body=JSON.parse(String(init.body));assert.equal(body.files['/index.html'],required[0]);assert.equal(body.files['/assets/app.js'],required[1]);
        return new Response(JSON.stringify({id:'deploy-123',required}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(url.includes('/api/v1/deploys/deploy-123/files/')&&method==='PUT'){
        uploaded.push(decodeURIComponent(url.split('/files/')[1]??''));return new Response('',{status:200});
      }
      if(url.endsWith('/api/v1/deploys/deploy-123')&&method==='GET')return new Response(JSON.stringify({id:'deploy-123',state:'ready'}),{status:200,headers:{'content-type':'application/json'}});
      return new Response('unexpected '+method+' '+url,{status:500});
    };
    const result=await deployNetlifyDirectory(root,'site-123','netlify-test-token-0123456789012345',fetcher as typeof fetch,async()=>{});
    assert.equal(result.deployId,'deploy-123');assert.deepEqual(uploaded.sort(),['assets/app.js','index.html']);
    assert.equal(calls.some(c=>/build/i.test(c.url)),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
