// district.js — the name of where the middle of the map is.
//
// The dashboard names the district you are looking at, bottom right, the way
// a game names the district you drive into. The names are OpenStreetMap's
// places (neighbourhoods, quarters, suburbs, villages, towns and cities), from
// whichever of two sources has them:
//
//   1. PostGIS, where an osm2pgsql extract has been imported: planet_osm_point.
//   2. Otherwise the `place` layer of vector tiles in the OpenMapTiles layout,
//      from an upstream proxied and cached on disk the way raster tiles are
//      (tiles.js): OpenFreeMap by default, which is free, keyless and covers
//      the planet. VECTOR_UPSTREAM=off turns it off.
//
// The browser asks this service, never the upstream, and gets one or two
// lines of text back. Where somebody is looking is never logged.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tileUrl } from './tile-path.js';
import { readLayer, POINT } from './mvt.js';

// From this zoom of the map in. Further out the view is a whole city or more,
// and no one district is "here".
export const DISTRICT_MIN_ZOOM = 12;
// Deepest tile either source is asked for; closer zooms use these.
export const PLACE_MAX_ZOOM = 14;

// How far from the middle of the view a place's point may be, in screen
// pixels, and still name where you are looking.
const REACH_X = 220;
const REACH_Y = 160;

// Each kind of place: its tier, and how far its name carries. Parts of a
// town (neighbourhoods, quarters, suburbs) come before any town, because
// inside a town its own name is the less useful answer. Within a tier the
// nearest wins, a bigger place counting as nearer: villages, towns and cities
// are neighbours rather than parts of one another, and the middle of a town
// is that town, whichever village is also on the screen.
const KINDS = {
  neighbourhood: { tier: 0, reach: 1 },
  quarter: { tier: 0, reach: 1 },
  suburb: { tier: 0, reach: 2 },
  village: { tier: 1, reach: 1 },
  town: { tier: 1, reach: 2 },
  city: { tier: 1, reach: 4 },
};

// Letters outside Latin script. A name made of them gets a Latin line under
// it from name:en, when OSM has one; this is how OpenMapTiles splits names.
const NONLATIN = /[^ -ɏḀ-ỿ -⁯]/;

// Where a point is across the world, 0 to 1 each way, in Web Mercator like
// the map itself.
function worldX(lon) {
  return (lon + 180) / 360;
}
function worldY(lat) {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}

// One or two lines: the name in its own script, then a Latin one when the
// first is not Latin. A Latin name alone is one line.
function linesOf(local, latin) {
  const clean = (s) => (typeof s === 'string' ? s.trim().slice(0, 80) : '');
  const a = clean(local);
  const b = clean(latin);
  return [a, b !== a ? b : ''].filter(Boolean);
}

// The tiles a name near the middle of the view can be in: tiles of the zoom
// the map draws at this scale (a vector tile is 512 px, the map's are 256, so
// one shallower), which puts it in 2 × 2 of them at most.
export function tilesAround(lat, lon, zoom) {
  const z = Math.max(0, Math.min(PLACE_MAX_ZOOM, Math.floor(zoom) - 1));
  const n = 2 ** z;
  const world = 256 * 2 ** zoom;            // the world's width on screen
  const size = world / n;                   // one tile's
  const cx = worldX(lon) * world;
  const cy = worldY(lat) * world;
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  const tiles = [];
  for (let x = clamp(Math.floor((cx - REACH_X) / size)); x <= clamp(Math.floor((cx + REACH_X) / size)); x++) {
    for (let y = clamp(Math.floor((cy - REACH_Y) / size)); y <= clamp(Math.floor((cy + REACH_Y) / size)); y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

// The name for the middle of the view, from places ({ tier, reach, x, y,
// lines }, x and y across the world as above), or [] when none is close
// enough.
export function pickDistrict(places, lat, lon, zoom) {
  const world = 256 * 2 ** zoom;
  const cx = worldX(lon) * world;
  const cy = worldY(lat) * world;
  let best = null;
  let bestScore = Infinity;
  for (const place of places) {
    const dx = place.x * world - cx;
    const dy = place.y * world - cy;
    if (Math.abs(dx) > REACH_X || Math.abs(dy) > REACH_Y) continue;
    // The tier first, whatever the distance (the reach keeps distances under
    // a thousand pixels), then the nearest in it.
    const score = place.tier * 1000 + Math.hypot(dx, dy) / place.reach;
    if (score < bestScore) {
      best = place;
      bestScore = score;
    }
  }
  return best ? best.lines : [];
}

// The places in one vector tile's `place` layer. A tile that cannot be read
// has none, rather than failing the request.
export function placesInTile(bytes, tile) {
  let layer = null;
  try {
    layer = bytes && bytes.length ? readLayer(bytes, 'place') : null;
  } catch {
    layer = null;
  }
  if (!layer) return [];
  const n = 2 ** tile.z;
  const out = [];
  for (const f of layer.features) {
    const p = f.properties;
    const kind = KINDS[p.class];
    if (!kind || f.type !== POINT || !f.points.length) continue;
    const local = p['name:nonlatin'] || '';
    const lines = linesOf(local, p['name:latin'] || p.name_en || (local ? '' : p.name));
    if (!lines.length) continue;
    const [px, py] = f.points[0];
    out.push({ ...kind, x: (tile.x + px / layer.extent) / n, y: (tile.y + py / layer.extent) / n, lines });
  }
  return out;
}

// The same places from planet_osm_point, within one tile. Deeper tiles bring
// smaller places, as OpenMapTiles does. $1..$3 are z, x, y.
export function placeSql({ tags = true } = {}) {
  return `
SELECT place, name, ${tags ? `tags->'name:en'` : 'NULL'} AS en,
       ST_X(ST_Transform(way, 4326)) AS lon, ST_Y(ST_Transform(way, 4326)) AS lat
  FROM planet_osm_point
 WHERE way && ST_TileEnvelope($1, $2, $3) AND name IS NOT NULL AND (
       place IN ('city','town')
    OR ($1 >= 10 AND place IN ('village','suburb'))
    OR ($1 >= 12 AND place IN ('quarter','neighbourhood')))
 ORDER BY CASE WHEN place IN ('neighbourhood','quarter','suburb') THEN 0 ELSE 1 END, osm_id
 LIMIT 300`;
}

export function placesFromRows(rows) {
  const out = [];
  for (const row of rows) {
    const kind = KINDS[row.place];
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!kind || !Number.isFinite(lat) || !Number.isFinite(lon) || typeof row.name !== 'string') continue;
    const local = NONLATIN.test(row.name) ? row.name : '';
    const lines = linesOf(local, local ? row.en : row.name);
    if (lines.length) out.push({ ...kind, x: worldX(lon), y: worldY(lat), lines });
  }
  return out;
}

// Places from the local import, or null for "ask the upstream": no
// database, no import, or it failed a moment ago.
export function makePlacesPostgis({ query, log = console, now = Date.now } = {}) {
  let schema = null;          // { at, sql } once looked at; sql null without an import
  let looking = null;         // the look in progress, shared by the tiles waiting on it
  let retryAfter = 0;

  function sqlFor() {
    // Looked at again every ten minutes, so importing an extract does not need
    // a restart, and a missing one costs one cheap query rather than one a tile.
    if (schema && now() - schema.at < 600_000) return Promise.resolve(schema.sql);
    if (!looking) {
      looking = query(`
        SELECT to_regclass('planet_osm_point') IS NOT NULL AS imported,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'planet_osm_point' AND column_name = 'tags') AS tags`)
        .then(({ rows }) => {
          const found = rows[0] || {};
          schema = { at: now(), sql: found.imported ? placeSql({ tags: Boolean(found.tags) }) : null };
          return schema.sql;
        })
        .finally(() => { looking = null; });
    }
    return looking;
  }

  return {
    async places(tile) {
      if (!query || tile.z > PLACE_MAX_ZOOM || now() < retryAfter) return null;
      try {
        const sql = await sqlFor();
        if (!sql) return null;
        const { rows } = await query(sql, [tile.z, tile.x, tile.y]);
        return placesFromRows(rows);
      } catch (error) {
        retryAfter = now() + 5_000;
        schema = null;
        log.error('district: cannot read places from the import —', error?.message || error);
        return null;
      }
    },
  };
}

// Vector tiles from somebody else's server, cached on disk. `upstream` is
// either a URL template with {z}/{x}/{y}, or a TileJSON address whose "tiles"
// gives the template (OpenFreeMap's changes with every weekly build, so it is
// asked for once a day rather than written down here). 'off' or empty: none.
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
  let reading = null;         // the fetch in progress, which every tile waits on

  const fileFor = ({ z, x, y }) => join(cacheDir, String(z), String(x), `${y}.pbf`);

  async function read() {
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

  function resolve() {
    if (upstream.includes('{z}')) return Promise.resolve(template);
    // A day between asks while it answers; a minute while it does not.
    if (template && now() - asked < 86_400_000) return Promise.resolve(template);
    // The tiles of one look arrive together, and all of them wait for the one
    // fetch: none is told there is no template just because it came second.
    if (reading) return reading;
    if (!template && tries && now() - asked < 60_000) return Promise.resolve(null);
    asked = now();
    tries++;
    reading = read().finally(() => { reading = null; });
    return reading;
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
      if (!enabled || tile.z > PLACE_MAX_ZOOM) return null;
      const hit = await cached(tile);
      if (hit && hit.age < maxAge) return { bytes: hit.bytes, from: 'cache' };
      try {
        const url = await resolve();
        if (!url) throw new Error('no tile template');
        // fetch undoes the gzip the upstream sends; plain MVT is stored.
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

// The import where it has places, the upstream everywhere else. What a tile
// holds is kept for a while, so looking around one area asks each source once.
export function makeDistrict({ postgis = null, upstream = null, log = console, now = Date.now } = {}) {
  const cache = new Map();    // "z/x/y" → { places, until }
  const pending = new Map();

  async function load(tile) {
    const local = postgis ? await postgis.places(tile) : null;
    if (local && local.length) return { places: local, keep: 600_000 };
    const got = upstream ? await upstream.tile(tile) : null;
    if (got) return { places: placesInTile(got.bytes, tile), keep: 600_000 };
    // Nobody answered, which is not the same as nothing being there: asked
    // again soon.
    return { places: local || [], keep: 30_000 };
  }

  function placesIn(tile) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.places;
    if (!pending.has(key)) {
      pending.set(key, load(tile)
        .then(({ places, keep }) => {
          cache.delete(key);
          if (cache.size >= 1024) cache.delete(cache.keys().next().value);
          cache.set(key, { places, until: now() + keep });
          return places;
        })
        .catch((e) => {
          log.error('district: cannot read places —', e && e.message ? e.message : e);
          return [];
        })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  return {
    // [] when there is nothing to say; never throws.
    async at(lat, lon, zoom) {
      if (![lat, lon, zoom].every(Number.isFinite) || zoom < DISTRICT_MIN_ZOOM) return [];
      const lists = await Promise.all(tilesAround(lat, lon, zoom).map(placesIn));
      return pickDistrict(lists.flat(), lat, lon, zoom);
    },
  };
}
