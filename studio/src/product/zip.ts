import { BUNDLE_MAX_FILE_BYTES, BUNDLE_MAX_FILES, BUNDLE_MAX_TOTAL_BYTES } from '../../server/contracts';
export type ExtractedZipFile={path:string;file:File};

function mime(path:string):string{
  const ext=path.toLowerCase().split('.').pop()??'';
  return ({html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'} as Record<string,string>)[ext]??'application/octet-stream';
}
function decodeName(bytes:Uint8Array,utf8:boolean):string{
  return new TextDecoder(utf8?'utf-8':'utf-8',{fatal:false}).decode(bytes);
}
function bufferPart(bytes:Uint8Array):ArrayBuffer{return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;}
async function inflateRaw(bytes:Uint8Array):Promise<Uint8Array>{
  if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot unpack ZIP files. Use a current Chrome, Edge, Safari, or Firefox release, or upload the extracted folder instead.');
  const stream=new Blob([bufferPart(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function normalize(path:string):string{
  let value=path.replace(/\\/g,'/').replace(/^\.\//,'');
  while(value.startsWith('/'))value=value.slice(1);
  if(!value||value.includes('\0'))throw new Error('The ZIP contains an invalid file name.');
  const parts=value.split('/').filter(Boolean);
  if(parts.some(p=>p==='.'||p==='..'))throw new Error('The ZIP contains an unsafe path.');
  return parts.join('/');
}
export async function unzipSavedPage(file:File):Promise<ExtractedZipFile[]>{
  if(file.size>120_000_000)throw new Error('Use an individual saved-page ZIP smaller than 120 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer()),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let eocd=-1;for(let i=Math.max(0,bytes.length-65_557);i<=bytes.length-22;i++)if(view.getUint32(i,true)===0x06054b50)eocd=i;
  if(eocd<0)throw new Error('This ZIP is missing its directory record or is not a standard ZIP archive.');
  const entries=view.getUint16(eocd+10,true),centralOffset=view.getUint32(eocd+16,true);
  if(entries===0xffff||centralOffset===0xffffffff)throw new Error('ZIP64 archives are not supported yet. Re-save this page as a normal ZIP.');
  if(entries<1||entries>400)throw new Error('Use a ZIP containing 1 to 400 files.');
  let cursor=centralOffset,total=0;const records:Array<{path:string;method:number;compressed:number;size:number;offset:number}>=[];
  for(let i=0;i<entries;i++){
    if(cursor+46>bytes.length||view.getUint32(cursor,true)!==0x02014b50)throw new Error('The ZIP central directory is invalid.');
    const flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),compressed=view.getUint32(cursor+20,true),size=view.getUint32(cursor+24,true),nameLen=view.getUint16(cursor+28,true),extraLen=view.getUint16(cursor+30,true),commentLen=view.getUint16(cursor+32,true),offset=view.getUint32(cursor+42,true);
    if(flags&1)throw new Error('Password-protected ZIP files are not supported.');
    if([compressed,size,offset].some(v=>v===0xffffffff))throw new Error('ZIP64 archives are not supported yet.');
    const raw=bytes.slice(cursor+46,cursor+46+nameLen),rawName=decodeName(raw,!!(flags&0x800));
    cursor+=46+nameLen+extraLen+commentLen;
    if(rawName.endsWith('/'))continue;
    const path=normalize(rawName);total+=size;
    if(size>BUNDLE_MAX_FILE_BYTES)throw new Error(`ZIP file is too large after extraction: ${path}. Keep each file under ${Math.round(BUNDLE_MAX_FILE_BYTES/1_000_000)} MB.`);
    if(total>BUNDLE_MAX_TOTAL_BYTES)throw new Error(`The extracted ZIP exceeds the ${Math.round(BUNDLE_MAX_TOTAL_BYTES/1_000_000)} MB saved-page limit.`);
    if(method!==0&&method!==8)throw new Error(`Unsupported ZIP compression method for ${path}. Re-save the archive using standard Deflate compression.`);
    records.push({path,method,compressed,size,offset});
  }
  if(!records.length)throw new Error('The ZIP does not contain any files.');
  const firstSegments=records.map(r=>r.path.split('/')[0]),common=firstSegments.every(x=>x===firstSegments[0])&&records.every(r=>r.path.includes('/'))?firstSegments[0]+'/':'';
  const out:ExtractedZipFile[]=[];
  for(const record of records){
    if(record.offset+30>bytes.length||view.getUint32(record.offset,true)!==0x04034b50)throw new Error(`Invalid ZIP entry: ${record.path}`);
    const nameLen=view.getUint16(record.offset+26,true),extraLen=view.getUint16(record.offset+28,true),start=record.offset+30+nameLen+extraLen,end=start+record.compressed;
    if(end>bytes.length)throw new Error(`Truncated ZIP entry: ${record.path}`);
    const compressed=bytes.slice(start,end),content=record.method===0?compressed:await inflateRaw(compressed);
    if(content.byteLength!==record.size)throw new Error(`ZIP entry size mismatch: ${record.path}`);
    const path=common&&record.path.startsWith(common)?record.path.slice(common.length):record.path;
    out.push({path,file:new File([bufferPart(content)],path.split('/').pop()||'file',{type:mime(path),lastModified:file.lastModified})});
  }
  return out;
}


function pageSlug(name:string,index:number):string{
  const base=name.replace(/\.zip$/i,'').trim().toLowerCase().replace(/https?:\/\//g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return (base||`page-${index+1}`).slice(0,70);
}
function routeFromHtml(html:string,fallback:string):string{
  const candidates=[
    /<link\b[^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*\bhref=["']([^"']+)["']/i,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*canonical[^"']*["']/i,
    /<meta\b[^>]*\bproperty=["']og:url["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:url["']/i,
    /\bdata-sf-original-url=["']([^"']+)["']/i,
  ];
  for(const pattern of candidates){
    const raw=pattern.exec(html)?.[1];
    if(!raw)continue;
    try{const path=new URL(raw).pathname.replace(/\/+$/,'')||'/';if(path.startsWith('/'))return path;}catch{}
  }
  return /^(?:index|home|homepage|front-page)$/i.test(fallback)?'/':'/'+fallback;
}
export async function unzipSavedPages(archives:File[]):Promise<{files:ExtractedZipFile[];pages:Array<{file:string;route:string}>}>{
  if(archives.length<1||archives.length>12)throw new Error('Choose 1 to 12 saved-page ZIP files at once.');
  if(archives.some(file=>!file.name.toLowerCase().endsWith('.zip')))throw new Error('Every selected saved page must be a ZIP file.');
  const used=new Set<string>(),combined:ExtractedZipFile[]=[],pages:Array<{file:string;route:string}>=[],resources:Record<string,string>={};
  let originalUrl:string|undefined,total=0;
  for(const [index,archive] of archives.entries()){
    const extracted=await unzipSavedPage(archive),html=extracted.filter(item=>/\.html?$/i.test(item.path));
    if(html.length!==1)throw new Error(`${archive.name} contains ${html.length} HTML pages. Select one SingleFile page ZIP per website page.`);
    let slug=pageSlug(archive.name,index),suffix=2;while(used.has(slug))slug=`${pageSlug(archive.name,index)}-${suffix++}`;used.add(slug);
    const prefix=`saved-pages/${String(index+1).padStart(2,'0')}-${slug}/`;
    const pageItem=html[0],pageText=await pageItem.file.text();
    const route=routeFromHtml(pageText,slug);
    for(const item of extracted){
      if(item.path==='manifest.json'){
        try{
          const manifest=JSON.parse(await item.file.text());
          if(!originalUrl&&typeof manifest.originalUrl==='string')originalUrl=manifest.originalUrl;
          if(manifest.resources&&typeof manifest.resources==='object'&&!Array.isArray(manifest.resources)){
            for(const [path,url] of Object.entries(manifest.resources))if(typeof url==='string')resources[prefix+String(path).replace(/^\.\//,'')]=url;
          }
        }catch{}
      }
      const path=prefix+item.path;total+=item.file.size;
      if(total>BUNDLE_MAX_TOTAL_BYTES-100_000)throw new Error(`The combined extracted ZIPs exceed the ${Math.round(BUNDLE_MAX_TOTAL_BYTES/1_000_000)} MB saved-page limit.`);
      combined.push({path,file:new File([item.file],item.file.name,{type:item.file.type,lastModified:item.file.lastModified})});
    }
    pages.push({file:prefix+pageItem.path,route});
  }
  if(combined.length>BUNDLE_MAX_FILES-1)throw new Error(`The combined saved pages contain more than ${(BUNDLE_MAX_FILES-1).toLocaleString()} files before the manifest. Reduce the saved assets or split the reconstruction.`);
  const manifest=new File([JSON.stringify({...(originalUrl?{originalUrl}:{}),resources})],'manifest.json',{type:'application/json'});
  combined.push({path:'manifest.json',file:manifest});
  return {files:combined,pages};
}
