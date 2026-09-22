import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { unzipSavedPage, unzipSavedPages } from '../src/product/zip.ts';

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

test('saved-page ZIP extraction accepts files above the former 4 MB ceiling',async()=>{
  const data=new Uint8Array(4_200_000);data.fill(7);
  const bytes=zip([{name:'index.html',data,method:0}]);
  const file=new File([bytes],'large-page.zip',{type:'application/zip'});
  const out=await unzipSavedPage(file);
  assert.equal(out.length,1);assert.equal(out[0].file.size,4_200_000);
});

test('saved-page ZIP extraction rejects path traversal',async()=>{
  const enc=new TextEncoder(),bytes=zip([{name:'../evil.html',data:enc.encode('bad'),method:0}]);
  const file=new File([bytes],'bad.zip',{type:'application/zip'});
  await assert.rejects(()=>unzipSavedPage(file),/unsafe path/);
});


test('multiple SingleFile ZIPs are namespaced and mapped without filename collisions',async()=>{
  const enc=new TextEncoder();
  const home=new File([zip([
    {name:'index.html',data:enc.encode('<!doctype html><link rel="canonical" href="https://example.com/">'),method:8},
    {name:'style.css',data:enc.encode('body{margin:0}'),method:8},
    {name:'images/logo.png',data:Uint8Array.from([1,2,3]),method:0},
  ])],'home.zip',{type:'application/zip'});
  const about=new File([zip([
    {name:'index.html',data:enc.encode('<!doctype html><link rel="canonical" href="https://example.com/about/">'),method:8},
    {name:'style.css',data:enc.encode('body{margin:1px}'),method:8},
    {name:'images/logo.png',data:Uint8Array.from([4,5,6]),method:0},
  ])],'about.zip',{type:'application/zip'});
  const result=await unzipSavedPages([home,about]);
  assert.equal(result.pages.length,2);
  assert.deepEqual(result.pages.map(page=>page.route),['/','/about']);
  assert.equal(new Set(result.files.map(file=>file.path)).size,result.files.length);
  assert.ok(result.files.some(file=>file.path==='saved-pages/01-home/index.html'));
  assert.ok(result.files.some(file=>file.path==='saved-pages/02-about/index.html'));
  assert.ok(result.files.some(file=>file.path==='saved-pages/01-home/images/logo.png'));
  assert.ok(result.files.some(file=>file.path==='saved-pages/02-about/images/logo.png'));
  assert.ok(result.files.some(file=>file.path==='manifest.json'));
});

test('SingleFile embedded frame HTML does not count as extra website pages',async()=>{
  const enc=new TextEncoder();
  const saved=new File([zip([
    {name:'index.html',data:enc.encode('<!doctype html><link rel="canonical" href="https://example.com/contact/">'),method:8},
    {name:'manifest.json',data:enc.encode(JSON.stringify({originalUrl:'https://example.com/contact/',indexFilename:'index.html',resources:{'frames/0/':'https://newassets.hcaptcha.com/captcha/frame'}})),method:8},
    {name:'frames/0/index.html',data:enc.encode('<!doctype html><title>hCaptcha checkbox</title>'),method:8},
    {name:'frames/0/manifest.json',data:enc.encode(JSON.stringify({originalUrl:'https://newassets.hcaptcha.com/captcha/frame',indexFilename:'index.html'})),method:8},
    {name:'frames/1/index.html',data:enc.encode('<!doctype html><title>hCaptcha challenge</title>'),method:8},
    {name:'frames/1/manifest.json',data:enc.encode(JSON.stringify({originalUrl:'https://newassets.hcaptcha.com/captcha/challenge',indexFilename:'index.html'})),method:8},
  ])],'contact.zip',{type:'application/zip'});
  const result=await unzipSavedPages([saved]);
  assert.equal(result.pages.length,1);
  assert.equal(result.pages[0].route,'/contact');
  assert.ok(result.files.some(file=>file.path.includes('/frames/0/index.html')));
  assert.ok(result.files.some(file=>file.path.includes('/frames/1/index.html')));
});

test('multi ZIP upload requires one page per ZIP and caps selection at twelve archives',async()=>{
  const enc=new TextEncoder();
  const twoPages=new File([zip([
    {name:'one.html',data:enc.encode('<h1>One</h1>'),method:8},
    {name:'two.html',data:enc.encode('<h1>Two</h1>'),method:8},
  ])],'two-pages.zip',{type:'application/zip'});
  await assert.rejects(()=>unzipSavedPages([twoPages]),/one saved website page per ZIP/);
  const one=new File([zip([{name:'index.html',data:enc.encode('<h1>One</h1>'),method:8}])],'page.zip',{type:'application/zip'});
  await assert.rejects(()=>unzipSavedPages(Array.from({length:13},()=>one)),/1 to 12/);
});
