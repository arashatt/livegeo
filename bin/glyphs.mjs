// npm ci; npm run glyphs — pinned font-maker CLI, then a deterministic font stack.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scratch=join(tmpdir(),'livegeo-glyphs');
await rm(scratch,{recursive:true,force:true});
execFileSync(process.execPath,['node_modules/@sakitam-gis/font-maker-cli/dist/index.js','convert',
  'public/vendor/fonts/BarlowCondensed-SemiBold.ttf','public/vendor/fonts/Vazirmatn-Regular.ttf','-o',scratch,'-j','2'],{stdio:'inherit'});
function fields(bytes){
  let pos=0;const out=[];
  const varint=()=>{let n=0,k=0,b;do{b=bytes[pos++];n+=(b&127)*2**k;k+=7;}while(b&128);return n;};
  while(pos<bytes.length){const start=pos,tag=varint(),wire=tag&7;let value;
    if(wire===2){const size=varint();value=bytes.subarray(pos,pos+size);pos+=size;}
    else if(wire===0)value=varint();else throw new Error('Unexpected glyph protobuf wire type');
    out.push({tag:tag>>3,value,raw:bytes.subarray(start,pos)});
  }return out;
}
function v(n){const b=[];do{const a=n&127;n=Math.floor(n/128);b.push(a|(n?128:0));}while(n);return Buffer.from(b);}
function message(tag,bytes){return Buffer.concat([v(tag*8+2),v(bytes.length),bytes]);}
await mkdir('public/vendor/fonts/glyphs/LiveGeo',{recursive:true});
for(let range=0;range<65536;range+=256){
  const name=`${range}-${range+255}`,glyphs=new Map();
  for(const font of ['Barlow Condensed SemiBold','Vazirmatn Regular']){
    const bytes=await readFile(join(scratch,font,name+'.pbf'));
    for(const stack of fields(bytes).filter((f)=>f.tag===1))for(const g of fields(stack.value).filter((f)=>f.tag===3)){
      const id=fields(g.value).find((f)=>f.tag===1).value;if(!glyphs.has(id))glyphs.set(id,g.raw);
    }
  }
  const stack=Buffer.concat([message(1,Buffer.from('LiveGeo')),message(2,Buffer.from(name)),...glyphs.values()]);
  await writeFile(`public/vendor/fonts/glyphs/LiveGeo/${name}.pbf`,message(1,stack));
}
await rm(scratch,{recursive:true,force:true});
console.log('LiveGeo: 256 ranges; Barlow Latin with Vazirmatn Persian/Arabic fallback.');
