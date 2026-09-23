import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { CARTOGRAPHY_LAYERS, makeCartography, parseCartographyLayers, renderCartography } from '../src/cartography.js';
import { parseCartoPath } from '../src/tile-path.js';
import { serve } from '../src/server.js';
import { Positions } from '../src/positions.js';

const quiet = { info() {}, error() {} };
// ST_AsSVG negates the Y-down coordinates produced by ST_AsMVTGeom.
const road = { layer: 'roads', subtype: 'primary', d: 'M 0 -128 L 256 -128' };
const water = { layer: 'water', subtype: 'area', d: 'M 20 -20 L 70 -20 70 -70 20 -70 Z' };

test('cartographic tile coordinates are constrained to the world', () => {
  assert.deepEqual(parseCartoPath('/carto/8/200/110.svg'), { z: 8, x: 200, y: 110 });
  for (const path of ['/carto/8/256/0.svg', '/carto/20/0/0.svg', '/carto/-1/0/0.svg', '/carto/../../x.svg']) {
    assert.equal(parseCartoPath(path), null);
  }
});

test('feature selections distinguish default, empty and invalid requests', () => {
  assert.deepEqual(parseCartographyLayers(null), CARTOGRAPHY_LAYERS);
  assert.deepEqual(parseCartographyLayers('roads,water,roads'), ['water', 'roads']);
  assert.deepEqual(parseCartographyLayers(''), []);
  assert.equal(parseCartographyLayers('roads,unknown'), null);
  assert.equal(parseCartographyLayers('<script>'), null);
});

test('selected features render with corrected coordinates and roads above land', () => {
  const svg = renderCartography([road, water], 15);
  assert.match(svg, /transform="scale\(1,-1\)"/);
  assert.ok(svg.indexOf('data-layer="water"') < svg.indexOf('data-layer="roads"'));
  assert.match(svg, /fill-rule="evenodd"/); // lakes retain islands / polygon holes
  const roads = renderCartography([road, water], 15, ['roads']);
  assert.doesNotMatch(roads, /data-layer="water"/);
  assert.match(roads, /data-layer="roads"/);
  assert.equal(renderCartography([road], 15, ['water']), null);
  assert.equal(renderCartography([], 15), null);
});

test('feature data cannot inject attributes or markup into an SVG', () => {
  const svg = renderCartography([{ ...water, d: 'M 0 0"/><script>alert(1)</script>' }], 15);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&quot;/);
});

test('simultaneous layer combinations share geometry and expire after an import', async () => {
  let calls = 0;
  let clock = 0;
  const carto = makeCartography({ log: quiet, now: () => clock, query: async () => {
    calls++;
    return { rows: [road, water] };
  } });
  const [roads, waterOnly] = await Promise.all([
    carto.tile(15, 100, 100, ['roads']), carto.tile(15, 100, 100, ['water']),
  ]);
  assert.equal(calls, 1);
  assert.doesNotMatch(roads, /data-layer="water"/);
  assert.doesNotMatch(waterOnly, /data-layer="roads"/);
  clock = 300_001;
  await carto.tile(15, 100, 100);
  assert.equal(calls, 2);
});

test('missing OSM tables recover without restarting the app', async () => {
  let calls = 0;
  let clock = 0;
  const carto = makeCartography({ log: quiet, now: () => clock, query: async () => {
    if (++calls === 1) throw Object.assign(new Error('missing table'), { code: '42P01' });
    return { rows: [road] };
  } });
  assert.equal(await carto.tile(15, 100, 100), null);
  assert.equal(await carto.tile(15, 100, 100), null);
  assert.equal(calls, 1);
  clock = 60_001;
  assert.match(await carto.tile(15, 100, 100), /data-layer="roads"/);
  assert.equal(calls, 2);
});

test('world views, disabled features and invalid coordinates do not query PostGIS', async () => {
  const carto = makeCartography({ query: () => { assert.fail('unexpected database query'); } });
  for (const args of [[3, 4, 2], [20, 0, 0], [8, 256, 0], [8, 0, -1], [8, .5, 0], [8, 1, 1, []]]) {
    assert.equal(await carto.tile(...args), null);
  }
});

test('the tile endpoint enforces authentication, selections and transparent fallback', async () => {
  let selected;
  let available = true;
  const geo = { cartographyTile: async (z, x, y, layers) => {
    selected = layers;
    return available ? renderCartography([road, water], z, layers) : null;
  } };
  const { server } = serve(new Positions(), { dashboardToken: 'test', port: 0, host: '127.0.0.1' }, { geo, log: quiet });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/carto/15/100/100.svg`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal(selected, undefined);
    const response = await fetch(`${base}?token=test&layers=roads`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
    assert.equal(response.headers.get('x-carto-source'), 'postgis');
    assert.deepEqual(selected, ['roads']);
    assert.doesNotMatch(await response.text(), /data-layer="water"/);
    assert.equal((await fetch(`${base}?token=test&layers=invalid`)).status, 400);
    available = false;
    const empty = await fetch(`${base}?token=test`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('x-carto-source'), 'empty');
    assert.doesNotMatch(await empty.text(), /<path|<rect/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
