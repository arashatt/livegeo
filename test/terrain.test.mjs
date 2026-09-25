import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeTerrainTiles,validTerrainPng} from '../src/terrain-tiles.js';
import {parseTerrainPath} from '../src/tile-path.js';
import {terrainFixture} from './terrain-fixture.mjs';
import {serve,staticFile} from '../src/server.js';
import {Positions} from '../src/positions.js';
import {defaults} from '../src/config.js';
import {COOKIE} from '../src/token.js';
const quiet={info(){},error(){}},tile={z:10,x:284,y:436},png=terrainFixture(tile);

test('terrain paths and PNG bounds reject invalid coordinates and non-elevation payloads',()=>{
 assert.deepEqual(parseTerrainPath('/relief/10/284/436.png'),tile);
 for(const p of ['/relief/13/0/0.png','/relief/3/8/0.png','/relief/3/-1/0.png','/relief/../../file.png','/relief/3/0/0.jpg'])assert.equal(parseTerrainPath(p),null);
 assert.equal(validTerrainPng(png),true);assert.equal(validTerrainPng(Buffer.from('<html>')),false);assert.equal(validTerrainPng(Buffer.alloc(1024*1024+1)),false);
 const wide=Buffer.from(png);wide.writeUInt32BE(65536,16);assert.equal(validTerrainPng(wide),false);
 assert.match(staticFile('/lib/terrain-credits.html').type,/text\/html/);
});

test('terrain requests coalesce, persist, back off and serve stale data when the source fails',async()=>{
 let calls=0,time=Date.now(),fail=false;const cacheDir=await mkdtemp(join(tmpdir(),'livegeo-terrain-'));
 const fetchImpl=async(url,opts)=>{calls++;assert.match(url,/\/10\/284\/436\.png$/);assert.equal(opts.redirect,'error');assert.ok(opts.signal);if(fail)throw new Error('offline');return new Response(png, {headers:{'content-type':'image/png'}});};
 try{
  const source=makeTerrainTiles({cacheDir,fetchImpl,log:quiet,now:()=>time,maxAge:1});
  const [a,b]=await Promise.all([source.get(tile),source.get(tile)]);assert.equal(calls,1);assert.deepEqual(a.bytes,png);assert.equal(a,b);
  assert.equal((await source.get(tile)).from,'cache');
  const again=makeTerrainTiles({cacheDir,fetchImpl,log:quiet,now:()=>time,maxAge:1});assert.equal((await again.get(tile)).from,'cache');assert.equal(calls,1);
  time+=2000;fail=true;assert.equal((await source.get(tile)).from,'stale');assert.equal(calls,2);assert.equal((await source.get(tile)).from,'stale');assert.equal(calls,2);
  time+=61000;fail=false;assert.equal((await source.get(tile)).from,'upstream');assert.equal(calls,3);
 }finally{await rm(cacheDir,{recursive:true,force:true});}
});

test('disabled, corrupt and oversized terrain sources cannot supply fabricated elevation',async()=>{
 const off=makeTerrainTiles({upstream:'off',fetchImpl:()=>assert.fail('off source fetched')});assert.equal(off.enabled,false);assert.equal(await off.get(tile),null);
 for(const response of [new Response('<html>no tile</html>'),new Response(png,{headers:{'content-length':String(2*1024*1024)}}),new Response(Buffer.alloc(1024*1024+1))]){
  let calls=0;const source=makeTerrainTiles({log:quiet,fetchImpl:async()=>{calls++;return response;}});assert.equal(await source.get(tile),null);assert.equal(await source.get(tile),null);assert.equal(calls,1);
 }
});

test('terrain HTTP and availability share the dashboard gate and correct caching',async()=>{
 let calls=0,available=true;
 const {server}=serve(new Positions(),{...defaults(),dashboardToken:'fixture',port:0,host:'127.0.0.1'},{log:quiet,terrainTiles:{enabled:true,get:async()=>{calls++;return available?{bytes:png,from:'cache'}:null;}}});
 await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 const get=(path,auth=true)=>fetch(origin+path,{headers:auth?{cookie:COOKIE+'=fixture'}:{}});
 try{
  assert.equal((await get('/relief/10/284/436.png',false)).status,401);assert.equal(calls,0);
  assert.equal((await get('/api/map-config',false)).status,401);assert.deepEqual(await (await get('/api/map-config')).json(),{relief:true});
  let r=await get('/relief/10/284/436.png');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.match(r.headers.get('cache-control'),/private, max-age=2592000/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
  assert.equal((await get('/relief/13/0/0.png')).status,404);assert.equal(calls,1);
  available=false;r=await get('/relief/10/284/436.png');assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'60');
  r=await get('/lib/terrain-credits.html',false);assert.equal(r.status,200);assert.match(await r.text(),/U.S. Geological Survey/);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
