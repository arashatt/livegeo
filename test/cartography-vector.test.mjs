import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { classify, keepable, makeVectorCartography, rowsFor, sourceOf } from '../src/cartography-vector.js';
import { readLayers, boundsOf, LINE, POLYGON, POINT } from '../src/mvt.js';
import { serve } from '../src/server.js';
import { Positions } from '../src/positions.js';
import { encodeTile } from './mvt-encode.mjs';

const quiet = { info() {}, error() {} };

// One z14 vector tile, 4096 units a side. The map tile 15/17250/11506 is its
// top-left quarter; 15/17251/11507 is its bottom-right one.
const VECTOR = { z: 14, x: 8625, y: 5753 };
const TOP_LEFT = { z: 15, x: 17250, y: 11506 };
const BOTTOM_RIGHT = { z: 15, x: 17251, y: 11507 };
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const TILE = encodeTile({
  transportation: { extent: 4096, features: [
    // Corner to corner, through both quarters, with no bend inside either.
    { type: LINE, properties: { class: 'motorway' }, lines: [[[0, 0], [4096, 4096]]] },
    { type: LINE, properties: { class: 'minor' }, lines: [[[100, 1000], [1900, 1000]]] },
    { type: LINE, properties: { class: 'primary', ramp: 1 }, lines: [[[100, 1200], [1900, 1300]]] },
    { type: LINE, properties: { class: 'rail', subclass: 'rail' }, lines: [[[100, 1500], [1900, 1500]]] },
    { type: LINE, properties: { class: 'transit', subclass: 'subway', brunnel: 'tunnel' }, lines: [[[100, 1600], [1900, 1600]]] },
    { type: LINE, properties: { class: 'path', subclass: 'footway' }, lines: [[[100, 1700], [1900, 1700]]] },
  ] },
  water: { extent: 4096, features: [
    // A lake with an island, in the bottom-right quarter only.
    { type: POLYGON, properties: { class: 'lake' }, rings: [square(2400, 2400, 3600, 3600), square(2800, 3200, 3200, 2800)] },
  ] },
  waterway: { extent: 4096, features: [
    { type: LINE, properties: { class: 'stream' }, lines: [[[200, 1800], [1800, 1840]]] },
  ] },
  landcover: { extent: 4096, features: [
    // Woods bigger than the tile: no corner of it inside any quarter.
    { type: POLYGON, properties: { class: 'wood', subclass: 'forest' }, rings: [square(-200, -200, 4300, 4300)] },
    { type: POLYGON, properties: { class: 'farmland' }, rings: [square(0, 0, 500, 500)] },
  ] },
  landuse: { extent: 4096, features: [
    { type: POLYGON, properties: { class: 'residential' }, rings: [square(100, 100, 1900, 900)] },
    { type: POLYGON, properties: { class: 'school' }, rings: [square(200, 200, 300, 300)] },
  ] },
  park: { extent: 4096, features: [
    { type: POLYGON, properties: { class: 'nature_reserve' }, rings: [square(2200, 200, 3000, 900)] },
    { type: POINT, properties: { class: 'nature_reserve', name: 'A label' }, points: [[2600, 500]] },
  ] },
  building: { extent: 4096, features: [
    { type: POLYGON, properties: { render_height: 12 }, rings: [square(400, 400, 440, 440)] },
  ] },
  place: { extent: 4096, features: [{ type: POINT, properties: { class: 'town', name: 'Vaduz' }, points: [[1000, 1000]] }] },
});

const groups = (svg) => Object.fromEntries([...svg.matchAll(/<g data-layer="([a-z]+)">(.*?)<\/g>/g)]
  .map(([, name, body]) => [name, [...body.matchAll(/<path d="([^"]*)"([^/]*)\/>/g)].map(([, d, attrs]) => ({ d, attrs }))]));

// An upstream with that one tile, and nothing anywhere else.
function upstreamOf(bytes = TILE) {
  const asked = [];
  return { asked, upstream: { enabled: true, tile: async (t) => {
    const key = `${t.z}/${t.x}/${t.y}`;
    asked.push(key);
    if (bytes === null) return null;
    return { bytes: key === '14/8625/5753' ? bytes : Buffer.alloc(0), from: 'upstream' };
  } } };
}

test('a map tile is a quarter of the vector tile one zoom out, and a smaller piece past its deepest', () => {
  assert.deepEqual(sourceOf(TOP_LEFT), { tile: VECTOR, d: 1, ox: 0, oy: 0 });
  assert.deepEqual(sourceOf(BOTTOM_RIGHT), { tile: VECTOR, d: 1, ox: 1, oy: 1 });
  assert.deepEqual(sourceOf({ z: 8, x: 134, y: 89 }), { tile: { z: 7, x: 67, y: 44 }, d: 1, ox: 0, oy: 1 });
  // Zoom 18 draws from z14 too: a sixteenth of it each way.
  assert.deepEqual(sourceOf({ z: 18, x: 8625 * 16 + 5, y: 5753 * 16 + 15 }), { tile: VECTOR, d: 4, ox: 5, oy: 15 });
});

test('OpenMapTiles classes map onto the six features, at the zooms the import uses', () => {
  const at = (layer, p, type, zoom) => classify(layer, p, type, zoom);
  assert.deepEqual(at('transportation', { class: 'motorway' }, LINE, 8), { layer: 'roads', subtype: 'motorway' });
  assert.deepEqual(at('transportation', { class: 'trunk', ramp: 1 }, LINE, 9), { layer: 'roads', subtype: 'trunk_link' });
  assert.equal(at('transportation', { class: 'primary' }, LINE, 9), null);
  assert.deepEqual(at('transportation', { class: 'primary' }, LINE, 10), { layer: 'roads', subtype: 'primary' });
  assert.equal(at('transportation', { class: 'tertiary' }, LINE, 11), null);
  assert.equal(at('transportation', { class: 'minor' }, LINE, 11), null);
  assert.deepEqual(at('transportation', { class: 'minor' }, LINE, 12), { layer: 'roads', subtype: 'residential' });
  assert.equal(at('transportation', { class: 'service' }, LINE, 13), null);
  assert.deepEqual(at('transportation', { class: 'service' }, LINE, 14), { layer: 'roads', subtype: 'service' });
  assert.equal(at('transportation', { class: 'path', subclass: 'footway' }, LINE, 14), null);
  assert.deepEqual(at('transportation', { class: 'path', subclass: 'footway' }, LINE, 15), { layer: 'roads', subtype: 'footway' });
  assert.deepEqual(at('transportation', { class: 'path', subclass: 'corridor' }, LINE, 15), { layer: 'roads', subtype: 'path' });
  assert.equal(at('transportation', { class: 'track' }, LINE, 14), null);
  assert.deepEqual(at('transportation', { class: 'track' }, LINE, 15), { layer: 'roads', subtype: 'track' });
  assert.equal(at('transportation', { class: 'ferry' }, LINE, 15), null);
  assert.equal(at('transportation', { class: 'rail', subclass: 'rail' }, LINE, 10), null);
  assert.deepEqual(at('transportation', { class: 'rail', subclass: 'rail' }, LINE, 11), { layer: 'rail', subtype: 'rail' });
  assert.deepEqual(at('transportation', { class: 'transit', subclass: 'tram' }, LINE, 13), { layer: 'rail', subtype: 'tram' });
  assert.equal(at('transportation', { class: 'transit', subclass: 'subway' }, LINE, 13), null, 'underground');
  assert.equal(at('transportation', { class: 'motorway' }, POLYGON, 13), null, 'an area road is not a line');
  assert.deepEqual(at('water', { class: 'ocean' }, POLYGON, 8), { layer: 'water', subtype: 'area' });
  assert.equal(at('waterway', { class: 'river' }, LINE, 10), null);
  assert.deepEqual(at('waterway', { class: 'canal' }, LINE, 11), { layer: 'water', subtype: 'canal' });
  assert.equal(at('waterway', { class: 'stream' }, LINE, 13), null);
  assert.deepEqual(at('waterway', { class: 'stream' }, LINE, 14), { layer: 'water', subtype: 'stream' });
  assert.deepEqual(at('landcover', { class: 'grass', subclass: 'park' }, POLYGON, 8), { layer: 'parks', subtype: '' });
  assert.deepEqual(at('landcover', { class: 'wood' }, POLYGON, 8), { layer: 'parks', subtype: '' });
  assert.equal(at('landcover', { class: 'rock' }, POLYGON, 9), null);
  assert.deepEqual(at('landcover', { class: 'sand' }, POLYGON, 10), { layer: 'landuse', subtype: 'terrain' });
  assert.equal(at('landcover', { class: 'farmland' }, POLYGON, 14), null);
  assert.deepEqual(at('park', { class: 'national_park' }, POLYGON, 8), { layer: 'parks', subtype: '' });
  assert.equal(at('park', { class: 'national_park' }, POINT, 8), null, 'a label point is not an area');
  assert.equal(at('landuse', { class: 'residential' }, POLYGON, 9), null);
  assert.deepEqual(at('landuse', { class: 'retail' }, POLYGON, 10), { layer: 'landuse', subtype: 'urban' });
  assert.equal(at('landuse', { class: 'cemetery' }, POLYGON, 14), null);
  assert.equal(at('building', {}, POLYGON, 14), null);
  assert.deepEqual(at('building', {}, POLYGON, 15), { layer: 'buildings', subtype: '' });
  assert.equal(at('place', { class: 'town' }, POINT, 15), null);
});

test('a vector tile is kept as only what could ever be drawn, each feature with its bounds', () => {
  const kept = keepable(readLayers(TILE, ['transportation', 'water', 'waterway', 'landcover', 'landuse', 'park', 'building', 'place']));
  assert.equal(kept.place, undefined, 'names are not drawn');
  assert.equal(kept.transportation.features.length, 5, 'not the subway');
  assert.equal(kept.landcover.features.length, 1, 'not the farmland');
  assert.equal(kept.landuse.features.length, 1, 'not the school');
  assert.equal(kept.park.features.length, 1, 'not the label point');
  assert.deepEqual(kept.water.features[0].bounds, [2400, 2400, 3600, 3600]);
  assert.deepEqual(kept.transportation.features[0].bounds, [0, 0, 4096, 4096]);
  assert.deepEqual(boundsOf([]), [Infinity, Infinity, -Infinity, -Infinity]);
});

test('each quarter gets what reaches it, placed and drawn as the import would draw it', async () => {
  const { upstream } = upstreamOf();
  const carto = makeVectorCartography({ upstream, log: quiet });

  const top = groups(await carto.tile(TOP_LEFT.z, TOP_LEFT.x, TOP_LEFT.y));
  assert.deepEqual(Object.keys(top), ['landuse', 'parks', 'water', 'buildings', 'rail', 'roads']);
  // The motorway crosses the whole tile: from its corner out past the far one.
  // Y is written negated, as ST_AsSVG writes it; the renderer flips it back.
  assert.ok(top.roads.some((p) => p.d === 'M0 0 L512 -512' && /#ec64ac/.test(p.attrs)), JSON.stringify(top.roads.slice(0, 3)));
  assert.ok(top.roads.some((p) => p.d === 'M13 -125 L238 -125'), 'the minor road, in whole pixels as the import draws');
  assert.ok(top.roads.some((p) => /stroke-dasharray="2 3"/.test(p.attrs)), 'a footway, dashed');
  assert.equal(top.rail.length, 1, 'the railway, not the subway');
  assert.equal(top.buildings.length, 1);
  assert.equal(top.landuse.length, 1, 'residential, not the school');
  assert.ok(top.parks.some((p) => p.d.startsWith('M-25 25')), 'the woods, though no corner of them is inside');
  assert.equal(top.parks.length, 1, 'not the reserve, which is in the other half; not farmland');
  assert.deepEqual(top.water.map((p) => p.d), ['M25 -225 L225 -230'], 'the stream, not the lake');

  const bottom = groups(await carto.tile(BOTTOM_RIGHT.z, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y));
  assert.ok(bottom.roads.some((p) => p.d === 'M-256 256 L256 -256'), 'the same motorway, from the other quarter');
  assert.equal(bottom.buildings, undefined);
  assert.deepEqual(bottom.water.map((p) => p.d), ['M44 -44 L194 -44 L194 -194 L44 -194 Z M94 -144 L144 -144 L144 -94 L94 -94 Z']);
  assert.match(bottom.water[0].attrs, /fill-rule="evenodd"/, 'so the island is a hole');
});

test('the layers asked for are the only ones drawn; zooms and budgets hold', async () => {
  const { upstream } = upstreamOf();
  const carto = makeVectorCartography({ upstream, log: quiet });
  assert.deepEqual(Object.keys(groups(await carto.tile(TOP_LEFT.z, TOP_LEFT.x, TOP_LEFT.y, ['water', 'roads']))), ['water', 'roads']);
  assert.deepEqual(Object.keys(groups(await carto.tile(TOP_LEFT.z, TOP_LEFT.x, TOP_LEFT.y, ['buildings']))), ['buildings']);

  // 3000 streets and one motorway, last in the tile: the motorway is kept.
  const busy = encodeTile({ transportation: { extent: 4096, features: [
    ...Array.from({ length: 3000 }, (_, i) => ({ type: LINE, properties: { class: 'minor' }, lines: [[[10, i % 2000], [20, i % 2000]]] })),
    { type: LINE, properties: { class: 'motorway' }, lines: [[[0, 5], [2000, 5]]] },
  ] } });
  const rows = rowsFor(readLayers(busy, ['transportation']), 15, sourceOf(TOP_LEFT));
  assert.equal(rows.length, 2400);
  assert.equal(rows[0].subtype, 'motorway');

  // Overzoomed: the same z14 tile, a sixteenth of it, at one unit a pixel.
  const deep = { z: 18, x: 8625 * 16, y: 5753 * 16 };
  const svg = groups(await makeVectorCartography({ upstream, log: quiet }).tile(deep.z, deep.x, deep.y));
  assert.ok(svg.roads.some((p) => p.d === 'M0 0 L4096 -4096'));
  assert.equal(svg.water, undefined, 'the stream and the lake are elsewhere');
});

test('one vector tile is read once for all its quarters, and kept', async () => {
  let clock = 0;
  const { asked, upstream } = upstreamOf();
  const carto = makeVectorCartography({ upstream, log: quiet, now: () => clock });
  const quarters = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => carto.tile(15, TOP_LEFT.x + dx, TOP_LEFT.y + dy));
  assert.ok((await Promise.all(quarters)).every((svg) => /<svg/.test(svg)));
  assert.deepEqual(asked, ['14/8625/5753']);
  await carto.tile(15, TOP_LEFT.x, TOP_LEFT.y, ['roads']);
  assert.equal(asked.length, 1, 'switching a layer does not fetch again');
  clock = 600_001;
  await carto.tile(15, TOP_LEFT.x, TOP_LEFT.y);
  assert.equal(asked.length, 2, 'kept ten minutes');
});

test('nothing to draw is null: no upstream, no answer, an empty or broken tile, a zoom out of range', async () => {
  let clock = 0;
  const none = upstreamOf(null);
  const carto = makeVectorCartography({ upstream: none.upstream, log: quiet, now: () => clock });
  assert.equal(await carto.tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  assert.equal(await carto.tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  assert.equal(none.asked.length, 1, 'no answer is asked again, but not at once');
  clock = 30_001;
  await carto.tile(15, TOP_LEFT.x, TOP_LEFT.y);
  assert.equal(none.asked.length, 2);
  assert.equal(await makeVectorCartography({ upstream: upstreamOf(Buffer.alloc(0)).upstream, log: quiet }).tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  const errors = [];
  const broken = makeVectorCartography({ upstream: upstreamOf(Buffer.from('not a tile')).upstream, log: { error: (...a) => errors.push(a.join(' ')) } });
  assert.equal(await broken.tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  assert.equal(errors.length, 1);
  const huge = makeVectorCartography({ upstream: upstreamOf(Buffer.alloc(9 * 1024 * 1024)).upstream, log: { error: (...a) => errors.push(a.join(' ')) } });
  assert.equal(await huge.tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  assert.match(errors.at(-1), /too big/);
  const off = { enabled: false, tile: async () => assert.fail('asked a disabled upstream') };
  assert.equal(await makeVectorCartography({ upstream: off }).tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  assert.equal(await makeVectorCartography().tile(15, TOP_LEFT.x, TOP_LEFT.y), null);
  const { upstream } = upstreamOf();
  const fine = makeVectorCartography({ upstream, log: quiet });
  for (const [z, x, y] of [[7, 0, 0], [20, 0, 0], [15, -1, 0], [15, 2 ** 15, 0], [15, 1.5, 0]]) {
    assert.equal(await fine.tile(z, x, y), null, `${z}/${x}/${y}`);
  }
  assert.equal(await fine.tile(15, TOP_LEFT.x, TOP_LEFT.y, []), null);
});

test('/carto: the import first, the vector tiles where it has nothing, empty with neither', async () => {
  let local = null;
  const geo = { cartographyTile: async () => local };
  const { asked, upstream } = upstreamOf();
  const { server } = serve(new Positions(), { dashboardToken: 'test', port: 0, host: '127.0.0.1' }, { geo, vectorTiles: upstream, log: quiet });
  await once(server, 'listening');
  const url = (t, q = '') => `http://127.0.0.1:${server.address().port}/carto/${t.z}/${t.x}/${t.y}.svg?token=test${q}`;
  try {
    assert.equal((await fetch(url(TOP_LEFT).replace('?token=test', ''))).status, 401);
    const drawn = await fetch(url(TOP_LEFT));
    assert.equal(drawn.headers.get('x-carto-source'), 'upstream');
    assert.equal(drawn.headers.get('cache-control'), 'private, max-age=3600');
    assert.match(await drawn.text(), /data-layer="roads"/);
    const some = await (await fetch(url(TOP_LEFT, '&layers=water'))).text();
    assert.match(some, /data-layer="water"/);
    assert.doesNotMatch(some, /data-layer="roads"/);
    local = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const before = asked.length;
    const imported = await fetch(url({ z: 15, x: 2, y: 2 }));
    assert.equal(imported.headers.get('x-carto-source'), 'postgis');
    assert.equal(asked.length, before, 'the upstream is not asked where the import answers');
    local = null;
    const nothing = await fetch(url({ z: 15, x: 0, y: 0 }));
    assert.equal(nothing.headers.get('x-carto-source'), 'empty', 'an ocean tile with nothing on it');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
