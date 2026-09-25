// district.js — the name of where the middle of the map is.
//
// The dashboard names the district you are looking at, bottom right, the way
// a game names the district you drive into. The names are OpenStreetMap's
// places (neighbourhoods, quarters, suburbs, villages, towns and cities), from
// whichever of two sources has them:
//
//   1. PostGIS, where an osm2pgsql extract has been imported: planet_osm_point.
//   2. Otherwise the `place` layer of vector tiles in the OpenMapTiles layout,
//      from the upstream in vector-tiles.js: OpenFreeMap by default.
//
// The browser asks this service, never the upstream, and gets one or two
// lines of text back — and, zoomed in to streets, the street at the middle,
// from the same tiles. Both work wherever the upstream has the world, and
// both stay as far in as the map zooms. Where somebody is looking is never
// logged.

import { readLayer, partsOf, POINT, LINE } from './mvt.js';
import { VECTOR_MAX_ZOOM } from './vector-tiles.js';

// From this zoom of the map in. Further out the view is a whole city or more,
// and no one district is "here".
export const DISTRICT_MIN_ZOOM = 12;
// Deepest tile either source is asked for; closer zooms use these.
export const PLACE_MAX_ZOOM = VECTOR_MAX_ZOOM;

// Closer in than this the district is looked for as it is at this zoom. The
// reach is in screen pixels, and at street level and beyond a few hundred
// pixels are a few dozen metres: zooming in used to lose the name of where
// you were, although you had not moved.
export const DISTRICT_ZOOM_CAP = 15;

// From this zoom of the map in, the street at the middle is named as well:
// close enough that the middle of the view is on a street, not a quarter.
export const STREET_MIN_ZOOM = 15;
// How far from the middle a street may pass, in screen pixels, and still be
// the one you are on — and never less than this many metres, however far in
// the map is zoomed: at zoom 20 the pixels alone come to four metres.
const STREET_REACH = 36;
const STREET_FLOOR = 40;
// What a street sign names: not footpaths, tracks, railways, lifts or
// ferries. A pedestrian street is a street, though OpenMapTiles files it
// under paths.
const NOT_STREETS = ['path', 'track', 'rail', 'transit', 'ferry', 'aerialway'];
const isStreet = (p) => !NOT_STREETS.includes(p.class) || (p.class === 'path' && p.subclass === 'pedestrian');

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

// Most of the world has no neighbourhood points at all, and a town's point is
// often further from where you are in it than the view reaches. When nothing
// is in reach, the suburb, village, town or city the middle is in, by how far
// each kind's name carries on the ground (metres), from tiles of this zoom,
// which hold every one of them (OpenMapTiles puts villages and suburbs in from
// z10–11, towns and cities long before).
const SETTLEMENT_REACH = { suburb: 2500, village: 2500, town: 5000, city: 10000 };
export const SETTLEMENT_ZOOM = 11;

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

// Metres between two points given across the world as above, near enough:
// the east–west scale where they are, on a flat projection. Good to well
// under a percent at the distances a place's name carries.
function metresApart(x1, y1, x2, y2) {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (y1 + y2)))) * 180) / Math.PI;
  const perWorld = 40075016.686 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(x1 - x2, y1 - y2) * perWorld;
}

// The SETTLEMENT_ZOOM tiles within the widest settlement reach of the middle:
// 3 × 3 at most, around the one it is in, which far north is a little less
// than the whole reach, as the tiles get narrower there.
export function settlementTiles(lat, lon) {
  const z = SETTLEMENT_ZOOM;
  const n = 2 ** z;
  const x = worldX(lon);
  const y = worldY(lat);
  // The reach as a share of the world's width where the middle is.
  const r = Math.max(...Object.values(SETTLEMENT_REACH))
    / (40075016.686 * Math.cos((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180));
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  const range = (v) => {
    const at = Math.floor(v * n);
    return [clamp(Math.max(at - 1, Math.floor((v - r) * n))), clamp(Math.min(at + 1, Math.floor((v + r) * n)))];
  };
  const [x0, x1] = range(x);
  const [y0, y1] = range(y);
  const tiles = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) tiles.push({ z, x: tx, y: ty });
  }
  return tiles;
}

// The settlement the middle is in, from places as above: the nearest for its
// size, so the middle of a town is that town even with a suburb's point a
// couple of kilometres off. [] when none carries this far.
export function pickSettlement(places, lat, lon) {
  const x = worldX(lon);
  const y = worldY(lat);
  let best = null;
  let bestScore = Infinity;
  for (const place of places) {
    const reach = SETTLEMENT_REACH[place.kind];
    if (!reach) continue;
    const d = metresApart(place.x, place.y, x, y);
    if (d > reach) continue;
    const score = d / reach;
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
    out.push({ ...kind, kind: p.class, x: (tile.x + px / layer.extent) / n, y: (tile.y + py / layer.extent) / n, lines });
  }
  return out;
}

// The named streets in one vector tile's transportation_name layer: { name,
// points }, the points across the world as above, x and y in turn (a city
// tile holds thousands; kept flat, they take a quarter of the memory).
export function streetsInTile(bytes, tile) {
  let layer = null;
  try {
    layer = bytes && bytes.length ? readLayer(bytes, 'transportation_name') : null;
  } catch {
    layer = null;
  }
  if (!layer) return [];
  const n = 2 ** tile.z;
  const out = [];
  for (const f of layer.features) {
    const name = typeof f.properties.name === 'string' ? f.properties.name.trim().slice(0, 80) : '';
    if (f.type !== LINE || !name || !isStreet(f.properties)) continue;
    for (const part of partsOf(LINE, f.geometry)) {
      if (part.length < 2) continue;
      const points = new Float64Array(part.length * 2);
      part.forEach(([x, y], i) => {
        points[2 * i] = (tile.x + x / layer.extent) / n;
        points[2 * i + 1] = (tile.y + y / layer.extent) / n;
      });
      out.push({ name, points });
    }
  }
  return out;
}

// How far a street may pass from the middle, in pixels at this zoom:
// STREET_REACH, or STREET_FLOOR metres when that is more.
export function streetReach(lat, zoom) {
  const metresPerPixel = (40075016.686 * Math.cos((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180)) / (256 * 2 ** zoom);
  return Math.max(STREET_REACH, STREET_FLOOR / metresPerPixel);
}

// The z14 tiles a street within reach of the middle of the view can be in.
export function streetTiles(lat, lon, zoom) {
  const z = PLACE_MAX_ZOOM;
  const n = 2 ** z;
  const world = 256 * 2 ** zoom;
  const size = world / n;
  const cx = worldX(lon) * world;
  const cy = worldY(lat) * world;
  const reach = streetReach(lat, zoom);
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  const tiles = [];
  for (let x = clamp(Math.floor((cx - reach) / size)); x <= clamp(Math.floor((cx + reach) / size)); x++) {
    for (let y = clamp(Math.floor((cy - reach) / size)); y <= clamp(Math.floor((cy + reach) / size)); y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

// The street passing nearest the middle of the view, within reach, or ''.
export function pickStreet(streets, lat, lon, zoom) {
  const world = 256 * 2 ** zoom;
  const cx = worldX(lon) * world;
  const cy = worldY(lat) * world;
  let best = '';
  let nearest = streetReach(lat, zoom);
  for (const { name, points: p } of streets) {
    // Each piece of the line, from where the middle is: the nearest point on
    // it, not only its ends, so a long straight street counts all along.
    for (let i = 2; i + 1 < p.length; i += 2) {
      const ax = p[i - 2] * world - cx;
      const ay = p[i - 1] * world - cy;
      const dx = p[i] * world - cx - ax;
      const dy = p[i + 1] * world - cy - ay;
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d <= nearest) {
        nearest = d;
        best = name;
      }
    }
  }
  return best;
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
    if (lines.length) out.push({ ...kind, kind: row.place, x: worldX(lon), y: worldY(lat), lines });
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

  // Streets come from the upstream's vector tiles, kept the same way; fewer
  // of them, as a city tile's streets weigh far more than its places.
  const streetCache = new Map();
  const streetPending = new Map();
  function streetsIn(tile) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const hit = streetCache.get(key);
    if (hit && hit.until > now()) return hit.streets;
    if (!streetPending.has(key)) {
      streetPending.set(key, Promise.resolve().then(() => upstream.tile(tile))
        .then((got) => {
          const streets = got ? streetsInTile(got.bytes, tile) : [];
          streetCache.delete(key);
          if (streetCache.size >= 64) streetCache.delete(streetCache.keys().next().value);
          streetCache.set(key, { streets, until: now() + (got ? 600_000 : 30_000) });
          return streets;
        })
        .catch((e) => {
          log.error('district: cannot read streets —', e && e.message ? e.message : e);
          return [];
        })
        .finally(() => streetPending.delete(key)));
    }
    return streetPending.get(key);
  }

  return {
    // [] when there is nothing to say; never throws. Zoomed in past street
    // level, the answer is street level's; with nothing in reach, the
    // settlement the middle is in.
    async at(lat, lon, zoom) {
      if (![lat, lon, zoom].every(Number.isFinite) || zoom < DISTRICT_MIN_ZOOM) return [];
      const z = Math.min(zoom, DISTRICT_ZOOM_CAP);
      const lists = await Promise.all(tilesAround(lat, lon, z).map(placesIn));
      const near = pickDistrict(lists.flat(), lat, lon, z);
      if (near.length) return near;
      const wider = await Promise.all(settlementTiles(lat, lon).map(placesIn));
      return pickSettlement(wider.flat(), lat, lon);
    },
    // The street at the middle of the view, or ''; never throws.
    async street(lat, lon, zoom) {
      if (![lat, lon, zoom].every(Number.isFinite) || zoom < STREET_MIN_ZOOM || !upstream) return '';
      const lists = await Promise.all(streetTiles(lat, lon, zoom).map(streetsIn));
      return pickStreet(lists.flat(), lat, lon, zoom);
    },
  };
}
