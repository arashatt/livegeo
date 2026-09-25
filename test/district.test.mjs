import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLayer, decodeTile, partsOf, LINE } from '../src/mvt.js';
import {
  makeDistrict, makePlacesPostgis, placesInTile, placesFromRows, placeSql,
  pickDistrict, tilesAround, DISTRICT_MIN_ZOOM, PLACE_MAX_ZOOM,
  streetsInTile, streetTiles, pickStreet, STREET_MIN_ZOOM,
} from '../src/district.js';
import { makeVectorUpstream } from '../src/vector-tiles.js';
import { serve, staticFile } from '../src/server.js';
import { Positions } from '../src/positions.js';
import { encodeTile } from './mvt-encode.mjs';

const quiet = { info() {}, error() {} };

// A real tile: the `place` layer of z11/1078/719 (Liechtenstein), made by
// PostGIS's ST_AsMVT from an osm2pgsql import, with OpenMapTiles' field
// names. Triesen (village), Vaduz (town, named in Persian for the test, with
// its Latin name) and Masescha (hamlet, which is not a district).
const LIECHTENSTEIN = { z: 11, x: 1078, y: 719 };
const REAL = Buffer.from(
  '1ad4010a05706c6163651213120800000101020104021801220509ee0ca41c1215120a000301040205030404061801220509920b800b1213'
  + '1208000701080208040918012205098615b00e1a05636c6173731a046e616d651a0a6e616d653a6c6174696e1a0d6e616d653a6e6f6e6c61'
  + '74696e1a0472616e6b22090a0776696c6c61676522090a075472696573656e2202280922060a04746f776e220e0a0cd988d8a7d8afd988d8'
  + 'aad8b322070a05566164757a2202280522080a0668616d6c6574220a0a084d617365736368612202280e2880207802',
  'hex',
);
const VADUZ = { lat: 47.1392862, lon: 9.5227962 };
const TRIESEN = { lat: 47.106994, lon: 9.5274876 };

const toLon = (x) => x * 360 - 180;
const toLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

test('a real tile reads: names, kinds, and where each place is', () => {
  const layer = readLayer(REAL, 'place');
  assert.equal(layer.extent, 4096);
  assert.deepEqual(layer.features.map((f) => f.properties.class), ['village', 'town', 'hamlet']);
  assert.deepEqual(layer.features[1].properties, { class: 'town', name: 'وادوتس', 'name:latin': 'Vaduz', 'name:nonlatin': 'وادوتس', rank: 5 });
  assert.equal(readLayer(REAL, 'water'), null);

  const places = placesInTile(REAL, LIECHTENSTEIN);
  assert.equal(places.length, 2, 'a hamlet is not a district');
  const vaduz = places.find((p) => p.lines[1] === 'Vaduz');
  assert.deepEqual(vaduz.lines, ['وادوتس', 'Vaduz']);
  // Within a tile unit (4 m here) of where OSM has it.
  assert.ok(Math.abs(toLon(vaduz.x) - VADUZ.lon) < 1e-4);
  assert.ok(Math.abs(toLat(vaduz.y) - VADUZ.lat) < 1e-4);
  assert.deepEqual(places.find((p) => p.lines[0] === 'Triesen').lines, ['Triesen']);
});

test('the reader takes every value type, skips what it does not need, and refuses a broken tile', () => {
  const tile = encodeTile({
    water: { features: [{ type: 3, properties: { class: 'lake' }, rings: [[[0, 0], [10, 0], [10, 10]]] }] },
    place: {
      extent: 512,
      features: [
        { type: 1, points: [[100, 200]], properties: { class: 'suburb', name: 'Tajrish', rank: 12, capital: false, score: 1.5, depth: -3 } },
        { type: 2, properties: { class: 'town', name: 'A line' }, lines: [[[0, 0], [10, 10]]] },
      ],
    },
  });
  const layers = decodeTile(tile);
  assert.deepEqual(Object.keys(layers), ['water', 'place']);
  const place = readLayer(tile, 'place');
  assert.equal(place.extent, 512);
  const { type, properties, points } = place.features[0];
  assert.deepEqual({ type, properties, points }, {
    type: 1,
    properties: { class: 'suburb', name: 'Tajrish', rank: 12, capital: false, score: 1.5, depth: -3 },
    points: [[100, 200]],
  });
  assert.deepEqual(place.features[1].points, [], 'a line has no points of its own');
  assert.deepEqual(partsOf(LINE, place.features[1].geometry), [[[0, 0], [10, 10]]]);
  assert.equal(placesInTile(tile, { z: 12, x: 0, y: 0 }).length, 1);
  assert.throws(() => readLayer(tile.subarray(0, tile.length - 3), 'place'));
  assert.deepEqual(placesInTile(Buffer.from('not a tile'), { z: 12, x: 0, y: 0 }), []);
  assert.deepEqual(placesInTile(Buffer.alloc(0), { z: 12, x: 0, y: 0 }), []);
});

test('the tiles asked are those the map draws at that scale, 2 × 2 at most', () => {
  assert.equal(DISTRICT_MIN_ZOOM, 12);
  assert.equal(PLACE_MAX_ZOOM, 14);
  // Vaduz sits near a corner of its z11 tile, so a zoom-12 view spans four.
  assert.deepEqual(tilesAround(VADUZ.lat, VADUZ.lon, 12).map((t) => `${t.z}/${t.x}/${t.y}`).sort(),
    ['11/1077/718', '11/1077/719', '11/1078/718', '11/1078/719']);
  for (let zoom = 12; zoom <= 19; zoom += 0.5) {
    const tiles = tilesAround(35.8, 51.43, zoom);
    assert.ok(tiles.length >= 1 && tiles.length <= 4, `${zoom}: ${tiles.length}`);
    assert.ok(tiles.every((t) => t.z === Math.min(14, Math.floor(zoom) - 1)));
  }
  assert.deepEqual(tilesAround(VADUZ.lat, VADUZ.lon, 18), [{ z: 14, x: 8625, y: 5753 }]);
  // At the edge of the world, only tiles that exist.
  assert.deepEqual(tilesAround(85.0511, 179.99, 12), [{ z: 11, x: 2047, y: 0 }]);
  assert.deepEqual(tilesAround(-85.0511, -180, 12), [{ z: 11, x: 0, y: 2047 }]);
});

test('a part of a town beats the town; a town beats a nearer village only at its own middle', () => {
  const at = (lat, lon, kind, lines) => ({ ...placesFromRows([{ place: kind, name: lines[0], en: lines[1], lat, lon }])[0] });
  const vaduz = at(VADUZ.lat, VADUZ.lon, 'town', ['وادوتس', 'Vaduz']);
  const triesen = at(TRIESEN.lat, TRIESEN.lon, 'village', ['Triesen']);
  const places = [vaduz, triesen];
  // Zoomed out enough for both to be in reach: the middle of Vaduz is Vaduz.
  assert.deepEqual(pickDistrict(places, VADUZ.lat, VADUZ.lon, 12), ['وادوتس', 'Vaduz']);
  assert.deepEqual(pickDistrict(places, TRIESEN.lat, TRIESEN.lon, 12), ['Triesen']);
  // Halfway, the town reaches further than the village.
  assert.deepEqual(pickDistrict(places, (VADUZ.lat + TRIESEN.lat) / 2, VADUZ.lon, 12), ['وادوتس', 'Vaduz']);
  // Close in on Vaduz, Triesen is off the screen.
  assert.deepEqual(pickDistrict([triesen], VADUZ.lat, VADUZ.lon, 16), []);
  // A neighbourhood a little way off beats the town it is in.
  const quarter = at(VADUZ.lat + 0.002, VADUZ.lon, 'neighbourhood', ['Ebenholz']);
  assert.deepEqual(pickDistrict([...places, quarter], VADUZ.lat, VADUZ.lon, 15), ['Ebenholz']);
  // Between a neighbourhood and a suburb, the suburb carries further.
  const suburb = at(VADUZ.lat - 0.0025, VADUZ.lon, 'suburb', ['Au']);
  assert.deepEqual(pickDistrict([quarter, suburb], VADUZ.lat - 0.0003, VADUZ.lon, 15), ['Au']);
  assert.deepEqual(pickDistrict([], VADUZ.lat, VADUZ.lon, 15), []);
});

test('names: the local script first, a Latin line under it, a Latin name alone', () => {
  const rows = [
    { place: 'suburb', name: 'تجریش', en: 'Tajrish', lat: 35.8, lon: 51.43 },
    { place: 'suburb', name: 'ونک', en: null, lat: 35.76, lon: 51.4 },
    { place: 'town', name: 'Schaan', en: 'Schaan', lat: 47.16, lon: 9.51 },
    { place: 'hamlet', name: 'Masescha', lat: 47.13, lon: 9.55 },
    { place: 'town', name: null, lat: 47.1, lon: 9.5 },
    { place: 'town', name: 'Nowhere', lat: 'x', lon: 9.5 },
  ];
  assert.deepEqual(placesFromRows(rows).map((p) => p.lines), [['تجریش', 'Tajrish'], ['ونک'], ['Schaan']]);
  const tile = encodeTile({
    place: {
      features: [
        { type: 1, points: [[10, 10]], properties: { class: 'city', name: 'Tehran', name_en: 'Tehran' } },
        { type: 1, points: [[20, 20]], properties: { class: 'suburb', name: 'ونک', 'name:nonlatin': 'ونک', name_en: 'Vanak' } },
        { type: 1, points: [[30, 30]], properties: { class: 'quarter', name: 'x', 'name:latin': 'Zürich-West' } },
      ],
    },
  });
  assert.deepEqual(placesInTile(tile, { z: 14, x: 0, y: 0 }).map((p) => p.lines), [['Tehran'], ['ونک', 'Vanak'], ['Zürich-West']]);
});

test('the import is asked first, the upstream where it has nothing, and a tile is kept', async () => {
  let clock = 0;
  const asked = { pg: 0, up: 0 };
  let local = placesFromRows([{ place: 'town', name: 'Vaduz', lat: VADUZ.lat, lon: VADUZ.lon }]);
  const postgis = { places: async () => { asked.pg++; return local; } };
  const same = (t, u) => t.z === u.z && t.x === u.x && t.y === u.y;
  const upstream = { tile: async (t) => { asked.up++; return { bytes: same(t, LIECHTENSTEIN) ? REAL : Buffer.alloc(0), from: 'upstream' }; } };
  const district = makeDistrict({ postgis, upstream, log: quiet, now: () => clock });
  assert.deepEqual(await district.at(VADUZ.lat, VADUZ.lon, 17), ['Vaduz']);
  assert.deepEqual(asked, { pg: 1, up: 0 });
  await district.at(VADUZ.lat + 0.0001, VADUZ.lon, 17);
  assert.deepEqual(asked, { pg: 1, up: 0 }, 'the same tile is not asked twice');
  // An import with nothing there hands over to the upstream: four z11 tiles
  // around Vaduz, one of which has it.
  local = [];
  assert.deepEqual(await district.at(VADUZ.lat, VADUZ.lon, 12.4), ['وادوتس', 'Vaduz']);
  assert.deepEqual(asked, { pg: 5, up: 4 });
  // Too far out to name anything, or not a place: nobody is asked.
  assert.deepEqual(await district.at(VADUZ.lat, VADUZ.lon, 11.9), []);
  assert.deepEqual(await district.at(NaN, VADUZ.lon, 15), []);
  assert.deepEqual(asked, { pg: 5, up: 4 });
  // Kept ten minutes, then asked again.
  clock = 600_001;
  await district.at(VADUZ.lat, VADUZ.lon, 17);
  assert.equal(asked.pg, 6);
});

test('nobody answering is asked again soon; a source that throws is an empty answer', async () => {
  let clock = 0;
  let up = null;
  let asks = 0;
  const district = makeDistrict({ upstream: { tile: async () => { asks++; return up; } }, log: quiet, now: () => clock });
  assert.deepEqual(await district.at(VADUZ.lat, VADUZ.lon, 18), []);
  assert.equal(asks, 1);
  clock = 20_000;
  await district.at(VADUZ.lat, VADUZ.lon, 18);
  assert.equal(asks, 1);
  clock = 30_001;
  up = { bytes: REAL, from: 'upstream' };
  await district.at(VADUZ.lat, VADUZ.lon, 18);
  assert.equal(asks, 2);
  const broken = makeDistrict({ postgis: { places: async () => { throw new Error('boom'); } }, log: quiet });
  assert.deepEqual(await broken.at(VADUZ.lat, VADUZ.lon, 15), []);
  assert.deepEqual(await makeDistrict().at(VADUZ.lat, VADUZ.lon, 15), []);
});

test('PostGIS: no import means null, remembered; importing needs no restart; a failure backs off', async () => {
  let clock = 0;
  let imported = false;
  let fail = false;
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('to_regclass')) return { rows: [{ imported, tags: false }] };
    if (fail) throw new Error('boom');
    return { rows: [{ place: 'town', name: 'Vaduz', en: null, lat: VADUZ.lat, lon: VADUZ.lon }] };
  };
  const pg = makePlacesPostgis({ query, log: quiet, now: () => clock });
  const tile = { z: 14, x: 8625, y: 5753 };
  assert.equal(await pg.places(tile), null);
  assert.equal(await pg.places(tile), null);
  assert.equal(queries.length, 1, 'the missing import is remembered, not asked per tile');
  imported = true;
  clock = 600_001;
  assert.deepEqual((await pg.places(tile)).map((p) => p.lines), [['Vaduz']]);
  assert.deepEqual(queries.at(-1).params, [14, 8625, 5753]);
  assert.doesNotMatch(queries.at(-1).sql, /tags->/, 'without an hstore tags column');
  assert.equal(await pg.places({ z: 15, x: 0, y: 0 }), null);
  fail = true;
  assert.equal(await pg.places(tile), null);
  fail = false;
  assert.equal(await pg.places(tile), null, 'still backing off');
  clock += 5_001;
  assert.equal((await pg.places(tile)).length, 1);
  assert.equal(await makePlacesPostgis({ query: null }).places(tile), null);
  // The four tiles of one lookup share one look at the schema.
  let looks = 0;
  const shared = makePlacesPostgis({ log: quiet, query: async (sql) => {
    if (!sql.includes('to_regclass')) return { rows: [] };
    looks++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { rows: [{ imported: true, tags: true }] };
  } });
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map((y) => shared.places({ z: 14, x: 1, y }))), [[], [], [], []]);
  assert.equal(looks, 1);
  assert.match(placeSql(), /tags->'name:en'/);
  assert.match(placeSql(), /ST_TileEnvelope\(\$1, \$2, \$3\)/);
});

// Streets: the z14 tile under Vaduz, where at zoom 18 one tile unit is one
// pixel on the screen. The middle of the view is at 1600, 1500 in it.
const STREET_TILE = { z: 14, x: 8625, y: 5753 };
const inTile = (u, v) => ({ lat: toLat((STREET_TILE.y + v / 4096) / 2 ** 14), lon: toLon((STREET_TILE.x + u / 4096) / 2 ** 14) });
const STREETS = encodeTile({
  transportation_name: {
    extent: 4096,
    features: [
      // East–west, 30 below the middle, in two parts, their ends far off.
      { type: 2, properties: { class: 'minor', name: '  Äulestrasse ' }, lines: [[[600, 1530], [1500, 1530]], [[1500, 1530], [2600, 1530]]] },
      // A pedestrian street, north–south, 20 east of the middle.
      { type: 2, properties: { class: 'path', subclass: 'pedestrian', name: 'Städtle' }, lines: [[[1620, 1000], [1620, 2000]]] },
      // Through the middle, but not what a street sign names, or no name.
      { type: 2, properties: { class: 'path', subclass: 'footway', name: 'Rheinweg' }, lines: [[[1500, 1500], [1700, 1500]]] },
      { type: 2, properties: { class: 'rail', name: 'Vaduz–Schaan' }, lines: [[[1600, 1400], [1600, 1600]]] },
      { type: 2, properties: { class: 'minor', name: ' ' }, lines: [[[1590, 1490], [1610, 1510]]] },
      { type: 2, properties: { class: 'minor' }, lines: [[[1590, 1510], [1610, 1490]]] },
      { type: 1, properties: { class: 'minor', name: 'A point' }, points: [[1600, 1500]] },
      { type: 2, properties: { class: 'minor', name: 'Too short' }, lines: [[[1600, 1500]]] },
    ],
  },
});

test('streets: named roads from a tile, flat and across the world; paths, rails and nameless ones left out', () => {
  const streets = streetsInTile(STREETS, STREET_TILE);
  assert.deepEqual(streets.map((s) => s.name), ['Äulestrasse', 'Äulestrasse', 'Städtle']);
  assert.ok(streets[0].points instanceof Float64Array);
  const n = 2 ** 14;
  assert.deepEqual([...streets[0].points], [
    (8625 + 600 / 4096) / n, (5753 + 1530 / 4096) / n, (8625 + 1500 / 4096) / n, (5753 + 1530 / 4096) / n,
  ]);
  assert.deepEqual(streetsInTile(REAL, LIECHTENSTEIN), [], 'a tile without streets');
  assert.deepEqual(streetsInTile(Buffer.from('not a tile'), STREET_TILE), []);
  assert.deepEqual(streetsInTile(Buffer.alloc(0), STREET_TILE), []);
  assert.deepEqual(streetsInTile(null, STREET_TILE), []);
});

test('streets: the z14 tiles within reach of the middle, 2 × 2 at most', () => {
  assert.equal(STREET_MIN_ZOOM, 15);
  const middle = inTile(1600, 1500);
  assert.deepEqual(streetTiles(middle.lat, middle.lon, 18), [STREET_TILE]);
  assert.deepEqual(streetTiles(middle.lat, middle.lon, 15), [STREET_TILE]);
  // Near a corner, zoomed out enough for the reach to cross it.
  const corner = inTile(40, 40);
  assert.deepEqual(streetTiles(corner.lat, corner.lon, 15).map((t) => `${t.x}/${t.y}`).sort(),
    ['8624/5752', '8624/5753', '8625/5752', '8625/5753']);
  assert.deepEqual(streetTiles(corner.lat, corner.lon, 18), [STREET_TILE], 'zoomed in, 40 px is out of reach');
  for (let zoom = 15; zoom <= 22; zoom += 0.5) {
    const tiles = streetTiles(35.8, 51.43, zoom);
    assert.ok(tiles.length >= 1 && tiles.length <= 4, `${zoom}: ${tiles.length}`);
    assert.ok(tiles.every((t) => t.z === 14));
  }
  assert.deepEqual(streetTiles(85.0511, 179.999, 15), [{ z: 14, x: 16383, y: 0 }]);
});

test('streets: the nearest within reach of the middle, a pedestrian street included', () => {
  const streets = streetsInTile(STREETS, STREET_TILE);
  const at = (u, v, zoom) => { const p = inTile(u, v); return pickStreet(streets, p.lat, p.lon, zoom); };
  // At the middle: Städtle 20 px east, Äulestrasse 30 px south; the path,
  // the railway and the nameless road through the middle do not count.
  assert.equal(at(1600, 1500, 18), 'Städtle');
  assert.equal(at(1600, 1500, 17), 'Städtle');
  // Nearer the long street, away from its ends.
  assert.equal(at(1560, 1520, 18), 'Äulestrasse');
  // Out of reach at street zoom, in reach further out.
  assert.equal(at(1540, 1440, 18), '');
  assert.equal(at(1540, 1440, 17), '');
  assert.equal(at(1540, 1440, 16), 'Städtle');
  assert.equal(pickStreet([], 47.1, 9.5, 18), '');
});

test('streets: asked of the upstream once a tile, kept, and never a reason to fail', async () => {
  let clock = 0;
  let asks = 0;
  const same = (t, u) => t.z === u.z && t.x === u.x && t.y === u.y;
  const district = makeDistrict({ log: quiet, now: () => clock,
    upstream: { tile: async (t) => { asks++; return { bytes: same(t, STREET_TILE) ? STREETS : Buffer.alloc(0), from: 'upstream' }; } } });
  const middle = inTile(1600, 1500);
  assert.equal(await district.street(middle.lat, middle.lon, 18), 'Städtle');
  assert.equal(asks, 1);
  const south = inTile(1560, 1520);
  assert.equal(await district.street(south.lat, south.lon, 18), 'Äulestrasse');
  assert.equal(asks, 1, 'the same tile is not asked twice');
  // Further out than streets, or not a place: nobody is asked.
  assert.equal(await district.street(middle.lat, middle.lon, 14.9), '');
  assert.equal(await district.street(NaN, middle.lon, 18), '');
  assert.equal(asks, 1);
  // Kept ten minutes, then asked again.
  clock = 600_001;
  assert.equal(await district.street(middle.lat, middle.lon, 18), 'Städtle');
  assert.equal(asks, 2);

  // Nobody answering is asked again soon.
  let up = null;
  let tries = 0;
  const flaky = makeDistrict({ upstream: { tile: async () => { tries++; return up; } }, log: quiet, now: () => clock });
  assert.equal(await flaky.street(middle.lat, middle.lon, 18), '');
  clock += 20_000;
  assert.equal(await flaky.street(middle.lat, middle.lon, 18), '');
  assert.equal(tries, 1);
  clock += 10_001;
  up = { bytes: STREETS, from: 'upstream' };
  assert.equal(await flaky.street(middle.lat, middle.lon, 18), 'Städtle');
  assert.equal(tries, 2);

  // An upstream that throws, or none at all: no street, and nothing thrown.
  const errors = [];
  const broken = makeDistrict({ upstream: { tile: () => { throw new Error('boom'); } }, log: { info() {}, error: (...a) => errors.push(a.join(' ')) } });
  assert.equal(await broken.street(middle.lat, middle.lon, 18), '');
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /47\.|9\.5|8625|5753/, 'where somebody looks is not logged');
  assert.equal(await makeDistrict().street(middle.lat, middle.lon, 18), '');
});

function answer(status, body, type = 'application/octet-stream') {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), arrayBuffer: async () => Buffer.from(body), headers: new Map([['content-type', type]]) };
}

test('upstream: the TileJSON gives the template, tiles are cached, stale beats nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'district-'));
  try {
    const calls = [];
    let up = true;
    let clock = Date.now();
    const fetchImpl = async (url) => {
      calls.push(url);
      if (!up) throw new Error('unreachable');
      if (url === 'https://up.example/planet') return answer(200, JSON.stringify({ tiles: ['https://up.example/v1/{z}/{x}/{y}.pbf'] }));
      if (url === 'https://up.example/v1/11/1078/719.pbf') return answer(200, REAL);
      if (url === 'https://up.example/v1/12/0/0.pbf') return answer(204, '');
      return answer(500, '');
    };
    const upstream = makeVectorUpstream({ upstream: 'https://up.example/planet', cacheDir: dir, userAgent: 't', log: quiet, fetchImpl, now: () => clock });
    assert.equal(upstream.enabled, true);
    assert.deepEqual(await upstream.tile(LIECHTENSTEIN), { bytes: REAL, from: 'upstream' });
    assert.deepEqual(calls, ['https://up.example/planet', 'https://up.example/v1/11/1078/719.pbf']);
    assert.deepEqual(await upstream.tile(LIECHTENSTEIN), { bytes: REAL, from: 'cache' });
    assert.equal(calls.length, 2, 'the second ask is answered from disk');
    // Nothing there is an answer too, and it is kept.
    assert.equal((await upstream.tile({ z: 12, x: 0, y: 0 })).bytes.length, 0);
    // Past its age and with the upstream down, the old tile is still served.
    clock += 8 * 24 * 3600 * 1000;
    up = false;
    assert.deepEqual(await upstream.tile(LIECHTENSTEIN), { bytes: REAL, from: 'stale' });
    assert.equal(await upstream.tile({ z: 12, x: 5, y: 5 }), null);
    assert.equal(await upstream.tile({ z: 15, x: 0, y: 0 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream: a template is used as given; off means off; a broken TileJSON is retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'district-'));
  try {
    const calls = [];
    const direct = makeVectorUpstream({ upstream: 'https://t.example/{z}/{x}/{y}.pbf', cacheDir: dir, log: quiet,
      fetchImpl: async (url) => { calls.push(url); return answer(200, REAL); } });
    assert.equal((await direct.tile(LIECHTENSTEIN)).from, 'upstream');
    assert.deepEqual(calls, ['https://t.example/11/1078/719.pbf']);
    for (const upstream of ['off', '', undefined]) {
      const off = makeVectorUpstream({ upstream, cacheDir: dir, log: quiet, fetchImpl: async () => assert.fail('fetched') });
      assert.equal(off.enabled, false);
      assert.equal(await off.tile(LIECHTENSTEIN), null);
    }
    let clock = 0;
    let good = false;
    const asks = [];
    const flaky = makeVectorUpstream({ upstream: 'https://f.example/planet', cacheDir: join(dir, 'f'), log: quiet, now: () => clock,
      fetchImpl: async (url) => {
        asks.push(url);
        if (url.endsWith('/planet')) return answer(200, JSON.stringify(good ? { tiles: ['https://f.example/{z}/{x}/{y}'] } : { tiles: [] }));
        return answer(200, REAL);
      } });
    assert.equal(await flaky.tile(LIECHTENSTEIN), null);
    assert.equal(await flaky.tile(LIECHTENSTEIN), null);
    assert.equal(asks.length, 1, 'not asked again within the minute');
    good = true;
    clock = 60_001;
    assert.equal((await flaky.tile(LIECHTENSTEIN)).from, 'upstream');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream: tiles asked together wait for the one TileJSON fetch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'district-'));
  try {
    const asked = [];
    const upstream = makeVectorUpstream({ upstream: 'https://up.example/planet', cacheDir: dir, log: quiet,
      fetchImpl: async (url) => {
        asked.push(url);
        if (url.endsWith('/planet')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return answer(200, JSON.stringify({ tiles: ['https://up.example/{z}/{x}/{y}.pbf'] }));
        }
        return answer(200, REAL);
      } });
    const four = [[1077, 718], [1077, 719], [1078, 718], [1078, 719]].map(([x, y]) => upstream.tile({ z: 11, x, y }));
    assert.deepEqual((await Promise.all(four)).map((t) => t && t.from), ['upstream', 'upstream', 'upstream', 'upstream']);
    assert.equal(asked.filter((u) => u.endsWith('/planet')).length, 1);
    // And the lookup those tiles are for names Vaduz the first time it is asked.
    const district = makeDistrict({ upstream: makeVectorUpstream({ upstream: 'https://up.example/planet', cacheDir: join(dir, 'd'), log: quiet,
      fetchImpl: async (url) => {
        if (url.endsWith('/planet')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return answer(200, JSON.stringify({ tiles: ['https://up.example/{z}/{x}/{y}.pbf'] }));
        }
        return url.endsWith('/11/1078/719.pbf') ? answer(200, REAL) : answer(204, '');
      } }), log: quiet });
    assert.deepEqual(await district.at(VADUZ.lat, VADUZ.lon, 12), ['وادوتس', 'Vaduz']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream: a TileJSON cannot send the server to another host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'district-'));
  try {
    const asked = [];
    const bad = makeVectorUpstream({ upstream: 'https://up.example/planet', cacheDir: dir, log: quiet,
      fetchImpl: async (url) => {
        asked.push(url);
        return answer(200, JSON.stringify({ tiles: ['http://169.254.169.254/{z}/{x}/{y}'] }));
      } });
    assert.equal(await bad.tile(LIECHTENSTEIN), null);
    assert.deepEqual(asked, ['https://up.example/planet']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/api/district is signed-in only, checks what it is given, and answers in lines and a street', async () => {
  const asked = [];
  const streets = [];
  const district = {
    at: async (lat, lon, zoom) => { asked.push([lat, lon, zoom]); return zoom >= 12 ? ['وادوتس', 'Vaduz'] : []; },
    street: async (lat, lon, zoom) => { streets.push([lat, lon, zoom]); return zoom >= 15 ? 'Städtle' : ''; },
  };
  const lines = [];
  const log = { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const { server } = serve(new Positions(), { dashboardToken: 'test', port: 0, host: '127.0.0.1' }, { district, log });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/district`;
  try {
    assert.equal((await fetch(`${base}?lat=47.1393&lon=9.5228&z=15`)).status, 401);
    const res = await fetch(`${base}?lat=47.1393&lon=9.5228&z=15&token=test`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.headers.get('cache-control'), /private/);
    assert.deepEqual(await res.json(), { lines: ['وادوتس', 'Vaduz'], street: 'Städtle' });
    assert.deepEqual(await (await fetch(`${base}?lat=47.1393&lon=9.5228&z=13&token=test`)).json(), { lines: ['وادوتس', 'Vaduz'], street: '' });
    // Leaflet's longitude keeps counting past the dateline; the server wraps it.
    await fetch(`${base}?lat=47.1393&lon=369.5228&z=15&token=test`);
    assert.ok(Math.abs(asked.at(-1)[1] - 9.5228) < 1e-9);
    assert.ok(Math.abs(streets.at(-1)[1] - 9.5228) < 1e-9);
    for (const bad of ['lat=91&lon=0&z=15', 'lat=&lon=0&z=15', 'lon=0&z=15', 'lat=0&lon=x&z=15', 'lat=0&lon=0&z=30', 'lat=0&lon=0']) {
      assert.equal((await fetch(`${base}?${bad}&token=test`)).status, 400, bad);
    }
    assert.equal(asked.length, 3, 'nothing bad reaches the lookup');
    assert.equal(streets.length, 3);
    assert.ok(lines.every((l) => !l.includes('47.1393') && !l.includes('9.5228')), 'where somebody looks is not logged');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the district name\'s typeface is served as a font', () => {
  assert.equal(staticFile('/vendor/fonts/oswald-latin-600-normal.woff2').type, 'font/woff2');
  assert.match(staticFile('/vendor/fonts/oswald-latin-600-normal.woff2').file, /oswald-latin-600-normal\.woff2$/);
  assert.equal(staticFile('/vendor/../../src/server.js'), null);
  assert.equal(staticFile('/vendor/x.exe'), null);
});
