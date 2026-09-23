// Run against a disposable PostGIS database. The fixture tables are TEMP and
// vanish on disconnect; no imported map or application tables are changed.
import assert from 'node:assert/strict';
import pg from 'pg';
import { CARTOGRAPHY_SQL, makeCartography } from '../src/cartography.js';
import { makeDistrict, makePlacesPostgis, placeSql } from '../src/district.js';
import { makeVectorCartography } from '../src/cartography-vector.js';

if (!process.env.CARTOGRAPHY_TEST_DATABASE_URL) throw new Error('CARTOGRAPHY_TEST_DATABASE_URL is required');
const db = new pg.Client({ connectionString: process.env.CARTOGRAPHY_TEST_DATABASE_URL });
await db.connect();
try {
  await db.query(`
    CREATE TEMP TABLE planet_osm_polygon (
      osm_id bigint, way geometry(Geometry,3857), way_area double precision,
      "natural" text, landuse text, waterway text, leisure text, building text
    );
    CREATE TEMP TABLE planet_osm_line (
      osm_id bigint, way geometry(Geometry,3857), waterway text, railway text, highway text
    );
    -- A lake in the upper-left quadrant and a road through the tile centre.
    WITH t AS (SELECT ST_TileEnvelope(15, 100, 100) AS g),
    b AS (SELECT ST_XMin(g) AS x, ST_YMax(g) AS y, (ST_XMax(g)-ST_XMin(g))/256 AS p FROM t)
    INSERT INTO planet_osm_polygon
      SELECT 1, ST_MakeEnvelope(x+20*p,y-70*p,x+70*p,y-20*p,3857), 1e6, 'water', NULL, NULL, NULL, NULL FROM b;
    WITH t AS (SELECT ST_TileEnvelope(15, 100, 100) AS g)
    INSERT INTO planet_osm_line
      SELECT 2, ST_SetSRID(ST_MakeLine(ST_MakePoint(ST_XMin(g), (ST_YMin(g)+ST_YMax(g))/2),
                                     ST_MakePoint(ST_XMax(g), (ST_YMin(g)+ST_YMax(g))/2)),3857), NULL, NULL, 'primary' FROM t;
    -- A motorway centre just outside the west edge still paints into this tile.
    WITH t AS (SELECT ST_TileEnvelope(15, 100, 100) AS g),
    b AS (SELECT ST_XMin(g) AS x, ST_YMin(g) AS bottom, ST_YMax(g) AS top,
                 (ST_XMax(g)-ST_XMin(g))/256 AS p FROM t)
    INSERT INTO planet_osm_line
      SELECT 3, ST_SetSRID(ST_MakeLine(ST_MakePoint(x-p,bottom), ST_MakePoint(x-p,top)),3857), NULL, NULL, 'motorway' FROM b;
    -- Dense buildings must not crowd roads out of the query budget.
    INSERT INTO planet_osm_polygon
      SELECT id, way, way_area, NULL, NULL, NULL, NULL, 'yes'
      FROM planet_osm_polygon CROSS JOIN generate_series(10, 2000) id WHERE osm_id=1;
  `);
  const { rows } = await db.query(CARTOGRAPHY_SQL, [15, 100, 100]);
  const road = rows.find((row) => row.subtype === 'primary');
  assert.ok(road, 'road survives dense building features');
  assert.match(road.d, /-128/);
  assert.ok(rows.some((row) => row.subtype === 'motorway'), 'tile-edge geometry is included');
  const lake = rows.find((row) => row.layer === 'water');
  assert.match(lake.d, /-20/);
  assert.match(lake.d, /-70/);
  assert.equal(rows.filter((row) => row.layer === 'buildings').length, 1800);
  const carto = makeCartography({ query: (...args) => db.query(...args) });
  const svg = await carto.tile(15, 100, 100, ['roads', 'water']);
  assert.match(svg, /transform="scale\(1,-1\)"/);
  assert.doesNotMatch(svg, /data-layer="buildings"/);
  const empty = await carto.tile(15, 110, 110);
  assert.equal(empty, null, 'outside the imported extent stays transparent');
  // Test a different hemisphere: the query has no city-specific bounds.
  assert.equal(await carto.tile(15, 25000, 25000), null);
  console.log('PostGIS cartography: geometry, orientation, edge buffer, budgets, selections and coverage passed');

  // The same features from a vector tile, as a server with no import draws
  // them: a z14 tile in the OpenMapTiles layout, made by PostGIS's own MVT
  // encoder from the same rows. Both must land in the same place.
  const { rows: [{ mvt }] } = await db.query(`
    WITH t AS (SELECT ST_TileEnvelope(14, 50, 50) AS env),
    roads AS (SELECT highway AS class, ST_AsMVTGeom(way, t.env, 4096, 64, true) AS geom
                FROM planet_osm_line, t WHERE highway IS NOT NULL),
    lakes AS (SELECT 'lake' AS class, ST_AsMVTGeom(way, t.env, 4096, 64, true) AS geom
                FROM planet_osm_polygon, t WHERE "natural" = 'water')
    SELECT (SELECT ST_AsMVT(roads, 'transportation', 4096, 'geom') FROM roads WHERE geom IS NOT NULL)
        || (SELECT ST_AsMVT(lakes, 'water', 4096, 'geom') FROM lakes WHERE geom IS NOT NULL) AS mvt`);
  const vector = makeVectorCartography({ upstream: { enabled: true, tile: async () => ({ bytes: mvt, from: 'upstream' }) } });
  const fromVector = await vector.tile(15, 100, 100, ['roads', 'water']);
  const fromImport = await carto.tile(15, 100, 100, ['roads', 'water']);
  const bounds = (svg, layer) => {
    const group = new RegExp(`<g data-layer="${layer}">(.*?)</g>`).exec(svg)[1];
    const numbers = [...group.matchAll(/ d="([^"]*)"/g)].flatMap(([, d]) => d.match(/-?\d+(?:\.\d+)?/g).map(Number));
    const xs = numbers.filter((_, i) => i % 2 === 0);
    const ys = numbers.filter((_, i) => i % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  for (const layer of ['roads', 'water']) {
    const a = bounds(fromImport, layer);
    const b = bounds(fromVector, layer);
    assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 1), `${layer}: import ${a}, vector tile ${b}`);
  }
  assert.match(fromVector, /transform="scale\(1,-1\)"/);
  console.log('PostGIS cartography from vector tiles: the same roads and water, in the same place');

  // The district name, from the import's place nodes: the same query the
  // server runs, against a few places around Vaduz.
  await db.query('CREATE EXTENSION IF NOT EXISTS hstore');
  await db.query(`
    CREATE TEMP TABLE planet_osm_point (
      osm_id bigint, way geometry(Point,3857), name text, place text, tags hstore
    );
    INSERT INTO planet_osm_point VALUES
      (1, ST_Transform(ST_SetSRID(ST_MakePoint(9.5227962, 47.1392862), 4326), 3857), 'وادوتس', 'town', 'name:en=>Vaduz'),
      (2, ST_Transform(ST_SetSRID(ST_MakePoint(9.5274876, 47.1069940), 4326), 3857), 'Triesen', 'village', ''),
      (3, ST_Transform(ST_SetSRID(ST_MakePoint(9.5236000, 47.1408000), 4326), 3857), 'Ebenholz', 'neighbourhood', ''),
      (4, ST_Transform(ST_SetSRID(ST_MakePoint(9.5500000, 47.1330000), 4326), 3857), 'Masescha', 'hamlet', ''),
      (5, ST_Transform(ST_SetSRID(ST_MakePoint(9.5230000, 47.1390000), 4326), 3857), NULL, 'suburb', '');
  `);
  // z11: towns and villages; neighbourhoods only from z12, as OpenMapTiles.
  const z11 = await db.query(placeSql(), [11, 1078, 719]);
  assert.deepEqual(z11.rows.map((r) => r.name).sort(), ['Triesen', 'وادوتس']);
  assert.equal(z11.rows.find((r) => r.place === 'town').en, 'Vaduz');
  assert.ok(Math.abs(z11.rows.find((r) => r.place === 'town').lat - 47.1392862) < 1e-6);
  const z14 = await db.query(placeSql({ tags: false }), [14, 8625, 5753]);
  assert.deepEqual(z14.rows.map((r) => r.name), ['Ebenholz', 'وادوتس'], 'parts of a town first');
  // One connection is what sees the TEMP table, so its queries take turns;
  // the server's pool runs them side by side.
  let turn = Promise.resolve();
  const inTurn = (...args) => {
    const run = turn.then(() => db.query(...args));
    turn = run.catch(() => {});
    return run;
  };
  const district = makeDistrict({ postgis: makePlacesPostgis({ query: inTurn }) });
  assert.deepEqual(await district.at(47.1392862, 9.5227962, 12), ['وادوتس', 'Vaduz']);
  assert.deepEqual(await district.at(47.1392862, 9.5227962, 16), ['Ebenholz']);
  assert.deepEqual(await district.at(47.1069940, 9.5274876, 16), ['Triesen']);
  assert.deepEqual(await district.at(-33.9, 18.4, 16), [], 'outside the import: nothing, with no upstream');
  console.log('PostGIS district: place kinds by zoom, Latin names from tags, and the lookup passed');
} finally {
  await db.end();
}
