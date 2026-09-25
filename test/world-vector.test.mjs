import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {encodeTile} from './mvt-encode.mjs';
import {makeWorldVector,WORLD_BUDGET} from '../src/world-vector.js';
import {EMPTY_VECTOR} from '../src/postgis-vector.js';
import {serve} from '../src/server.js';
import {Positions} from '../src/positions.js';
import {defaults} from '../src/config.js';
const quiet={info(){},error(){}};
const road=(properties={},y=700)=>({type:2,properties:{class:'primary',name:'Main Street',...properties},lines:[[[100,y],[1900,y]]]});
const square=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n]];
const polygon=(properties,rings=[square(200,200,1800,1800)])=>({type:3,properties,rings});
const point=(properties)=>({type:1,properties,points:[[900,900]]});
const pack=layers=>encodeTile(Object.fromEntries(Object.entries(layers).map(([k,features])=>[k,{extent:4096,features}])));
const bytes=pack({
 transportation:[road({brunnel:'bridge',layer:1}),road({class:'rail'},1200)],
 transportation_name:[road({name:'مشهد <img src=x>'})],
 building:[polygon({render_height:45})],
 landcover:[polygon({class:'wood'}),polygon({class:'farmland'})],
 water:[polygon({class:'lake'},[square(100,100,1900,1900),square(700,700,1300,1300).reverse()])],
 place:[point({name:'Bay District',class:'suburb',rank:3})],
 poi:[point({class:'hospital',name:'Clinic'})],
});
const decoded=result=>new VectorTile(new Pbf(result.raw));

test('world adapter keeps geometry, holes, heights, road labels and POIs through overzoom',async()=>{
 const calls=[],world=makeWorldVector({log:quiet,upstream:{tile:async t=>{calls.push(t);return {bytes};}}});
 const [a,b]=await Promise.all([world.tile(15,8000,12000),world.tile(15,8000,12000,['roads'])]);
 assert.equal(calls.length,1);assert.deepEqual(calls[0],{z:14,x:4000,y:6000});assert.equal(a.source,'upstream');assert.deepEqual(gunzipSync(a.gzip),a.raw);
 const layers=decoded(a).layers;assert.deepEqual(Object.keys(decoded(b).layers),['roads']);
 assert.equal(layers.buildings.feature(0).properties.height,45);
 assert.equal(layers.water.feature(0).loadGeometry().length,2,'lake keeps its hole');
 assert.equal(layers.roads.feature(0).properties.bridge,1);assert.equal(layers.roads.feature(1).properties.label_only,1);
 assert.equal(layers.roads.feature(1).properties.name,'مشهد <img src=x>','label remains data');
 assert.ok(Math.abs(layers.roads.feature(0).loadGeometry()[0][0].x-200)<=1,'parent coordinates scale into the child');
 assert.equal(layers.parks.feature(0).properties.class,'wood');assert.equal(layers.landuse.feature(0).properties.class,'field');
 assert.equal(layers.places.feature(1).properties.kind,'landmark');assert.equal(layers.places.feature(1).properties.class,'hospital');
 assert.equal(await world.tile(15,8001,12001),EMPTY_VECTOR,'disjoint child stays empty');
 assert.equal(calls.length,1,'overzoomed children share a decoded parent');
});

test('world adapter applies zoom gates, requested layers, budgets, name limits and expiry',async()=>{
 let calls=0,time=0;const crowded=pack({transportation:Array.from({length:2500},(_,i)=>road({class:i===2499?'motorway':'minor',name:'x'.repeat(200)},i%850+100)),building:[polygon({render_height:900})],poi:[point({class:'hospital',name:'Clinic'})]});
 const world=makeWorldVector({now:()=>time,log:quiet,upstream:{tile:async()=>{calls++;return {bytes:crowded};}}});
 for(const args of [[7,0,0],[20,0,0],[8,-1,0],[8,256,0],[8,1,1,['bad']],[8,1,1,[]]])assert.equal(await world.tile(...args),EMPTY_VECTOR);
 assert.equal(calls,0);
 const far=decoded(await world.tile(12,1000,1500));assert.equal(far.layers.buildings,undefined);assert.equal(far.layers.places.feature(0).properties.kind,'landmark');
 const near=decoded(await world.tile(16,16000,24000));assert.ok(near.layers.roads.length<=WORLD_BUDGET.roads);assert.equal(near.layers.roads.feature(0).properties.class,'motorway');assert.equal(near.layers.roads.feature(0).properties.name.length,160);assert.equal(near.layers.buildings.feature(0).properties.height,350);
 await world.tile(16,16000,24000,['roads']);assert.equal(calls,2);time=300001;await world.tile(16,16000,24000);assert.equal(calls,3);
});

test('world adapter backs off corrupt or oversized tiles, recovers, and honors upstream off',async()=>{
 let tries=0,time=0;const world=makeWorldVector({now:()=>time,log:quiet,upstream:{tile:async()=>{tries++;return {bytes:tries===1?Buffer.alloc(8*1024*1024+1):bytes};}}});
 assert.equal(await world.tile(15,8000,12000),EMPTY_VECTOR);assert.equal(await world.tile(15,8001,12001),EMPTY_VECTOR);assert.equal(tries,1);
 time=30001;assert.equal((await world.tile(15,8000,12000)).empty,false);assert.equal(tries,2);
 assert.equal(await makeWorldVector({upstream:{enabled:false,tile(){throw new Error('must not fetch');}}}).tile(14,4000,6000),EMPTY_VECTOR);
 const bad=makeWorldVector({log:quiet,upstream:{tile:async()=>({bytes:Buffer.from([255,255])})}});assert.equal(await bad.tile(14,4000,6000),EMPTY_VECTOR);
});

test('HTTP fallback is authenticated, marks its source, and lets local geometry win',async()=>{
 let calls=0,local=EMPTY_VECTOR;
 const {server}=serve(new Positions(),{...defaults(),dashboardToken:'fixture',port:0,host:'127.0.0.1'},{log:quiet,geo:{vectorTile:async()=>local},vectorTiles:{tile:async()=>{calls++;return {bytes};}}});
 await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 const get=path=>fetch(origin+path);
 try{
  assert.equal((await get('/carto/15/8000/12000.mvt')).status,401);assert.equal(calls,0);
  assert.equal((await get('/carto/15/8000/12000.mvt?token=fixture&layers=nope')).status,400);assert.equal(calls,0);
  let r=await get('/carto/15/8000/12000.mvt?token=fixture');assert.equal(r.headers.get('x-carto-source'),'upstream');assert.ok(decoded({raw:new Uint8Array(await r.arrayBuffer())}).layers.roads);assert.equal(calls,1);
  local={raw:bytes,gzip:Buffer.alloc(0),empty:false};r=await get('/carto/15/8002/12002.mvt?token=fixture');assert.equal(r.headers.get('x-carto-source'),'postgis');assert.equal(calls,1);
  r=await get('/lib/map-assets/maplibre/maplibre-gl.css');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-cache');assert.ok(r.headers.get('etag'));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
