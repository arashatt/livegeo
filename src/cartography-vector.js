// cartography-vector.js — the styled map layers, from vector tiles, wherever
// no OSM extract is imported.
//
// The Layers panel's six features (roads, railways, urban areas and terrain,
// parks and woodland, water, buildings) are drawn from the local import when
// there is one (cartography.js). Everywhere else they come from the same
// OpenMapTiles vector tiles the district name reads (vector-tiles.js):
// OpenFreeMap by default, proxied and cached by this server. Both go through
// one renderer, with the same zooms and the same budgets, so the map looks
// and switches the same whichever source drew it.

import { readLayers, partsOf, boundsOf, LINE, POLYGON } from './mvt.js';
import { renderCartography, CARTOGRAPHY_LAYERS, CARTOGRAPHY_MIN_ZOOM } from './cartography.js';
import { VECTOR_MAX_ZOOM } from './vector-tiles.js';

const SOURCE_LAYERS = ['landuse', 'landcover', 'park', 'water', 'waterway', 'building', 'transportation'];

// How much of each feature a map tile may carry, as the import's query allows.
const BUDGET = { landuse: 350, parks: 500, 'water-area': 400, 'water-line': 500, buildings: 1800, rail: 400, roads: 2400 };

// Past the tile's edge, as far as a wide road or a stroke can still paint
// into it: twelve of its 256 pixels, as the import's query uses.
const MARGIN = 12;

const MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const PATHS = ['pedestrian', 'path', 'footway', 'cycleway', 'steps', 'bridleway'];
const ROAD_ORDER = { motorway: 0, trunk: 0, primary: 1, secondary: 2 };

// Where a 256-px map tile sits in the vector tile it is drawn from. Vector
// tiles are 512 px, so a map tile at zoom z is a quarter of one at z - 1;
// past the deepest vector tile it is a smaller piece of that one.
export function sourceOf({ z, x, y }) {
  const vz = Math.max(0, Math.min(VECTOR_MAX_ZOOM, z - 1));
  const d = z - vz;
  const vx = Math.floor(x / 2 ** d);
  const vy = Math.floor(y / 2 ** d);
  return { tile: { z: vz, x: vx, y: vy }, d, ox: x - vx * 2 ** d, oy: y - vy * 2 ** d };
}

// Which of the six features an OpenMapTiles feature is, and its kind, at the
// map's zoom; null for everything else. The zooms are the import's (see
// CARTOGRAPHY_SQL): roads by importance, buildings from street level.
export function classify(layer, p, type, zoom) {
  switch (layer) {
    case 'transportation': {
      if (type !== LINE) return null;
      const kind = p.class;
      if (kind === 'rail' || kind === 'transit') {
        const sub = p.subclass || kind;
        if (zoom < 11 || !['rail', 'narrow_gauge', 'preserved', 'light_rail', 'tram'].includes(sub)) return null;
        return { layer: 'rail', subtype: sub === 'light_rail' || sub === 'tram' ? sub : 'rail' };
      }
      if (MAJOR.includes(kind)) {
        const from = kind === 'motorway' || kind === 'trunk' ? 0 : kind === 'tertiary' ? 12 : 10;
        return zoom >= from ? { layer: 'roads', subtype: kind + (p.ramp ? '_link' : '') } : null;
      }
      if (kind === 'minor') return zoom >= 12 ? { layer: 'roads', subtype: 'residential' } : null;
      if (kind === 'service') return zoom >= 14 ? { layer: 'roads', subtype: 'service' } : null;
      if (kind === 'track') return zoom >= 15 ? { layer: 'roads', subtype: 'track' } : null;
      if (kind === 'path') return zoom >= 15 ? { layer: 'roads', subtype: PATHS.includes(p.subclass) ? p.subclass : 'path' } : null;
      return null;
    }
    case 'water':
      return type === POLYGON ? { layer: 'water', subtype: 'area' } : null;
    case 'waterway':
      if (type !== LINE) return null;
      if ((p.class === 'river' || p.class === 'canal') && zoom >= 11) return { layer: 'water', subtype: p.class };
      if ((p.class === 'stream' || p.class === 'drain') && zoom >= 14) return { layer: 'water', subtype: p.class };
      return null;
    case 'landcover':
      if (type !== POLYGON) return null;
      // Grass is OpenMapTiles' class for parks, gardens, meadows and heath.
      if (p.class === 'wood' || p.class === 'grass') return { layer: 'parks', subtype: '' };
      if ((p.class === 'rock' || p.class === 'sand') && zoom >= 10) return { layer: 'landuse', subtype: 'terrain' };
      return null;
    case 'park':
      return type === POLYGON ? { layer: 'parks', subtype: '' } : null;
    case 'landuse':
      return type === POLYGON && zoom >= 10 && ['residential', 'commercial', 'industrial', 'retail'].includes(p.class)
        ? { layer: 'landuse', subtype: 'urban' } : null;
    case 'building':
      return type === POLYGON && zoom >= 15 ? { layer: 'buildings', subtype: '' } : null;
    default:
      return null;
  }
}

// A tile this big is not a vector tile anybody meant to send.
const MAX_TILE_BYTES = 8 * 1024 * 1024;

// Whole pixels, as the import's tiles are drawn (ST_AsMVTGeom at 256): finer
// is invisible and only makes the file bigger. `|| 0` keeps -0 out of it.
const px = (v) => Math.round(v) || 0;

// What a vector tile is kept as: only the features one of the six could ever
// draw (every zoom rule is "from this zoom in", so none at 19 is none at
// all), each with its bounds, so a map tile skips what cannot reach it
// without decoding it.
export function keepable(layers) {
  const out = {};
  for (const name of SOURCE_LAYERS) {
    const layer = layers[name];
    if (!layer) continue;
    const features = layer.features.filter((f) => classify(name, f.properties, f.type, 19));
    for (const f of features) f.bounds = boundsOf(f.geometry);
    out[name] = { extent: layer.extent, features };
  }
  return out;
}

// Whether a feature's bounds reach the map tile. Bounds, not corners: a road
// can cross a tile with no bend inside it, and a lake can cover one with no
// shore in it.
function reaches([minX, minY, maxX, maxY], { scale, ox, oy }) {
  return !(maxX * scale - ox < -MARGIN || minX * scale - ox > 256 + MARGIN
    || maxY * scale - oy < -MARGIN || minY * scale - oy > 256 + MARGIN);
}

// A feature's parts as an SVG path in the map tile's 256 units. Y is
// negated, as ST_AsSVG writes it, which the renderer undoes; one convention
// for both sources.
function pathOf(parts, closed, place) {
  const { scale, ox, oy } = place;
  let d = '';
  for (const part of parts) {
    const points = closed ? part.slice(0, -1) : part;
    if (points.length < (closed ? 3 : 2)) continue;
    let last = '';
    let out = '';
    for (const [u, v] of points) {
      const p = `${px(u * scale - ox)} ${px(-(v * scale - oy))}`;
      if (p === last) continue;
      out += out ? ` L${p}` : `M${p}`;
      last = p;
    }
    d += (d ? ' ' : '') + out + (closed ? ' Z' : '');
  }
  return d;
}

// The rows the renderer takes ({ layer, subtype, d }) for one map tile, from
// the vector tile it is part of: only the features asked for, and within the
// budgets, counted before any path is written.
export function rowsFor(layers, zoom, where, wanted = CARTOGRAPHY_LAYERS) {
  const groups = {};
  for (const name of SOURCE_LAYERS) {
    const layer = layers[name];
    if (!layer) continue;
    const place = {
      scale: (256 * 2 ** where.d) / layer.extent,
      ox: where.ox * 256,
      oy: where.oy * 256,
    };
    for (const f of layer.features) {
      if (!reaches(f.bounds || boundsOf(f.geometry), place)) continue;
      const kind = classify(name, f.properties, f.type, zoom);
      if (!kind || !wanted.includes(kind.layer)) continue;
      const group = kind.layer === 'water' ? (kind.subtype === 'area' ? 'water-area' : 'water-line') : kind.layer;
      (groups[group] = groups[group] || []).push({ kind, f, place });
    }
  }
  if (groups.roads) {
    // The most important roads first, so a budget cuts the least of them.
    const order = ({ kind }) => ROAD_ORDER[kind.subtype.replace(/_link$/, '')] ?? 3;
    groups.roads.sort((a, b) => order(a) - order(b));
  }
  const rows = [];
  for (const [group, found] of Object.entries(groups)) {
    let kept = 0;
    for (const { kind, f, place } of found) {
      if (kept >= BUDGET[group]) break;
      const d = pathOf(partsOf(f.type, f.geometry), f.type === POLYGON, place);
      if (!d) continue;
      rows.push({ layer: kind.layer, subtype: kind.subtype, d });
      kept++;
    }
  }
  return rows;
}

// { tile(z, x, y, layers) } → an SVG, or null when there is nothing to draw
// or no upstream. Each vector tile is read once and kept a while: the four or
// more map tiles cut from it arrive together, and each switch in Layers asks
// for them again.
export function makeVectorCartography({ upstream = null, log = console, now = Date.now } = {}) {
  const cache = new Map();    // "z/x/y" → { layers, until }
  const pending = new Map();

  async function load(tile) {
    const got = await upstream.tile(tile);
    // Nobody answered: not the same as nothing there, so asked again soon.
    if (!got) return { layers: null, keep: 30_000 };
    if (!got.bytes.length) return { layers: {}, keep: 600_000 };
    if (got.bytes.length > MAX_TILE_BYTES) {
      log.error('carto: a vector tile too big to draw —', got.bytes.length, 'bytes');
      return { layers: {}, keep: 600_000 };
    }
    try {
      return { layers: keepable(readLayers(got.bytes, SOURCE_LAYERS)), keep: 600_000 };
    } catch (e) {
      log.error('carto: cannot read a vector tile —', e && e.message ? e.message : e);
      return { layers: {}, keep: 60_000 };
    }
  }

  function layersOf(tile) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return Promise.resolve(hit.layers);
    if (!pending.has(key)) {
      pending.set(key, load(tile)
        .then(({ layers, keep }) => {
          cache.delete(key);
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(key, { layers, until: now() + keep });
          return layers;
        })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  return {
    async tile(z, x, y, layers = CARTOGRAPHY_LAYERS) {
      if (!upstream || !upstream.enabled) return null;
      if (![z, x, y].every(Number.isInteger) || z < CARTOGRAPHY_MIN_ZOOM || z > 19
          || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z || !layers.length) return null;
      const where = sourceOf({ z, x, y });
      const found = await layersOf(where.tile);
      if (!found) return null;
      return renderCartography(rowsFor(found, z, where, layers), z, layers);
    },
  };
}
