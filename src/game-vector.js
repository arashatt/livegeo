// game-vector.js — the 3D map's tiles (/carto/{z}/{x}/{y}.mvt) where no OSM
// extract is imported.
//
// The 3D map draws from tiles in its own layout (postgis-vector.js: roads,
// rail, water, parks, landuse, buildings, places), which only an osm2pgsql
// import can make. A server that keeps history but no extract drew an empty
// world. This makes the same layers, with the same fields, zooms and budgets,
// from the OpenMapTiles vector tiles the server already fetches for the
// district name and the styled layers (vector-tiles.js; OpenFreeMap by
// default). The browser still asks nobody but this server.
//
// OpenMapTiles stops at z14; the 3D map asks for tiles up to z19. Those are
// cut from their z14 tile here: scaled, clipped to the tile and its buffer,
// written again. Up to z14 the geometry is passed through untouched.

import { gzipSync } from 'node:zlib';
import { readLayers, partsOf, boundsOf, LINE, POLYGON, POINT } from './mvt.js';
import { commandsOf, encodeTile } from './mvt-write.js';
import { VECTOR_MAX_ZOOM } from './vector-tiles.js';

const OMT_LAYERS = ['landuse', 'landcover', 'park', 'water', 'waterway', 'building', 'transportation', 'place'];
const EXTENT = 4096;
// The 3D map's own tiles are cut with this buffer (postgis-vector.js).
const BUFFER = 192;
const BUDGET = { landuse: 350, parks: 500, 'water-area': 400, 'water-line': 500, buildings: 1800, rail: 400, roads: 2400, places: 150 };
const PATHS = ['pedestrian', 'path', 'footway', 'cycleway', 'steps'];
const ROAD_ORDER = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2 };
const PLACE_ORDER = { city: 0, town: 1 };

const clampLayer = (v) => (Number.isInteger(v) && v >= -99 && v <= 99 ? v : 0);
const nameOf = (p) => (typeof p.name === 'string' && p.name ? p.name.slice(0, 160) : undefined);

// What an OpenMapTiles feature is in the 3D map's layout at zoom z: which of
// its layers (`target`) and the fields its style reads (`props`, where
// `layer` is OSM's stacking of bridges and tunnels); null for what it does
// not draw. Zooms follow the import's query.
export function mapFeature(source, p, type, z) {
  const kind = (target, props, stacked = false) => ({ target, props: {
    ...props,
    bridge: stacked && p.brunnel === 'bridge' ? 1 : 0,
    tunnel: stacked && p.brunnel === 'tunnel' ? 1 : 0,
    layer: stacked ? clampLayer(p.layer) : 0,
    height: props.height || 0,
  } });
  switch (source) {
    case 'transportation': {
      if (type !== LINE) return null;
      const c = p.class;
      const ramp = p.ramp ? '_link' : '';
      if (c === 'rail' || c === 'transit') {
        const sub = p.subclass || c;
        if (z < 11) return null;
        if (['rail', 'narrow_gauge', 'preserved'].includes(sub)) return kind('rail', { class: 'rail' }, true);
        if (sub === 'light_rail' || sub === 'tram') return kind('rail', { class: sub }, true);
        return null;
      }
      let road = null;
      if (c === 'motorway' || c === 'trunk') road = c + ramp;
      else if ((c === 'primary' || c === 'secondary') && z >= 10) road = c + ramp;
      else if (c === 'tertiary' && z >= 12) road = c + ramp;
      else if (c === 'minor' && z >= 12) road = 'residential';
      else if (c === 'service' && z >= 14) road = 'service';
      else if (c === 'track' && z >= 15) road = 'track';
      else if (c === 'path' && z >= 15) road = PATHS.includes(p.subclass) ? p.subclass : 'path';
      return road ? kind('roads', { class: road, name: nameOf(p) }, true) : null;
    }
    case 'water':
      return type === POLYGON ? kind('water', { class: 'area', name: nameOf(p) }) : null;
    case 'waterway':
      if (type !== LINE) return null;
      if ((p.class === 'river' || p.class === 'canal') && z >= 11) return kind('water', { class: p.class, name: nameOf(p) });
      if ((p.class === 'stream' || p.class === 'drain') && z >= 14) return kind('water', { class: p.class, name: nameOf(p) });
      return null;
    case 'landcover':
      if (type !== POLYGON) return null;
      if (p.class === 'wood' || p.class === 'grass') return kind('parks', { class: 'park' });
      if ((p.class === 'rock' || p.class === 'sand') && z >= 10) return kind('landuse', { class: 'terrain' });
      return null;
    case 'park':
      return type === POLYGON ? kind('parks', { class: 'park', name: nameOf(p) }) : null;
    case 'landuse':
      return type === POLYGON && z >= 10 && ['residential', 'commercial', 'industrial', 'retail'].includes(p.class)
        ? kind('landuse', { class: 'urban', name: nameOf(p) }) : null;
    case 'building': {
      if (type !== POLYGON || z < 15) return null;
      const h = Number(p.render_height);
      return kind('buildings', { class: 'building', height: Math.min(350, Math.max(3, Number.isFinite(h) && h > 0 ? h : 6)) });
    }
    case 'place': {
      if (type !== POINT || !nameOf(p)) return null;
      const c = p.class;
      const ok = c === 'city' || c === 'town'
        || (z >= 11 && ['village', 'suburb', 'quarter'].includes(c))
        || (z >= 14 && ['neighbourhood', 'hamlet', 'locality'].includes(c));
      return ok ? kind('places', { class: c, name: nameOf(p) }) : null;
    }
    default:
      return null;
  }
}

// Liang–Barsky: the part of segment a→b inside [lo, hi]², or null.
function clipSegment(a, b, lo, hi) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - lo], [dx, hi - a[0]], [-dy, a[1] - lo], [dy, hi - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return { t0, t1, a: [a[0] + t0 * dx, a[1] + t0 * dy], b: [a[0] + t1 * dx, a[1] + t1 * dy] };
}

export function clipLine(points, lo, hi) {
  const parts = [];
  let part = null;
  for (let i = 1; i < points.length; i++) {
    const seg = clipSegment(points[i - 1], points[i], lo, hi);
    if (!seg) { part = null; continue; }
    // A segment that starts inside carries the part on; one that enters from
    // outside starts a new one.
    if (!part || seg.t0 > 0) { part = [seg.a]; parts.push(part); }
    part.push(seg.b);
    if (seg.t1 < 1) part = null;
  }
  return parts;
}

// Sutherland–Hodgman, one ring against the square: the winding stays, so
// holes stay holes.
export function clipRing(ring, lo, hi) {
  let out = ring.slice();
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  const edges = [
    [(p) => p[0] >= lo, (a, b) => [lo, a[1] + ((b[1] - a[1]) * (lo - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= hi, (a, b) => [hi, a[1] + ((b[1] - a[1]) * (hi - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= lo, (a, b) => [a[0] + ((b[0] - a[0]) * (lo - a[1])) / (b[1] - a[1]), lo]],
    [(p) => p[1] <= hi, (a, b) => [a[0] + ((b[0] - a[0]) * (hi - a[1])) / (b[1] - a[1]), hi]],
  ];
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cross(prev, cur));
    }
    if (!out.length) return [];
  }
  return out;
}

const area = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
};
const whole = (parts) => parts.map((part) => part.map(([x, y]) => [Math.round(x), Math.round(y)]));

// One feature's geometry in the child tile: scaled from its z14 tile, cut to
// the tile and its buffer. [] when nothing of it is left.
function cut(f, scale, ox, oy) {
  const moved = partsOf(f.type, f.geometry).map((part) => (f.type === POINT ? [part] : part)
    .map(([u, v]) => [u * scale - ox, v * scale - oy]));
  if (f.type === POINT) {
    return moved.map((p) => p[0]).filter(([x, y]) => x >= 0 && x < EXTENT && y >= 0 && y < EXTENT).map(([x, y]) => [Math.round(x), Math.round(y)]);
  }
  const lo = -BUFFER;
  const hi = EXTENT + BUFFER;
  if (f.type === LINE) return whole(moved.flatMap((line) => clipLine(line, lo, hi)));
  return whole(moved.map((ring) => clipRing(ring, lo, hi))).filter((ring) => ring.length >= 3 && Math.abs(area(ring)) >= 1);
}

// { tile(z, x, y, layers) } → { raw, gzip, empty: false }, or null when the
// upstream has nothing there or cannot be reached.
export function makeGameVector({ upstream = null, log = console, now = Date.now } = {}) {
  const decoded = new Map();   // "z/x/y" of a source tile → { layers, until }
  const pending = new Map();
  const made = new Map();      // what was written, by tile and layers

  async function load(tile) {
    const got = await upstream.tile(tile);
    if (!got) return { layers: null, keep: 30_000 };
    if (!got.bytes.length) return { layers: {}, keep: 600_000 };
    try {
      const layers = readLayers(got.bytes, OMT_LAYERS);
      // Only what could ever be drawn, each with its bounds (every zoom rule
      // is "from this zoom in", so none at 19 is none at all).
      for (const [name, layer] of Object.entries(layers)) {
        layer.features = layer.features.filter((f) => mapFeature(name, f.properties, f.type, 19));
        for (const f of layer.features) f.bounds = boundsOf(f.geometry);
      }
      return { layers, keep: 600_000 };
    } catch (e) {
      log.error('game map: cannot read a vector tile —', e && e.message ? e.message : e);
      return { layers: {}, keep: 60_000 };
    }
  }

  function source(tile) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const hit = decoded.get(key);
    if (hit && hit.until > now()) return Promise.resolve(hit.layers);
    if (!pending.has(key)) {
      pending.set(key, load(tile).then(({ layers, keep }) => {
        decoded.delete(key);
        if (decoded.size >= 16) decoded.delete(decoded.keys().next().value);
        decoded.set(key, { layers, until: now() + keep });
        return layers;
      }).finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  return {
    async tile(z, x, y, wanted) {
      if (!upstream || !upstream.enabled) return null;
      if (![z, x, y].every(Number.isInteger) || z < 8 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
      const key = `${z}/${x}/${y}|${wanted.join(',')}`;
      const hit = made.get(key);
      if (hit && hit.until > now()) return hit.result;
      const vz = Math.min(z, VECTOR_MAX_ZOOM);
      const d = z - vz;
      const vx = Math.floor(x / 2 ** d);
      const vy = Math.floor(y / 2 ** d);
      const layers = await source({ z: vz, x: vx, y: vy });
      if (!layers) return null;

      const groups = {};
      for (const [name, layer] of Object.entries(layers)) {
        const scale = (EXTENT * 2 ** d) / layer.extent;
        const ox = (x - vx * 2 ** d) * EXTENT;
        const oy = (y - vy * 2 ** d) * EXTENT;
        const reach = (BUFFER + 1) / scale;
        const [lo, hi] = [(ox - BUFFER) / scale, (ox + EXTENT + BUFFER) / scale];
        const [top, bottom] = [(oy - BUFFER) / scale, (oy + EXTENT + BUFFER) / scale];
        for (const f of layer.features) {
          if (d > 0) {
            const [minX, minY, maxX, maxY] = f.bounds;
            if (maxX < lo - reach || minX > hi + reach || maxY < top - reach || minY > bottom + reach) continue;
          }
          const kind = mapFeature(name, f.properties, f.type, z);
          if (!kind || !wanted.includes(kind.target)) continue;
          const group = kind.target === 'water' ? (f.type === POLYGON ? 'water-area' : 'water-line') : kind.target;
          (groups[group] = groups[group] || []).push({ kind, f, scale, ox, oy, extent: layer.extent });
        }
      }
      if (groups.roads) groups.roads.sort((a, b) => (ROAD_ORDER[a.kind.props.class] ?? 3) - (ROAD_ORDER[b.kind.props.class] ?? 3));
      if (groups.places) groups.places.sort((a, b) => (PLACE_ORDER[a.kind.props.class] ?? 2) - (PLACE_ORDER[b.kind.props.class] ?? 2));

      const out = {};
      for (const [group, found] of Object.entries(groups)) {
        let kept = 0;
        for (const { kind, f, scale, ox, oy, extent } of found) {
          if (kept >= BUDGET[group]) break;
          // Its own tile, in the same units: passed through as it is.
          let geometry = f.geometry;
          if (d > 0 || extent !== EXTENT) {
            const parts = cut(f, scale, ox, oy);
            if (!parts.length) continue;
            geometry = commandsOf(f.type, parts);
            if (!geometry.length) continue;
          }
          (out[kind.target] = out[kind.target] || []).push({ type: f.type, properties: kind.props, geometry });
          kept++;
        }
      }
      const names = Object.keys(out);
      let result = null;
      if (names.length) {
        const raw = encodeTile(names.map((name) => ({ name, extent: EXTENT, features: out[name] })));
        result = { raw, gzip: gzipSync(raw), empty: false };
      }
      made.delete(key);
      if (made.size >= 256) made.delete(made.keys().next().value);
      made.set(key, { result, until: now() + (result ? 600_000 : 30_000) });
      return result;
    },
  };
}
