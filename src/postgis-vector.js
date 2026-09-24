// Bounded, same-origin MVTs from the optional osm2pgsql import.
import { gzipSync } from 'node:zlib';
export const VECTOR_LAYERS = Object.freeze(['landuse', 'parks', 'water', 'buildings', 'rail', 'roads', 'places']);
export function parseVectorLayers(value) {
  if (value == null) return [...VECTOR_LAYERS];
  if (value === '') return [];
  if (typeof value !== 'string' || value.length > 100) return null;
  const names = value.split(',');
  return names.some((n) => !VECTOR_LAYERS.includes(n)) ? null : VECTOR_LAYERS.filter((n) => names.includes(n));
}
// Every arm uses the spatial index, a zoom threshold and its own hard budget.
// Names remain protobuf strings, never HTML. Numeric tags are validated before
// casting; plausible, bounded defaults express illustrative (not surveyed) height.
export const VECTOR_SQL = `
WITH tile AS (SELECT ST_TileEnvelope($1,$2,$3) AS geom),
bounds AS (SELECT geom, ST_Expand(geom,(ST_XMax(geom)-ST_XMin(geom))*12/256) AS buffered,
  (ST_XMax(geom)-ST_XMin(geom))/256 AS pixel FROM tile),
features AS (
 (SELECT 'landuse' AS source_layer, CASE WHEN "natural" IN ('bare_rock','scree','shingle','sand') THEN 'terrain' ELSE 'urban' END AS class,
    way, 3 AS dimension, name, tags, NULL::text AS building, NULL::text AS bridge, NULL::text AS tunnel, NULL::text AS level
  FROM planet_osm_polygon,bounds WHERE $1>=10 AND way && buffered AND way_area>pixel*pixel*4
    AND (landuse IN ('residential','commercial','industrial','retail') OR "natural" IN ('bare_rock','scree','shingle','sand'))
  ORDER BY way_area DESC,osm_id LIMIT 350)
 UNION ALL
 (SELECT 'parks','park',way,3,name,tags,NULL,NULL,NULL,NULL FROM planet_osm_polygon,bounds
  WHERE way && buffered AND way_area>pixel*pixel*4 AND (leisure IN ('park','garden','nature_reserve','golf_course')
    OR landuse IN ('forest','grass','meadow','recreation_ground','village_green') OR "natural" IN ('wood','scrub','heath'))
  ORDER BY way_area DESC,osm_id LIMIT 500)
 UNION ALL
 (SELECT 'water','area',way,3,name,tags,NULL,NULL,NULL,NULL FROM planet_osm_polygon,bounds
  WHERE way && buffered AND way_area>pixel*pixel*2 AND ("natural"='water' OR landuse IN ('reservoir','basin') OR waterway='riverbank')
  ORDER BY way_area DESC,osm_id LIMIT 400)
 UNION ALL
 (SELECT 'water',waterway,way,2,name,tags,NULL,NULL,NULL,NULL FROM planet_osm_line,bounds
  WHERE $1>=11 AND way && buffered AND (waterway IN ('river','canal') OR ($1>=14 AND waterway IN ('stream','drain')))
  ORDER BY osm_id LIMIT 500)
 UNION ALL
 (SELECT 'buildings',building,way,3,name,tags,building,NULL,NULL,NULL FROM planet_osm_polygon,bounds
  WHERE $1>=15 AND way && buffered AND building IS NOT NULL AND building<>'no'
  ORDER BY way_area DESC,osm_id LIMIT 1800)
 UNION ALL
 (SELECT 'rail',railway,way,2,name,tags,NULL,bridge,tunnel,layer::text FROM planet_osm_line,bounds
  WHERE $1>=11 AND way && buffered AND railway IN ('rail','light_rail','tram') ORDER BY osm_id LIMIT 400)
 UNION ALL
 (SELECT 'roads',highway,way,2,name,tags,NULL,bridge,tunnel,layer::text FROM planet_osm_line,bounds
  WHERE way && buffered AND (highway IN ('motorway','motorway_link','trunk','trunk_link')
    OR ($1>=10 AND highway IN ('primary','primary_link','secondary','secondary_link'))
    OR ($1>=12 AND highway IN ('tertiary','tertiary_link','residential','unclassified','living_street'))
    OR ($1>=14 AND highway='service') OR ($1>=15 AND highway IN ('pedestrian','track','path','footway','cycleway','steps')))
  ORDER BY CASE WHEN highway IN ('motorway','motorway_link','trunk','trunk_link') THEN 0
    WHEN highway IN ('primary','primary_link') THEN 1 WHEN highway IN ('secondary','secondary_link') THEN 2 ELSE 3 END,osm_id LIMIT 2400)
 UNION ALL
 (SELECT 'places',place,way,1,name,tags,NULL,NULL,NULL,NULL FROM planet_osm_point,bounds
  WHERE way && buffered AND name IS NOT NULL AND (place IN ('city','town') OR ($1>=11 AND place IN ('village','suburb','quarter'))
    OR ($1>=14 AND place IN ('neighbourhood','hamlet','locality')))
  ORDER BY CASE place WHEN 'city' THEN 0 WHEN 'town' THEN 1 ELSE 2 END,osm_id LIMIT 150)
), clipped AS (
 SELECT source_layer,class,left(name,160) AS name,
   CASE WHEN coalesce(bridge,'no') NOT IN ('no','0','false') THEN 1 ELSE 0 END AS bridge,
   CASE WHEN coalesce(tunnel,'no') NOT IN ('no','0','false') THEN 1 ELSE 0 END AS tunnel,
   CASE WHEN level ~ '^-?[0-9]{1,2}$' THEN level::int ELSE 0 END AS layer,
   CASE WHEN source_layer='buildings' THEN least(350,greatest(3,
     CASE WHEN tags->'height' ~ '^[0-9]{1,3}(\\.[0-9]{1,2})?( m)?$' THEN replace(tags->'height',' m','')::float
       WHEN tags->'building:levels' ~ '^[0-9]{1,2}(\\.[0-9])?$' THEN (tags->'building:levels')::float*3
       WHEN building IN ('apartments','hotel') THEN 21 WHEN building IN ('commercial','office') THEN 30
       WHEN building IN ('industrial','warehouse','retail') THEN 9 WHEN building IN ('garage','garages','shed') THEN 3 ELSE 6 END)) ELSE 0 END AS height,
   ST_CollectionExtract(ST_AsMVTGeom(way,bounds.geom,4096,192,true),dimension) AS geom
 FROM features,bounds
), valid AS (SELECT * FROM clipped WHERE NOT ST_IsEmpty(geom))
SELECT source_layer, ST_AsMVT(t,source_layer,4096,'geom') AS tile FROM
 (SELECT * FROM valid) t GROUP BY source_layer`;
export const EMPTY_VECTOR = Object.freeze({ raw: Buffer.alloc(0), gzip: gzipSync(Buffer.alloc(0)), empty: true });
export function makeVectorTiles({ query, log = console, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  let retryAfter = 0;
  return {
    async tile(z,x,y,layers=VECTOR_LAYERS) {
      if (![z,x,y].every(Number.isInteger) || z<8 || z>19 || x<0 || y<0 || x>=2**z || y>=2**z
          || !Array.isArray(layers) || layers.some((n)=>!VECTOR_LAYERS.includes(n)) || !layers.length || now()<retryAfter) return EMPTY_VECTOR;
      const key = `${z}/${x}/${y}`;
      let hit = cache.get(key);
      try {
        if (!hit || hit.until<=now()) {
          if (!pending.has(key)) pending.set(key, Promise.resolve().then(()=>query({text:VECTOR_SQL,values:[z,x,y],query_timeout:5000}))
            .then(({rows})=>{
              const found = { rows, variants:new Map(), until:now()+(rows.length?300000:30000) };
              if (cache.size>=128) cache.delete(cache.keys().next().value);
              cache.set(key,found); return found;
            }).finally(()=>pending.delete(key)));
          hit=await pending.get(key);
        }
        const names=VECTOR_LAYERS.filter((n)=>layers.includes(n)), variant=names.join(',');
        if (hit.variants.has(variant)) return hit.variants.get(variant);
        const raw=Buffer.concat(names.flatMap((n)=>hit.rows.filter((r)=>r.source_layer===n).map((r)=>r.tile)));
        // Bounded variants as well as bounded geometry/cache. Do not retain all 128 combinations.
        const result=raw.length?{raw,gzip:gzipSync(raw),empty:false}:EMPTY_VECTOR;
        if(hit.variants.size>=2) hit.variants.delete(hit.variants.keys().next().value);
        hit.variants.set(variant,result); return result;
      } catch(error) {
        retryAfter=now()+(error?.code==='42P01'?60000:5000);
        log.error('geo: cannot render vector cartography —',error?.message||error);
        return EMPTY_VECTOR;
      }
    },
  };
}
