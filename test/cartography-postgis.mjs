// Run against a disposable PostGIS database. The fixture tables are TEMP and
// vanish on disconnect; no imported map or application tables are changed.
import assert from 'node:assert/strict';
import pg from 'pg';
import { CARTOGRAPHY_SQL, makeCartography } from '../src/cartography.js';

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
} finally {
  await db.end();
}
