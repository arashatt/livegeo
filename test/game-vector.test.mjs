import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { clipLine, clipRing, makeGameVector, mapFeature } from '../src/game-vector.js';
import { commandsOf, encodeTile as writeTile } from '../src/mvt-write.js';
import { readLayers, LINE, POLYGON, POINT } from '../src/mvt.js';
import { serve } from '../src/server.js';
import { Positions } from '../src/positions.js';
import { encodeTile } from './mvt-encode.mjs';

const quiet = { info() {}, error() {} };
// An independent reader: Mapbox's own. pbf reads through the whole backing
// ArrayBuffer, so it is given a copy of its own.
const read = (bytes) => new VectorTile(new Pbf(new Uint8Array(bytes)));
const all = (layer) => Array.from({ length: layer ? layer.length : 0 }, (_, i) => layer.feature(i));
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// One z14 tile in the OpenMapTiles layout.
const Z14 = { z: 14, x: 8625, y: 5753 };
const OMT = encodeTile({
  transportation: { extent: 4096, features: [
    { type: LINE, properties: { class: 'motorway', brunnel: 'bridge', layer: 1 }, lines: [[[0, 0], [4096, 4096]]] },
    { type: LINE, properties: { class: 'minor' }, lines: [[[100, 1000], [1900, 1000]]] },
    { type: LINE, properties: { class: 'path', subclass: 'footway' }, lines: [[[100, 1700], [1900, 1700]]] },
    { type: LINE, properties: { class: 'transit', subclass: 'subway', brunnel: 'tunnel' }, lines: [[[100, 1600], [1900, 1600]]] },
    { type: LINE, properties: { class: 'rail', subclass: 'rail', brunnel: 'tunnel', layer: -1 }, lines: [[[100, 1500], [1900, 1500]]] },
  ] },
  water: { extent: 4096, features: [
    { type: POLYGON, properties: { class: 'lake', name: 'Seelein' }, rings: [square(2400, 2400, 3600, 3600), square(2800, 3200, 3200, 2800)] },
  ] },
  landcover: { extent: 4096, features: [
    { type: POLYGON, properties: { class: 'wood' }, rings: [square(-100, -100, 4200, 4200)] },
    { type: POLYGON, properties: { class: 'farmland' }, rings: [square(0, 0, 500, 500)] },
  ] },
  building: { extent: 4096, features: [
    { type: POLYGON, properties: { render_height: 13.5 }, rings: [square(400, 400, 440, 440)] },
    { type: POLYGON, properties: {}, rings: [square(500, 500, 540, 540)] },
  ] },
  place: { extent: 4096, features: [
    { type: POINT, properties: { class: 'town', name: 'Vaduz' }, points: [[1000, 1000]] },
    { type: POINT, properties: { class: 'hamlet', name: 'Masescha' }, points: [[3000, 1000]] },
  ] },
});

function upstreamOf(bytes = OMT) {
  const asked = [];
  return { asked, upstream: { enabled: true, tile: async (t) => {
    const key = `${t.z}/${t.x}/${t.y}`;
    asked.push(key);
    if (bytes === null) return null;
    return { bytes: key === '14/8625/5753' ? bytes : Buffer.alloc(0), from: 'upstream' };
  } } };
}
const ALL = ['landuse', 'parks', 'water', 'buildings', 'rail', 'roads', 'places'];

test('OpenMapTiles features become the 3D map\'s layers and fields, at its zooms', () => {
  assert.deepEqual(mapFeature('transportation', { class: 'motorway', ramp: 1, brunnel: 'bridge', layer: 2 }, LINE, 9),
    { target: 'roads', props: { class: 'motorway_link', name: undefined, bridge: 1, tunnel: 0, layer: 2, height: 0 } });
  assert.equal(mapFeature('transportation', { class: 'primary' }, LINE, 9), null);
  assert.equal(mapFeature('transportation', { class: 'minor' }, LINE, 11), null);
  assert.equal(mapFeature('transportation', { class: 'minor' }, LINE, 12).props.class, 'residential');
  assert.equal(mapFeature('transportation', { class: 'service' }, LINE, 13), null);
  assert.equal(mapFeature('transportation', { class: 'path', subclass: 'cycleway' }, LINE, 15).props.class, 'cycleway');
  assert.equal(mapFeature('transportation', { class: 'path', subclass: 'corridor' }, LINE, 15).props.class, 'path');
  assert.deepEqual(mapFeature('transportation', { class: 'rail', subclass: 'rail', brunnel: 'tunnel', layer: -1 }, LINE, 11),
    { target: 'rail', props: { class: 'rail', bridge: 0, tunnel: 1, layer: -1, height: 0 } });
  assert.equal(mapFeature('transportation', { class: 'transit', subclass: 'subway' }, LINE, 15), null);
  assert.equal(mapFeature('transportation', { class: 'transit', subclass: 'tram' }, LINE, 13).props.class, 'tram');
  assert.equal(mapFeature('transportation', { class: 'ferry' }, LINE, 15), null);
  assert.equal(mapFeature('transportation', { class: 'motorway', layer: 400 }, LINE, 9).props.layer, 0, 'nonsense stacking is flat');
  assert.deepEqual(mapFeature('water', { class: 'ocean' }, POLYGON, 8), { target: 'water', props: { class: 'area', name: undefined, bridge: 0, tunnel: 0, layer: 0, height: 0 } });
  assert.equal(mapFeature('waterway', { class: 'stream' }, LINE, 13), null);
  assert.equal(mapFeature('waterway', { class: 'stream' }, LINE, 14).props.class, 'stream');
  assert.equal(mapFeature('landcover', { class: 'grass', subclass: 'park' }, POLYGON, 8).props.class, 'park');
  assert.equal(mapFeature('landcover', { class: 'sand' }, POLYGON, 9), null);
  assert.equal(mapFeature('landcover', { class: 'sand' }, POLYGON, 10).props.class, 'terrain');
  assert.equal(mapFeature('landcover', { class: 'farmland' }, POLYGON, 14), null);
  assert.equal(mapFeature('landuse', { class: 'retail' }, POLYGON, 10).props.class, 'urban');
  assert.equal(mapFeature('landuse', { class: 'school' }, POLYGON, 14), null);
  assert.equal(mapFeature('building', {}, POLYGON, 14), null);
  assert.equal(mapFeature('building', { render_height: 13.5 }, POLYGON, 15).props.height, 13.5);
  assert.equal(mapFeature('building', {}, POLYGON, 15).props.height, 6, 'illustrative where OSM has none');
  assert.equal(mapFeature('building', { render_height: 900 }, POLYGON, 15).props.height, 350);
  assert.equal(mapFeature('place', { class: 'town', name: 'Vaduz' }, POINT, 8).props.name, 'Vaduz');
  assert.equal(mapFeature('place', { class: 'village', name: 'x' }, POINT, 10), null);
  assert.equal(mapFeature('place', { class: 'hamlet', name: 'x' }, POINT, 13), null);
  assert.equal(mapFeature('place', { class: 'hamlet', name: 'x' }, POINT, 14).props.class, 'hamlet');
  assert.equal(mapFeature('place', { class: 'town' }, POINT, 14), null, 'a place without a name draws nothing');
  assert.equal(mapFeature('place', { class: 'town', name: 'x'.repeat(300) }, POINT, 14).props.name.length, 160);
});

test('clipping keeps what is inside, and a polygon keeps its winding', () => {
  assert.deepEqual(clipLine([[-10, 5], [20, 5]], 0, 10), [[[0, 5], [10, 5]]]);
  assert.deepEqual(clipLine([[1, 1], [5, 5], [20, 5], [20, 20], [5, 8], [2, 8]], 0, 10), [[[1, 1], [5, 5], [10, 5]], [[7.5, 10], [5, 8], [2, 8]]]);
  assert.deepEqual(clipLine([[20, 20], [30, 30]], 0, 10), []);
  const ring = clipRing(square(-5, -5, 15, 15), 0, 10);
  assert.deepEqual(ring.map(([x, y]) => `${x},${y}`).sort(), ['0,0', '0,10', '10,0', '10,10']);
  assert.deepEqual(clipRing(square(20, 20, 30, 30), 0, 10), []);
  // A triangle cut across keeps the same turning direction.
  const tri = [[0, 0], [20, 0], [0, 20]];
  const cut = clipRing(tri, 0, 10);
  const signed = (r) => r.reduce((s, [x1, y1], i) => { const [x2, y2] = r[(i + 1) % r.length]; return s + x1 * y2 - x2 * y1; }, 0);
  assert.equal(Math.sign(signed(cut)), Math.sign(signed(tri)));
  assert.deepEqual(commandsOf(LINE, [[[1, 1], [1, 1], [3, 1]]]), [9, 2, 2, 10, 4, 0], 'a repeated point is dropped');
});

test('up to z14 the tile is the upstream\'s own geometry, with the 3D map\'s fields', async () => {
  const { upstream } = upstreamOf();
  const tile = await makeGameVector({ upstream, log: quiet }).tile(14, Z14.x, Z14.y, ALL);
  assert.deepEqual(gunzipSync(tile.gzip), tile.raw);
  const vt = read(tile.raw);
  assert.deepEqual(Object.keys(vt.layers).sort(), ['parks', 'places', 'rail', 'roads', 'water']);
  const roads = all(vt.layers.roads);
  assert.deepEqual(roads.map((f) => f.properties.class), ['motorway', 'residential'], 'no footway before z15; motorway first');
  assert.deepEqual(roads[0].properties, { class: 'motorway', bridge: 1, tunnel: 0, layer: 1, height: 0 });
  assert.deepEqual(roads[0].loadGeometry().map((l) => l.map((p) => [p.x, p.y])), [[[0, 0], [4096, 4096]]]);
  assert.deepEqual(all(vt.layers.rail).map((f) => f.properties), [{ class: 'rail', bridge: 0, tunnel: 1, layer: -1, height: 0 }]);
  const lake = all(vt.layers.water)[0];
  assert.equal(lake.properties.name, 'Seelein');
  assert.equal(lake.loadGeometry().length, 2, 'the island is still a hole');
  assert.deepEqual(all(vt.layers.places).map((f) => f.properties.name), ['Vaduz', 'Masescha']);
  assert.equal(vt.layers.buildings, undefined, 'buildings from z15, as the import');
  // Its own reader agrees.
  const ours = readLayers(tile.raw, ['roads']);
  assert.equal(ours.roads.features.length, 2);
});

test('past z14 a tile is cut from its z14 tile: scaled, clipped, and only what reaches it', async () => {
  const { upstream } = upstreamOf();
  const game = makeGameVector({ upstream, log: quiet });
  // z15, top-left quarter: twice the scale.
  const q = read((await game.tile(15, Z14.x * 2, Z14.y * 2, ALL)).raw);
  const motorway = all(q.layers.roads).find((f) => f.properties.class === 'motorway');
  const line = motorway.loadGeometry()[0].map((p) => [p.x, p.y]);
  assert.deepEqual(line[0], [0, 0]);
  assert.deepEqual(line.at(-1), [4288, 4288], 'cut at the tile and its buffer, not left at 8192');
  assert.ok(all(q.layers.roads).some((f) => f.properties.class === 'footway'), 'paths from z15');
  const heights = all(q.layers.buildings).map((f) => f.properties.height).sort();
  assert.deepEqual(heights, [13.5, 6]);
  const wood = all(q.layers.parks)[0].loadGeometry()[0].map((p) => [p.x, p.y]);
  assert.ok(wood.every(([x, y]) => x >= -192 && x <= 4288 && y >= -192 && y <= 4288), JSON.stringify(wood));
  assert.equal(q.layers.water, undefined, 'the lake is in another quarter');
  assert.deepEqual(all(q.layers.places).map((f) => f.properties.name), ['Vaduz'], 'a place is in one tile only');
  // z16, the lake's quarter of a quarter: its island a hole still.
  const lakeTile = read((await game.tile(16, Z14.x * 4 + 2, Z14.y * 4 + 3, ['water'])).raw);
  const rings = all(lakeTile.layers.water)[0].loadGeometry();
  assert.equal(rings.length, 2);
  assert.deepEqual(Object.keys(lakeTile.layers), ['water'], 'only the layers asked for');
  // z19, deep in the woods: just the woods.
  const deep = read((await game.tile(19, Z14.x * 32 + 31, Z14.y * 32 + 3, ALL)).raw);
  assert.deepEqual(Object.keys(deep.layers), ['parks']);
  assert.ok(all(deep.layers.parks)[0].loadGeometry()[0].every((p) => p.x >= -192 && p.x <= 4288));
});

test('budgets hold, with the biggest roads kept; each source tile is read once and kept', async () => {
  const busy = encodeTile({ transportation: { extent: 4096, features: [
    ...Array.from({ length: 3000 }, (_, i) => ({ type: LINE, properties: { class: 'minor' }, lines: [[[10, i % 2000], [20, i % 2000]]] })),
    { type: LINE, properties: { class: 'trunk' }, lines: [[[0, 5], [2000, 5]]] },
  ] } });
  const { upstream, asked } = upstreamOf(busy);
  let clock = 0;
  const game = makeGameVector({ upstream, log: quiet, now: () => clock });
  const roads = all(read((await game.tile(14, Z14.x, Z14.y, ALL)).raw).layers.roads);
  assert.equal(roads.length, 2400);
  assert.equal(roads[0].properties.class, 'trunk');
  await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => game.tile(15, Z14.x * 2 + dx, Z14.y * 2 + dy, ALL)));
  assert.deepEqual(asked, ['14/8625/5753'], 'one fetch for the tile and all its children');
  await game.tile(14, Z14.x, Z14.y, ALL);
  assert.equal(asked.length, 1);
  clock = 600_001;
  await game.tile(15, Z14.x * 2, Z14.y * 2, ALL);
  assert.equal(asked.length, 2, 'kept ten minutes');
});

test('nothing there, no answer, no upstream or a bad tile number: null', async () => {
  assert.equal(await makeGameVector({ upstream: upstreamOf(null).upstream, log: quiet }).tile(14, Z14.x, Z14.y, ALL), null);
  assert.equal(await makeGameVector({ upstream: upstreamOf().upstream, log: quiet }).tile(14, 0, 0, ALL), null);
  assert.equal(await makeGameVector({ upstream: { enabled: false, tile: async () => assert.fail('asked') } }).tile(14, Z14.x, Z14.y, ALL), null);
  assert.equal(await makeGameVector().tile(14, Z14.x, Z14.y, ALL), null);
  const game = makeGameVector({ upstream: upstreamOf().upstream, log: quiet });
  for (const [z, x, y] of [[7, 0, 0], [20, 0, 0], [14, -1, 0], [14, 2 ** 14, 0]]) assert.equal(await game.tile(z, x, y, ALL), null);
  const errors = [];
  const broken = makeGameVector({ upstream: upstreamOf(Buffer.from('not a tile')).upstream, log: { error: (...a) => errors.push(a.join(' ')) } });
  assert.equal(await broken.tile(14, Z14.x, Z14.y, ALL), null);
  assert.equal(errors.length, 1);
  // The writer round-trips through its own reader and Mapbox's.
  const raw = writeTile([{ name: 'x', extent: 4096, features: [{ type: POINT, properties: { a: 'b', n: -3, f: 1.25, t: true, skip: null }, geometry: [9, 2, 2] }] }]);
  assert.deepEqual(read(raw).layers.x.feature(0).properties, { a: 'b', n: -3, f: 1.25, t: true });
});

test('/carto/…mvt: the import first, the upstream where it has nothing, gzipped when asked', async () => {
  const { upstream } = upstreamOf();
  const geo = { vectorTile: async () => null };
  const { server } = serve(new Positions(), { dashboardToken: 'test', port: 0, host: '127.0.0.1' }, { geo, vectorTiles: upstream, log: quiet });
  await once(server, 'listening');
  const url = (t) => `http://127.0.0.1:${server.address().port}/carto/${t}.mvt?token=test`;
  try {
    assert.equal((await fetch(url('14/8625/5753').replace('?token=test', ''))).status, 401);
    const res = await fetch(url('14/8625/5753'), { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-carto-source'), 'upstream');
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
    assert.ok(read(Buffer.from(await res.arrayBuffer())).layers.roads);
    const some = await fetch(`${url('15/17250/11506')}&layers=roads`);
    assert.deepEqual(Object.keys(read(Buffer.from(await some.arrayBuffer())).layers), ['roads']);
    const nothing = await fetch(url('14/0/0'));
    assert.equal(nothing.headers.get('x-carto-source'), 'empty');
    assert.equal((await nothing.arrayBuffer()).byteLength, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
