// Same-origin elevation delivery. Only bounded XYZ coordinates can select a
// tile; the upstream is deployment configuration, never a caller-provided URL.
import {mkdir,readFile,writeFile,rename,stat,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tileUrl} from './tile-path.js';
export const TERRAIN_UPSTREAM='https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_MAX_ZOOM=12;
const MAX_BYTES=1024*1024,MONTH=30*86400,PNG=Buffer.from([137,80,78,71,13,10,26,10]);
export function validTerrainPng(bytes){
 return bytes.length>=33&&bytes.length<=MAX_BYTES&&bytes.subarray(0,8).equals(PNG)&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)===256&&bytes.readUInt32BE(20)===256&&bytes[24]===8&&[2,6].includes(bytes[25]);
}
export function makeTerrainTiles({cacheDir,upstream=TERRAIN_UPSTREAM,maxAge=MONTH,userAgent='livegeo/1.0',fetchImpl=fetch,now=Date.now,log=console}={}){
 const enabled=Boolean(upstream)&&upstream!=='off',pending=new Map(),memory=new Map(),retry=new Map();let writes=0,pruning=false;
 const valid=t=>t&&[t.z,t.x,t.y].every(Number.isInteger)&&t.z>=0&&t.z<=TERRAIN_MAX_ZOOM&&t.x>=0&&t.y>=0&&t.x<2**t.z&&t.y<2**t.z;
 const keyOf=t=>`${t.z}-${t.x}-${t.y}`;
 async function cached(key){
  if(memory.has(key))return memory.get(key);
  try{const file=join(cacheDir,key+'.png'),s=await stat(file);if(s.size>MAX_BYTES)return null;const bytes=await readFile(file);return validTerrainPng(bytes)?{bytes,at:s.mtimeMs}:null;}catch{return null;}
 }
 function keep(key,hit){if(memory.size>=64)memory.delete(memory.keys().next().value);memory.set(key,hit);}
 async function prune(){
  if(pruning||!cacheDir)return;pruning=true;
  try{
   const files=(await readdir(cacheDir)).filter(n=>/^\d+-\d+-\d+\.png$/.test(n));
   const entries=await Promise.all(files.map(async name=>{try{return {name,...await stat(join(cacheDir,name))};}catch{return null;}}));
   const all=entries.filter(Boolean).sort((a,b)=>a.mtimeMs-b.mtimeMs);let size=all.reduce((n,f)=>n+f.size,0),count=all.length;
   for(const f of all){if(size<=128*1024*1024&&count<=768)break;await unlink(join(cacheDir,f.name)).catch(()=>{});size-=f.size;count--;}
  }catch{}finally{pruning=false;}
 }
 async function get(tile){
  if(!enabled||!valid(tile))return null;
  const key=keyOf(tile);if(pending.has(key))return pending.get(key);
  if(pending.size>=24)return null;
  const task=(async()=>{
   const hit=await cached(key);if(hit&&now()-hit.at<maxAge*1000){keep(key,hit);return {bytes:hit.bytes,from:'cache'};}
   if((retry.get(key)||0)>now())return hit?{bytes:hit.bytes,from:'stale'}:null;
   try{
    const r=await fetchImpl(tileUrl(upstream,tile),{headers:{'user-agent':userAgent},signal:AbortSignal.timeout(8000),redirect:'error'});
    if(!r.ok)throw new Error('upstream '+r.status);
    if(Number(r.headers.get('content-length'))>MAX_BYTES)throw new Error('tile too large');
    const chunks=[];let size=0;
    for await(const chunk of r.body){size+=chunk.length;if(size>MAX_BYTES)throw new Error('tile too large');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);if(!validTerrainPng(bytes))throw new Error('invalid 256px elevation PNG');
    keep(key,{bytes,at:now()});retry.delete(key);
    if(cacheDir)try{await mkdir(cacheDir,{recursive:true});const file=join(cacheDir,key+'.png'),temp=file+'.tmp';await writeFile(temp,bytes);await rename(temp,file);if(writes++%32===0)void prune();}catch(e){log.error('terrain: cache write failed —',e.message);}
    return {bytes,from:'upstream'};
   }catch(e){
    if(retry.size>=256)retry.delete(retry.keys().next().value);retry.set(key,now()+60000);
    log.error('terrain: unavailable —',e.message);return hit?{bytes:hit.bytes,from:'stale'}:null;
   }
  })().finally(()=>pending.delete(key));pending.set(key,task);return task;
 }
 return {enabled,get};
}
