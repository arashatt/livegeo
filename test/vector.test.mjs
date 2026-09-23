import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVector, makeVectorPostgis, makeVectorUpstream, vectorSql, VECTOR_MAX_ZOOM } from '../src/vector.js';
import { parseVectorPath } from '../src/tile-path.js';
import { serve, staticFile } from '../src/server.js';
import { Positions } from '../src/positions.js';

const quiet = { info() {}, error() {} };
const MVT = Buffer.from('1a0f0a0277611206120200001802', 'hex');
const tile = { z: 12, x: 2156, y: 1438 };

function answer(status, body, type = 'application/octet-stream') {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), arrayBuffer: async () => Buffer.from(body), headers: new Map([['content-type', type]]) };
}

test('vector tile paths are three integers, no deeper than the sources go', () => {
  assert.deepEqual(parseVectorPath('/vector/12/2156/1438.pbf'), tile);
  assert.equal(VECTOR_MAX_ZOOM, 14);
  for (const path of ['/vector/15/0/0.pbf', '/vector/12/4096/0.pbf', '/vector/-1/0/0.pbf',
    '/vector/../x.pbf', '/vector/1/0/0.mvt', '/vector/1/0/0.pbf?x', '/vector%2F1/0/0.pbf']) {
    assert.equal(parseVectorPath(path), null, path);
  }
});

test('the import is asked first, and the upstream only where it has nothing', async () => {
  const asked = [];
  const upstream = { tile: async (t) => { asked.push(t); return { bytes: MVT, from: 'upstream' }; } };
  let local = MVT;
  const vector = makeVector({ postgis: async () => local, upstream });
  assert.deepEqual(await vector.tile(tile), { bytes: MVT, from: 'postgis' });
  assert.equal(asked.length, 0);
  local = null;
  assert.equal((await vector.tile(tile)).from, 'upstream');
  local = Buffer.alloc(0);
  assert.equal((await vector.tile(tile)).from, 'upstream');
  assert.equal(await makeVector({ postgis: async () => null }).tile(tile), null);
  assert.equal(await makeVector({ upstream }).tile({ z: 15, x: 0, y: 0 }), null);
});

test('PostGIS: no import means no tile, and importing needs no restart', async () => {
  let clock = 0;
  let imported = false;
  const queries = [];
  const query = async (sql, params) => {
    queries.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ imported, tags: true }] };
    return { rows: [{ mvt: MVT }] };
  };
  const pg = makeVectorPostgis({ query, log: quiet, now: () => clock });
  assert.equal(await pg.tile(12, 1, 1), null);
  assert.equal(await pg.tile(12, 1, 2), null);
  assert.equal(queries.length, 1, 'the missing import is remembered, not asked per tile');
  imported = true;
  clock = 600_001;
  assert.deepEqual(await pg.tile(12, 1, 1), MVT);
  // Shallow zooms are never asked of PostGIS: they cover whole countries.
  assert.equal(await pg.tile(5, 1, 1), null);
  assert.equal(await makeVectorPostgis({ query: null }).tile(12, 1, 1), null);
});

test('PostGIS: a failure is logged, not thrown, and retried shortly after', async () => {
  let clock = 0;
  let fail = true;
  const query = async (sql) => {
    if (sql.includes('to_regclass')) return { rows: [{ imported: true, tags: true }] };
    if (fail) throw new Error('boom');
    return { rows: [{ mvt: MVT }] };
  };
  const pg = makeVectorPostgis({ query, log: quiet, now: () => clock });
  assert.equal(await pg.tile(12, 1, 1), null);
  fail = false;
  assert.equal(await pg.tile(12, 1, 1), null, 'still backing off');
  clock = 5_001;
  assert.deepEqual(await pg.tile(12, 1, 1), MVT);
});

test('the SQL speaks OpenMapTiles and works without hstore tags', () => {
  const sql = vectorSql();
  for (const layer of ['water', 'waterway', 'landcover', 'park', 'landuse', 'building', 'transportation', 'transportation_name', 'place']) {
    assert.match(sql, new RegExp(`ST_AsMVT\\(q, '${layer}'`));
  }
  assert.match(sql, /render_height/);
  assert.match(sql, /"name:latin"/);
  assert.match(sql, /tags->'building:levels'/);
  const bare = vectorSql({ tags: false });
  assert.doesNotMatch(bare, /tags->/);
  assert.match(bare, /render_height/);
});

test('upstream: the TileJSON gives the template, tiles are cached, stale beats nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vector-'));
  try {
    const calls = [];
    let up = true;
    let clock = Date.now();
    const fetchImpl = async (url) => {
      calls.push(url);
      if (!up) throw new Error('unreachable');
      if (url === 'https://up.example/planet') return answer(200, JSON.stringify({ tiles: ['https://up.example/v1/{z}/{x}/{y}.pbf'] }));
      if (url === 'https://up.example/v1/12/2156/1438.pbf') return answer(200, MVT);
      if (url === 'https://up.example/v1/12/0/0.pbf') return answer(204, '');
      return answer(500, '');
    };
    const upstream = makeVectorUpstream({ upstream: 'https://up.example/planet', cacheDir: dir, userAgent: 't', log: quiet, fetchImpl, now: () => clock });
    assert.equal(upstream.enabled, true);
    assert.deepEqual(await upstream.tile(tile), { bytes: MVT, from: 'upstream' });
    assert.deepEqual(calls, ['https://up.example/planet', 'https://up.example/v1/12/2156/1438.pbf']);
    assert.deepEqual(await upstream.tile(tile), { bytes: MVT, from: 'cache' });
    assert.equal(calls.length, 2, 'the second ask is answered from disk');
    // Nothing there is an answer too, and it is kept.
    assert.equal((await upstream.tile({ z: 12, x: 0, y: 0 })).bytes.length, 0);
    // Past its age and with the upstream down, the old tile is still served.
    clock += 8 * 24 * 3600 * 1000;
    up = false;
    assert.deepEqual(await upstream.tile(tile), { bytes: MVT, from: 'stale' });
    assert.equal(await upstream.tile({ z: 12, x: 5, y: 5 }), null);
    assert.equal(await upstream.tile({ z: 15, x: 0, y: 0 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream: a template is used as given; off means off; a broken TileJSON is retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vector-'));
  try {
    const calls = [];
    const direct = makeVectorUpstream({ upstream: 'https://t.example/{z}/{x}/{y}.pbf', cacheDir: dir, log: quiet,
      fetchImpl: async (url) => { calls.push(url); return answer(200, MVT); } });
    assert.equal((await direct.tile(tile)).from, 'upstream');
    assert.deepEqual(calls, ['https://t.example/12/2156/1438.pbf']);
    for (const upstream of ['off', '', undefined]) {
      const off = makeVectorUpstream({ upstream, cacheDir: dir, log: quiet, fetchImpl: async () => assert.fail('fetched') });
      assert.equal(off.enabled, false);
      assert.equal(await off.tile(tile), null);
    }
    let clock = 0;
    let good = false;
    const asks = [];
    const flaky = makeVectorUpstream({ upstream: 'https://f.example/planet', cacheDir: join(dir, 'f'), log: quiet, now: () => clock,
      fetchImpl: async (url) => {
        asks.push(url);
        if (url.endsWith('/planet')) return answer(200, JSON.stringify(good ? { tiles: ['https://f.example/{z}/{x}/{y}'] } : { tiles: [] }));
        return answer(200, MVT);
      } });
    assert.equal(await flaky.tile(tile), null);
    assert.equal(await flaky.tile(tile), null);
    assert.equal(asks.length, 1, 'not asked again within the minute');
    good = true;
    clock = 60_001;
    assert.equal((await flaky.tile(tile)).from, 'upstream');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream: a TileJSON cannot send the server to another host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vector-'));
  try {
    const asked = [];
    const bad = makeVectorUpstream({ upstream: 'https://up.example/planet', cacheDir: dir, log: quiet,
      fetchImpl: async (url) => {
        asked.push(url);
        return answer(200, JSON.stringify({ tiles: ['http://169.254.169.254/{z}/{x}/{y}'] }));
      } });
    assert.equal(await bad.tile(tile), null);
    assert.deepEqual(asked, ['https://up.example/planet']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the endpoint is signed-in only, gzipped, and empty is a 204', async () => {
  let bytes = MVT;
  const vector = { tile: async (t) => (bytes ? { bytes, from: 'postgis', t } : null) };
  const { server } = serve(new Positions(), { dashboardToken: 'test', port: 0, host: '127.0.0.1' }, { vector, log: quiet });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/vector/12/2156/1438.pbf`;
  try {
    assert.equal((await fetch(base)).status, 401);
    const res = await fetch(`${base}?token=test`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
    assert.equal(res.headers.get('x-vector-source'), 'postgis');
    // fetch undoes the gzip itself; that it had to is what matters here.
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), MVT);
    bytes = null;
    const empty = await fetch(`${base}?token=test`);
    assert.equal(empty.status, 204);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/vector/15/0/0.pbf?token=test`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the game map files are served with types browsers accept', () => {
  assert.equal(staticFile('/vendor/maplibre/maplibre-gl.mjs').type, 'text/javascript; charset=utf-8');
  assert.equal(staticFile('/vendor/glyphs/Noto%20Sans%20Regular/0-255.pbf').type, 'application/x-protobuf');
  assert.match(staticFile('/vendor/glyphs/Noto%20Sans%20Regular/0-255.pbf').file, /Noto Sans Regular\/0-255\.pbf$/);
  assert.equal(staticFile('/vendor/fonts/oswald-latin-600-normal.woff2').type, 'font/woff2');
  assert.equal(staticFile('/vendor/world/land-110m.json').type, 'application/json; charset=utf-8');
  assert.equal(staticFile('/vendor/../../src/server.js'), null);
  assert.equal(staticFile('/vendor/x.exe'), null);
});
