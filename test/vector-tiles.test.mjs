import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {request} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {parseVectorPath} from '../src/tile-path.js';
import {VECTOR_SQL,VECTOR_LAYERS,parseVectorLayers,makeVectorTiles,EMPTY_VECTOR} from '../src/postgis-vector.js';
import {staticFile,serve} from '../src/server.js';
import {Positions} from '../src/positions.js';
import {defaults} from '../src/config.js';
import {sunAt} from '../public/lib/game-style.mjs';
const quiet={info(){},error(){}};

test('MVT coordinate and layer boundaries reject traversal, unknown layers and invalid world coordinates',()=>{
  assert.deepEqual(parseVectorPath('/carto/16/300/500.mvt'),{z:16,x:300,y:500});
  for(const path of ['/carto/20/0/0.mvt','/carto/3/8/0.mvt','/carto/../../0.mvt','/carto/8/-1/0.mvt','/carto/8/1/2.svg'])assert.equal(parseVectorPath(path),null);
  assert.deepEqual(parseVectorLayers(null),VECTOR_LAYERS);assert.deepEqual(parseVectorLayers(''),[]);
  assert.deepEqual(parseVectorLayers('places,roads,places'),['roads','places']);
  for(const s of ['water,','ROADS','roads,<img>',{},'x'.repeat(101)])assert.equal(parseVectorLayers(s),null);
});
test('bounded query, gzip variants, coalescing, expiry, empty tile and recovery',async()=>{
  let count=0,time=0;const raw=Buffer.from([26,0]);
  const tiles=makeVectorTiles({now:()=>time,log:quiet,query:async(q)=>{count++;assert.equal(q.query_timeout,5000);assert.deepEqual(q.values,[16,1,2]);return {rows:[{source_layer:'roads',tile:raw}]};}});
  for(const args of [[7,1,2],[20,1,2],[16,-1,2],[16,65536,2],[16,1,2,[]],[16,1,2,['unknown']]])assert.equal(await tiles.tile(...args),EMPTY_VECTOR);
  assert.equal(count,0);
  const [a,b]=await Promise.all([tiles.tile(16,1,2),tiles.tile(16,1,2,['roads'])]);assert.equal(count,1);assert.deepEqual(a.raw,b.raw);assert.deepEqual(gunzipSync(a.gzip),raw);
  assert.equal(await tiles.tile(16,1,2,['water']),EMPTY_VECTOR);
  time=300001;await tiles.tile(16,1,2);assert.equal(count,2);
  let attempt=0;const recovery=makeVectorTiles({now:()=>time,log:quiet,query:async()=>{if(!attempt++)throw Object.assign(new Error(),{code:'42P01'});return {rows:[]};}});
  assert.equal(await recovery.tile(16,1,2),EMPTY_VECTOR);await recovery.tile(16,1,2);assert.equal(attempt,1);time+=60001;await recovery.tile(16,1,2);assert.equal(attempt,2);
  for(const budget of [350,500,400,1800,2400,150])assert.match(VECTOR_SQL,new RegExp('LIMIT '+budget+'\\b'));
  assert.equal((VECTOR_SQL.match(/way && buffered/g)||[]).length,8);
});
test('MVT endpoint authentication, gzip negotiation, MIME and empty caching',async()=>{
  const {server}=serve(new Positions(),{...defaults(),dashboardToken:'test-only',port:0,host:'127.0.0.1'},{log:quiet,geo:{vectorTile:async()=>EMPTY_VECTOR},vectorTiles:{enabled:false,tile:async()=>null}});
  await once(server,'listening');const port=server.address().port;
  const get=(path,headers={})=>new Promise((resolve,reject)=>{request({hostname:'127.0.0.1',port,path,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject).end();});
  try{
    assert.equal((await get('/carto/16/1/2.mvt')).status,401);
    const headers={cookie:'livegeo=test-only','accept-encoding':'gzip'};
    // Query token exercises the same gate and cookie exchange as the SVG route.
    const got=await get('/carto/16/1/2.mvt?token=test-only',headers);assert.equal(got.status,200);assert.equal(got.headers['content-type'],'application/vnd.mapbox-vector-tile');assert.equal(got.headers['content-encoding'],'gzip');assert.equal(got.headers.vary,'Accept-Encoding');assert.equal(got.headers['cache-control'],'private, max-age=30');assert.equal(gunzipSync(got.body).length,0);
    assert.equal((await get('/carto/16/1/2.mvt?token=test-only&layers=bad')).status,400);
    assert.equal((await get('/carto/16/1/2.mvt?token=test-only',{'accept-encoding':'gzip;q=0'})).headers['content-encoding'],undefined);
    assert.equal((await get('/carto/16/1/2.mvt?token=test-only',{'accept-encoding':'gzip;q=0.8'})).headers['content-encoding'],'gzip');
    assert.equal(new VectorTile(new Pbf(EMPTY_VECTOR.raw)).layers.constructor,Object);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('new static resources have correct types and remain confined to public',()=>{
  for(const [ext,type] of [['mjs','text/javascript'],['pbf','application/x-protobuf'],['woff2','font/woff2'],['json','application/json'],['wasm','application/wasm']])assert.ok(staticFile('/vendor/a.'+ext).type.startsWith(type));
  assert.equal(staticFile('/%2e%2e/package.json'),null);assert.equal(staticFile('/vendor/file.exe'),null);
});
test('sun phases follow location and date, including both hemispheres',()=>{
  assert.equal(sunAt(0,0,new Date('2026-03-20T12:00:00Z')).phase,'day');
  assert.equal(sunAt(0,0,new Date('2026-03-20T00:00:00Z')).phase,'night');
  assert.ok(sunAt(60,0,new Date('2026-06-21T12:00:00Z')).elevation>sunAt(60,0,new Date('2026-12-21T12:00:00Z')).elevation);
  assert.ok(sunAt(-60,0,new Date('2026-06-21T12:00:00Z')).elevation<sunAt(-60,0,new Date('2026-12-21T12:00:00Z')).elevation);
});
test('committed glyphs include Persian joined presentation forms',async()=>{
  const bytes=await readFile('public/vendor/fonts/glyphs/LiveGeo/65024-65279.pbf');
  const reader=new Pbf(bytes);const ids=[];
  reader.readFields((tag,result,p)=>{if(tag===1)p.readMessage((field,obj,r)=>{if(field===3)r.readMessage((f,g,q)=>{if(f===1)ids.push(q.readVarint());},{});},{});},{});
  assert.ok(ids.includes(0xfee3),'meem initial');assert.ok(ids.includes(0xfeb7),'sheen initial');assert.ok(ids.includes(0xfeae),'reh final');
});
