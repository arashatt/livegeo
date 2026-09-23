// vector.js — the game map's streets, buildings and names, as vector tiles.
//
// The 3D map draws from Mapbox Vector Tiles in the OpenMapTiles schema: the
// same layer and field names whichever of two places a tile came from.
//
//   1. PostGIS, where an osm2pgsql extract has been imported. The query below
//      turns planet_osm_* into the subset of OpenMapTiles the map uses.
//   2. Otherwise an upstream, proxied and cached on disk the way raster tiles
//      are (tiles.js): OpenFreeMap by default, which is free, keyless and
//      covers the planet. VECTOR_UPSTREAM=off turns it off.
//
// Either way the browser only ever talks to this service. That is the rule
// for everything the pages load, on networks that filter third parties.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tileUrl } from './tile-path.js';

// Deepest tile either source makes; the map draws deeper zooms from these.
export const VECTOR_MAX_ZOOM = 14;
// PostGIS is asked from here. Shallower tiles cover a country or more, which
// is a planet-sized query against planet_osm_*; the upstream has them cheaply.
export const VECTOR_PG_MIN_ZOOM = 8;

// Characters outside Latin script. A name made of them has a Latin line from
// name:en, when OSM has one; this is how OpenMapTiles splits them too.
const NONLATIN = `'[^\\u0020-\\u024F\\u1E00-\\u1EFF\\u2000-\\u206F]'`;

// Metres, from the tags when OSM has them, else a stable made-up height by
// building type: the same building gets the same height on every load. The
// map's legend says heights are illustrative where OSM has none.
function heightSql(tags) {
  const num = (expr) => `NULLIF(substring(${expr} from '^\\s*([0-9]+(?:\\.[0-9]+)?)'), '')::float`;
  const fallback = `CASE
      WHEN building IN ('house','detached','bungalow','garage','garages','shed','hut','roof','carport','cabin')
        THEN 3.5 + (abs(osm_id) % 3)
      WHEN building IN ('industrial','warehouse','retail','supermarket','hangar')
        THEN 6 + (abs(osm_id) % 4) * 1.5
      WHEN building IN ('apartments','office','commercial','hotel','hospital','university')
        THEN 12 + (abs(osm_id) % 6) * 3.2
      ELSE 5 + (abs(osm_id) % 4) * 3.2 END`;
  if (!tags) return { height: fallback, min: '0' };
  return {
    height: `LEAST(400, COALESCE(${num(`tags->'height'`)}, ${num(`tags->'building:levels'`)} * 3.2 + 1.5, ${fallback}))`,
    min: `LEAST(399, COALESCE(${num(`tags->'min_height'`)}, ${num(`tags->'building:min_level'`)} * 3.2, 0))`,
  };
}

// One query, one tile: a UNION of MVT layers, each with its own budget so a
// dense layer cannot starve another. $1..$3 are z, x, y; a tile is 512 px, so
// "pixel" below is 1/512 of the tile's width.
export function vectorSql({ tags = true } = {}) {
  const en = tags ? `tags->'name:en'` : 'NULL';
  const latin = `CASE WHEN name ~ ${NONLATIN} THEN ${en} ELSE name END`;
  const nonlatin = `CASE WHEN name ~ ${NONLATIN} THEN name END`;
  const h = heightSql(tags);
  const layer = (name, body) => `(SELECT COALESCE(ST_AsMVT(q, '${name}', 4096, 'geom'), ''::bytea) FROM (${body}) q WHERE q.geom IS NOT NULL)`;
  const geom = (dim) => `ST_CollectionExtract(ST_AsMVTGeom(way, bounds.geom, 4096, 64, true), ${dim}) AS geom`;
  return `
WITH tile AS (SELECT ST_TileEnvelope($1, $2, $3) AS geom),
bounds AS (
  SELECT geom, ST_Expand(geom, (ST_XMax(geom) - ST_XMin(geom)) * 64 / 4096) AS buffered,
         (ST_XMax(geom) - ST_XMin(geom)) / 512 AS pixel
  FROM tile
)
SELECT
${layer('water', `
  SELECT CASE WHEN waterway = 'riverbank' OR water = 'river' THEN 'river' ELSE 'lake' END AS class, ${geom(3)}
    FROM planet_osm_polygon, bounds
   WHERE way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 2
     AND ("natural" = 'water' OR landuse IN ('reservoir','basin') OR waterway = 'riverbank')
   ORDER BY way_area DESC, osm_id LIMIT 600`)}
|| ${layer('waterway', `
  SELECT waterway AS class, ${geom(2)}
    FROM planet_osm_line, bounds
   WHERE way && bounds.buffered
     AND (waterway IN ('river','canal') OR ($1 >= 12 AND waterway IN ('stream','drain','ditch')))
   ORDER BY osm_id LIMIT 800`)}
|| ${layer('landcover', `
  SELECT CASE WHEN "natural" IN ('wood') OR landuse = 'forest' THEN 'wood'
              WHEN "natural" IN ('sand','beach') THEN 'sand'
              WHEN "natural" IN ('bare_rock','scree','shingle') THEN 'rock'
              ELSE 'grass' END AS class, ${geom(3)}
    FROM planet_osm_polygon, bounds
   WHERE way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 4
     AND ("natural" IN ('wood','scrub','heath','grassland','sand','beach','bare_rock','scree','shingle')
          OR landuse IN ('forest','grass','meadow','village_green','farmland','orchard','vineyard'))
   ORDER BY way_area DESC, osm_id LIMIT 800`)}
|| ${layer('park', `
  SELECT COALESCE(leisure, 'park') AS class, ${geom(3)}
    FROM planet_osm_polygon, bounds
   WHERE way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 4
     AND (leisure IN ('park','garden','nature_reserve','golf_course','pitch','playground')
          OR landuse = 'recreation_ground')
   ORDER BY way_area DESC, osm_id LIMIT 600`)}
|| ${layer('landuse', `
  SELECT landuse AS class, ${geom(3)}
    FROM planet_osm_polygon, bounds
   WHERE $1 >= 9 AND way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 4
     AND landuse IN ('residential','commercial','industrial','retail','cemetery','railway','military')
   ORDER BY way_area DESC, osm_id LIMIT 600`)}
|| ${layer('building', `
  SELECT ${h.height} AS render_height, ${h.min} AS render_min_height, ${geom(3)}
    FROM planet_osm_polygon, bounds
   WHERE $1 >= 13 AND way && bounds.buffered AND building IS NOT NULL AND building <> 'no'
   ORDER BY way_area DESC, osm_id LIMIT (CASE WHEN $1 >= 14 THEN 9000 ELSE 3000 END)`)}
|| ${layer('transportation', `
  SELECT CASE
           WHEN highway IN ('motorway','motorway_link') THEN 'motorway'
           WHEN highway IN ('trunk','trunk_link') THEN 'trunk'
           WHEN highway IN ('primary','primary_link') THEN 'primary'
           WHEN highway IN ('secondary','secondary_link') THEN 'secondary'
           WHEN highway IN ('tertiary','tertiary_link') THEN 'tertiary'
           WHEN highway IN ('residential','unclassified','living_street','road') THEN 'minor'
           WHEN highway = 'service' THEN 'service'
           WHEN highway = 'track' THEN 'track'
           WHEN highway IN ('pedestrian','footway','path','cycleway','steps','bridleway') THEN 'path'
           WHEN railway IN ('rail','light_rail','narrow_gauge') THEN 'rail'
           WHEN railway IN ('tram','subway','monorail') THEN 'transit'
         END AS class,
         CASE WHEN highway LIKE '%\\_link' THEN 1 END AS ramp,
         CASE WHEN bridge IS NOT NULL AND bridge <> 'no' THEN 'bridge'
              WHEN tunnel IS NOT NULL AND tunnel <> 'no' THEN 'tunnel' END AS brunnel,
         ${geom(2)}
    FROM planet_osm_line, bounds
   WHERE way && bounds.buffered AND (
         highway IN ('motorway','motorway_link','trunk','trunk_link','primary','primary_link')
      OR ($1 >= 9 AND highway IN ('secondary','secondary_link'))
      OR ($1 >= 10 AND highway IN ('tertiary','tertiary_link'))
      OR ($1 >= 11 AND railway IN ('rail','light_rail','narrow_gauge','tram','subway','monorail'))
      OR ($1 >= 12 AND highway IN ('residential','unclassified','living_street','road'))
      OR ($1 >= 13 AND highway IN ('service','track','pedestrian','footway','path','cycleway','steps','bridleway')))
   ORDER BY z_order DESC NULLS LAST, osm_id LIMIT 6000`)}
|| ${layer('transportation_name', `
  SELECT name, ${latin} AS "name:latin", ${nonlatin} AS "name:nonlatin",
         CASE WHEN highway IN ('motorway','motorway_link') THEN 'motorway'
              WHEN highway IN ('trunk','trunk_link','primary','primary_link') THEN 'primary'
              WHEN highway IN ('secondary','secondary_link','tertiary','tertiary_link') THEN 'secondary'
              ELSE 'minor' END AS class,
         ${geom(2)}
    FROM planet_osm_line, bounds
   WHERE $1 >= 12 AND way && bounds.buffered AND name IS NOT NULL AND highway IS NOT NULL
     AND highway NOT IN ('footway','path','cycleway','steps','bridleway','track','service')
   ORDER BY z_order DESC NULLS LAST, osm_id LIMIT 1500`)}
|| ${layer('place', `
  SELECT place AS class, name, ${latin} AS "name:latin", ${nonlatin} AS "name:nonlatin",
         CASE place WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'village' THEN 3 WHEN 'suburb' THEN 4
                    WHEN 'quarter' THEN 5 WHEN 'neighbourhood' THEN 6 ELSE 7 END AS rank,
         ST_AsMVTGeom(way, bounds.geom, 4096, 64, true) AS geom
    FROM planet_osm_point, bounds
   WHERE way && bounds.buffered AND name IS NOT NULL AND (
         place IN ('city','town')
      OR ($1 >= 10 AND place IN ('village','suburb'))
      OR ($1 >= 12 AND place IN ('quarter','neighbourhood','hamlet','locality')))
   ORDER BY rank, osm_id LIMIT 300`)}
AS mvt`;
}

// Tiles from the local import. null means "ask somebody else": no database,
// no import, an empty tile here, or a zoom this does not answer.
export function makeVectorPostgis({ query, log = console, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  let schema = null;          // { at, sql } once looked at; sql null without an import
  let retryAfter = 0;

  async function sqlFor() {
    // Looked at again every ten minutes, so importing an extract does not need
    // a restart, and a missing one costs one cheap query rather than one a tile.
    if (schema && now() - schema.at < 600_000) return schema.sql;
    const { rows } = await query(`
      SELECT to_regclass('planet_osm_line') IS NOT NULL
         AND to_regclass('planet_osm_polygon') IS NOT NULL
         AND to_regclass('planet_osm_point') IS NOT NULL AS imported,
             EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'planet_osm_polygon' AND column_name = 'tags') AS tags`);
    const found = rows[0] || {};
    schema = { at: now(), sql: found.imported ? vectorSql({ tags: Boolean(found.tags) }) : null };
    return schema.sql;
  }

  return {
    async tile(z, x, y) {
      if (!query || z < VECTOR_PG_MIN_ZOOM || z > VECTOR_MAX_ZOOM || now() < retryAfter) return null;
      const key = `${z}/${x}/${y}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.bytes;
      try {
        const sql = await sqlFor();
        if (!sql) return null;
        if (!pending.has(key)) {
          pending.set(key, Promise.resolve()
            .then(() => query(sql, [z, x, y]))
            .then(({ rows }) => {
              const bytes = rows[0] && rows[0].mvt && rows[0].mvt.length ? Buffer.from(rows[0].mvt) : null;
              if (cache.size >= 256) cache.delete(cache.keys().next().value);
              cache.set(key, { bytes, until: now() + (bytes ? 300_000 : 30_000) });
              return bytes;
            })
            .finally(() => pending.delete(key)));
        }
        return await pending.get(key);
      } catch (error) {
        retryAfter = now() + 5_000;
        schema = null;
        log.error('geo: cannot make a vector tile —', error?.message || error);
        return null;
      }
    },
  };
}

// Tiles from somebody else's server, cached on disk. `upstream` is either a
// URL template with {z}/{x}/{y}, or a TileJSON address whose "tiles" gives the
// template (OpenFreeMap's changes with every weekly build, so it is asked for
// once a day rather than written down here). 'off' or empty: no upstream.
export function makeVectorUpstream({
  upstream,
  cacheDir,
  userAgent,
  maxAge = 7 * 24 * 3600,
  log = console,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const enabled = Boolean(upstream) && upstream !== 'off';
  let template = enabled && upstream.includes('{z}') ? upstream : null;
  let asked = 0;              // when the TileJSON was last fetched, or tried
  let tries = 0;

  const fileFor = ({ z, x, y }) => join(cacheDir, String(z), String(x), `${y}.pbf`);

  async function resolve() {
    if (upstream.includes('{z}')) return template;
    // A day between asks while it answers; a minute while it does not.
    if (template && now() - asked < 86_400_000) return template;
    if (!template && tries && now() - asked < 60_000) return null;
    asked = now();
    tries++;
    try {
      const res = await fetchImpl(upstream, { headers: { 'user-agent': userAgent } });
      if (!res.ok) throw new Error(`tilejson ${res.status}`);
      const json = await res.json();
      const found = Array.isArray(json.tiles) && typeof json.tiles[0] === 'string' ? json.tiles[0] : null;
      if (!found || !found.includes('{z}')) throw new Error('tilejson has no tile template');
      // Only tiles from the host that was configured: a TileJSON that sent
      // this server off to fetch from anywhere else — its own network, say —
      // is not followed.
      const at = new URL(found.replace(/\{[zxy]\}/g, '0'));
      if (!/^https?:$/.test(at.protocol) || at.host !== new URL(upstream).host) {
        throw new Error('tilejson points somewhere other than its own host');
      }
      template = found;
    } catch (e) {
      log.error('tiles: cannot read the vector TileJSON —', e && e.message ? e.message : e);
    }
    return template;
  }

  async function cached(tile) {
    try {
      const file = fileFor(tile);
      const s = await stat(file);
      return { bytes: await readFile(file), age: (now() - s.mtimeMs) / 1000 };
    } catch {
      return null;
    }
  }

  return {
    enabled,
    async tile(tile) {
      if (!enabled || tile.z > VECTOR_MAX_ZOOM) return null;
      const hit = await cached(tile);
      if (hit && hit.age < maxAge) return { bytes: hit.bytes, from: 'cache' };
      try {
        const url = await resolve();
        if (!url) throw new Error('no tile template');
        // fetch undoes the gzip the upstream sends; this stores plain MVT and
        // compresses once, on the way out.
        const res = await fetchImpl(tileUrl(url, tile), { headers: { 'user-agent': userAgent } });
        let bytes;
        if (res.status === 204 || res.status === 404) bytes = Buffer.alloc(0);
        else if (!res.ok) throw new Error(`upstream ${res.status}`);
        else bytes = Buffer.from(await res.arrayBuffer());
        try {
          const file = fileFor(tile);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes);
        } catch (e) {
          log.error('tiles: fetched a vector tile but could not cache it —', e && e.message ? e.message : e);
        }
        return { bytes, from: 'upstream' };
      } catch (e) {
        if (hit) return { bytes: hit.bytes, from: 'stale' };
        log.error('tiles: cannot fetch a vector tile —', e && e.message ? e.message : e);
        return null;
      }
    },
  };
}

// The import where it has something to say, the upstream everywhere else.
export function makeVector({ postgis = null, upstream = null } = {}) {
  return {
    async tile(tile) {
      if (tile.z > VECTOR_MAX_ZOOM) return null;
      const local = postgis ? await postgis(tile) : null;
      if (local && local.length) return { bytes: local, from: 'postgis' };
      return upstream ? upstream.tile(tile) : null;
    },
  };
}
