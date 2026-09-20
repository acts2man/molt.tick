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
  if(file.size>50_000_000)throw new Error('Use a ZIP smaller than 50 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer()),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let eocd=-1;for(let i=Math.max(0,bytes.length-65_557);i<=bytes.length-22;i++)if(view.getUint32(i,true)===0x06054b50)eocd=i;
  if(eocd<0)throw new Error('This ZIP is missing its directory record or is not a standard ZIP archive.');
  const entries=view.getUint16(eocd+10,true),centralOffset=view.getUint32(eocd+16,true);
  if(entries===0xffff||centralOffset===0xffffffff)throw new Error('ZIP64 archives are not supported yet. Re-save this page as a normal ZIP.');
  if(entries<1||entries>300)throw new Error('Use a ZIP containing 1 to 300 files.');
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
    if(size>4_000_000)throw new Error(`ZIP file is too large after extraction: ${path}. Keep each file under 4 MB.`);
    if(total>49_900_000)throw new Error('The extracted ZIP exceeds the 50 MB saved-page limit.');
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
