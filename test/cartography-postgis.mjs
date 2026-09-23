// Run against a disposable PostGIS database. The fixture tables are TEMP and
// vanish on disconnect; no imported map or application tables are changed.
import assert from 'node:assert/strict';
import pg from 'pg';
import { CARTOGRAPHY_SQL, makeCartography } from '../src/cartography.js';
import { makeVectorPostgis } from '../src/vector.js';
import { decodeTile } from './mvt.mjs';

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

// The game map's vector tiles, from tables shaped like osm2pgsql's (with its
// hstore tags), in a session of their own.
const vt = new pg.Client({ connectionString: process.env.CARTOGRAPHY_TEST_DATABASE_URL });
await vt.connect();
try {
  await vt.query(`
    CREATE EXTENSION IF NOT EXISTS hstore;
    CREATE TEMP TABLE planet_osm_polygon (
      osm_id bigint, way geometry(Geometry,3857), way_area real, "natural" text, landuse text,
      waterway text, water text, leisure text, building text, tags hstore
    );
    CREATE TEMP TABLE planet_osm_line (
      osm_id bigint, way geometry(Geometry,3857), waterway text, railway text, highway text,
      bridge text, tunnel text, name text, z_order int, tags hstore
    );
    CREATE TEMP TABLE planet_osm_point (
      osm_id bigint, way geometry(Point,3857), place text, name text, tags hstore
    );
    WITH t AS (SELECT ST_TileEnvelope(14, 10000, 6000) AS g),
    b AS (SELECT ST_XMin(g) AS x, ST_YMax(g) AS y, (ST_XMax(g)-ST_XMin(g))/512 AS p FROM t)
    INSERT INTO planet_osm_polygon
      SELECT 1, ST_MakeEnvelope(x+10*p,y-60*p,x+60*p,y-10*p,3857), 1e5, NULL, NULL, NULL, NULL, NULL, 'apartments',
             'building:levels=>10'::hstore FROM b
      UNION ALL
      SELECT 2, ST_MakeEnvelope(x+100*p,y-160*p,x+160*p,y-100*p,3857), 1e5, NULL, NULL, NULL, NULL, NULL, 'yes', ''::hstore FROM b
      UNION ALL
      SELECT 3, ST_MakeEnvelope(x+200*p,y-400*p,x+400*p,y-200*p,3857), 1e7, 'water', NULL, NULL, NULL, NULL, NULL, ''::hstore FROM b;
    WITH t AS (SELECT ST_TileEnvelope(14, 10000, 6000) AS g)
    INSERT INTO planet_osm_line
      SELECT 4, ST_SetSRID(ST_MakeLine(ST_MakePoint(ST_XMin(g), ST_YMin(g)), ST_MakePoint(ST_XMax(g), ST_YMax(g))),3857),
             NULL, NULL, 'primary_link', 'yes', NULL, 'خیابان آزادی', 5, 'name:en=>"Azadi Street"'::hstore FROM t;
    WITH t AS (SELECT ST_TileEnvelope(14, 10000, 6000) AS g)
    INSERT INTO planet_osm_point
      SELECT 5, ST_SetSRID(ST_MakePoint((ST_XMin(g)+ST_XMax(g))/2, (ST_YMin(g)+ST_YMax(g))/2),3857),
             'suburb', 'Vaduz', ''::hstore FROM t;
  `);
  const tiles = makeVectorPostgis({ query: (...args) => vt.query(...args) });
  const layers = decodeTile(await tiles.tile(14, 10000, 6000));
  const heights = layers.building.map((f) => f.properties.render_height).sort((a, b) => a - b);
  assert.equal(heights.length, 2);
  assert.ok(heights.includes(33.5), 'ten levels are 33.5 m');
  assert.ok(heights[0] > 0 && heights[0] < 40, 'a building without a height still stands');
  assert.deepEqual(layers.transportation.map((f) => f.properties),
    [{ class: 'primary', ramp: 1, brunnel: 'bridge' }]);
  assert.deepEqual(layers.transportation_name[0].properties,
    { name: 'خیابان آزادی', 'name:latin': 'Azadi Street', 'name:nonlatin': 'خیابان آزادی', class: 'primary' });
  assert.equal(layers.water[0].properties.class, 'lake');
  assert.equal(layers.place[0].properties['name:latin'], 'Vaduz');
  assert.equal(layers.place[0].properties['name:nonlatin'], undefined);
  assert.equal(await tiles.tile(14, 11000, 6000), null, 'nothing there means ask the upstream');
  assert.equal(await tiles.tile(6, 1, 1), null, 'whole countries are never asked of PostGIS');
  console.log('PostGIS vector tiles: layers, heights, names and scripts passed');
} finally {
  await vt.end();
}
