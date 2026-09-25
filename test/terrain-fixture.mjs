// Deterministic analytical elevation for offline renderer tests, not geography.
import {deflateSync} from 'node:zlib';
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const b of body)crc=crcTable[(crc^b)&255]^(crc>>>8);const length=Buffer.alloc(4),tail=Buffer.alloc(4);length.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,tail]);}
export function terrainFixture({z=10,x=0,y=0}={}){
 const rows=Buffer.alloc(256*(256*3+1));
 for(let py=0;py<256;py++)for(let px=0;px<256;px++){
  const lon=(x+px/256)/2**z*360-180,lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+py/256)/2**z)))*180/Math.PI;
  const u=(lon+80.145)/.07,v=(lat-25.783)/.065;
  const ridge=Math.exp(-(((v-.95+.18*Math.sin(u*3))/.32)**2)),west=Math.exp(-(((u+1.15+.14*Math.sin(v*5))/.3)**2));
  const rough=(Math.sin(u*52+v*39)+Math.cos(u*31-v*47))*.1;
  const metres=120+Math.max(0,2300*ridge*(1+rough)+1600*west*(1-rough));
  const value=Math.round((32768+metres)*256),offset=py*769+1+px*3;rows[offset]=value>>>16;rows[offset+1]=(value>>>8)&255;rows[offset+2]=value&255;
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(256,0);header.writeUInt32BE(256,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
