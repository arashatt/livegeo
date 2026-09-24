// Deterministic demo-density measurements, never production location data.
import {demoFeatures} from './game-demo.mjs';
import {makeVectorTiles} from '../src/postgis-vector.js';
export async function benchmarkVectorTiles(db){
  await db.query('TRUNCATE planet_osm_polygon, planet_osm_line, planet_osm_point');
  const data=demoFeatures();
  const polygons=['landuse','water','parks','buildings'].flatMap((key)=>data[key].map((f)=>({...f,kind:key})));
  await db.query(`WITH input AS (SELECT value AS f FROM jsonb_array_elements($1::jsonb)),
    geom AS (SELECT f, ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text),4326),3857) AS way FROM input)
    INSERT INTO planet_osm_polygon (osm_id,way,way_area,"natural",landuse,leisure,building,name,tags)
    SELECT row_number() OVER (),way,ST_Area(way),CASE WHEN f->>'kind'='water' THEN 'water' END,
      CASE WHEN f->>'kind'='landuse' THEN 'residential' END,CASE WHEN f->>'kind'='parks' THEN 'park' END,
      CASE WHEN f->>'kind'='buildings' THEN 'apartments' END,f->'properties'->>'name',hstore('height',f->'properties'->>'height') FROM geom`,[JSON.stringify(polygons)]);
  await db.query(`WITH input AS (SELECT value AS f FROM jsonb_array_elements($1::jsonb))
    INSERT INTO planet_osm_line(osm_id,way,name,highway,railway,bridge,tunnel,layer,tags)
    SELECT row_number() OVER (),ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text),4326),3857),f->'properties'->>'name',
      CASE WHEN f->>'kind'='roads' THEN f->'properties'->>'class' END,CASE WHEN f->>'kind'='rail' THEN 'rail' END,
      CASE WHEN f->'properties'->>'bridge'='1' THEN 'yes' ELSE 'no' END,'no',0,''::hstore FROM input`,[JSON.stringify(['roads','rail'].flatMap(k=>data[k].map(f=>({...f,kind:k}))))]);
  await db.query(`INSERT INTO planet_osm_point(osm_id,way,name,place,tags)
    SELECT row_number() OVER (),ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON((value->'geometry')::text),4326),3857),value->'properties'->>'name',value->'properties'->>'class',''::hstore FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(data.places)]);
  const tileOf=(z,lon,lat)=>({z,x:Math.floor((lon+180)/360*2**z),y:Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**z)});
  const renderer=makeVectorTiles({query:(...args)=>db.query(...args)}),result={};
  for(const z of [12,16]){
    const nw=tileOf(z,-80.17,25.805),se=tileOf(z,-80.126,25.761),sizes=[];
    for(let x=nw.x;x<=se.x;x++)for(let y=nw.y;y<=se.y;y++)sizes.push((await renderer.tile(z,x,y)).gzip.length);
    sizes.sort((a,b)=>a-b);result['z'+z]={tiles:sizes.length,p95GzipBytes:sizes[Math.ceil(sizes.length*.95)-1],maxGzipBytes:sizes.at(-1)};
  }
  console.log('DEMO_MVT_METRICS '+JSON.stringify(result));return result;
}
