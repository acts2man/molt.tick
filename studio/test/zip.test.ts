import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { unzipSavedPage } from '../src/product/zip.ts';

type Entry={name:string;data:Uint8Array;method:0|8};
function u16(n:number){return Uint8Array.from([n&255,(n>>>8)&255]);}
function u32(n:number){return Uint8Array.from([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);}
function cat(parts:Uint8Array[]){const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
function zip(entries:Entry[]):Uint8Array{
  const locals:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  for(const e of entries){
    const name=new TextEncoder().encode(e.name),compressed=e.method===8?new Uint8Array(deflateRawSync(e.data)):e.data;
    const local=cat([u32(0x04034b50),u16(20),u16(0x800),u16(e.method),u16(0),u16(0),u32(0),u32(compressed.length),u32(e.data.length),u16(name.length),u16(0),name,compressed]);
    locals.push(local);
    central.push(cat([u32(0x02014b50),u16(20),u16(20),u16(0x800),u16(e.method),u16(0),u16(0),u32(0),u32(compressed.length),u32(e.data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));
    offset+=local.length;
  }
  const body=cat(locals),directory=cat(central);
  return cat([body,directory,u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(directory.length),u32(body.length),u16(0)]);
}

test('saved-page ZIP extraction keeps html, css, fonts and images together',async()=>{
  const enc=new TextEncoder();
  const bytes=zip([
    {name:'saved/index.html',data:enc.encode('<!doctype html><link rel="stylesheet" href="style.css">'),method:8},
    {name:'saved/style.css',data:enc.encode('@font-face{font-family:Arvo;src:url(fonts/arvo.woff2)}'),method:8},
    {name:'saved/fonts/arvo.woff2',data:Uint8Array.from([1,2,3,4,5]),method:0},
    {name:'saved/images/tree.webp',data:Uint8Array.from([9,8,7,6]),method:0},
  ]);
  const file=new File([bytes],'home.zip',{type:'application/zip'});
  const out=await unzipSavedPage(file);
  assert.deepEqual(out.map(x=>x.path),['index.html','style.css','fonts/arvo.woff2','images/tree.webp']);
  assert.equal(await out[0].file.text(),'<!doctype html><link rel="stylesheet" href="style.css">');
  assert.equal(out[2].file.type,'font/woff2');
  assert.equal(out[3].file.type,'image/webp');
});

test('saved-page ZIP extraction rejects path traversal',async()=>{
  const enc=new TextEncoder(),bytes=zip([{name:'../evil.html',data:enc.encode('bad'),method:0}]);
  const file=new File([bytes],'bad.zip',{type:'application/zip'});
  await assert.rejects(()=>unzipSavedPage(file),/unsafe path/);
});
