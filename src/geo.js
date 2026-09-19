// geo.js — the geography. Where a point *is*, rather than which numbers it is.
//
// Two jobs, kept apart on purpose:
//
//   recording   every position that actually moved, so there is a history
//   describing  a point, by asking an OpenStreetMap extract what is nearest
//
// Neither is required for the service to run. Without DATABASE_URL this whole
// module answers "nothing" and the dashboard behaves exactly as it did before
// — PostGIS is a capability, not a dependency, and a map that cannot name a
// street is still a map.
//
// The shaping is exported on its own so it can be tested without a database,
// the same way personOf is in directory.js.

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCHEMA = fileURLToPath(new URL('../sql/schema.sql', import.meta.url));

// A road only tells you where someone is if they are on or beside it; the
// nearest named road to a point in open country can be kilometres away and
// naming it would be worse than saying nothing.
const ROAD_LIMIT_METRES = 120;

// An area is a large thing, so being some way outside one still places you
// near it — but only up to a point. Without a limit the nearest named polygon
// to a point in the ocean is a city on another continent, and the dashboard
// would state it as fact.
const AREA_LIMIT_METRES = 25_000;

// Turns what the nearest-feature queries found into one line a person can
// read. Pure — the queries live below, the judgement lives here.
export function placeName({ road, area } = {}) {
  const parts = [];
  if (road?.name && Number.isFinite(road.metres) && road.metres <= ROAD_LIMIT_METRES) {
    parts.push(road.name);
  }
  if (area?.name && Number.isFinite(area.metres) && area.metres <= AREA_LIMIT_METRES
      && !parts.includes(area.name)) {
    parts.push(area.name);
  }
  return parts.join(', ');
}

export function makeGeo({ url, log = console } = {}) {
  let pool = null;

  // Queries run against whatever osm2pgsql produced. If the extract was never
  // imported the tables are missing, which is a perfectly ordinary state —
  // recording still works, describing just comes back empty.
  const nearest = async (table, where, lat, lon) => {
    const { rows } = await pool.query(
      // Two SRIDs are in play and mixing them is an error rather than a wrong
      // answer, so both sides are explicit:
      //
      //   ordering  in 3857, which is what osm2pgsql writes by default and
      //             what the GiST index is built on. The KNN operator (<->)
      //             is what lets that index answer "nearest"; ordering by
      //             ST_Distance instead scans the table, which on a country
      //             extract is seconds rather than milliseconds.
      //   distance  in 4326 cast to geography, which is the only way to get
      //             an answer in metres rather than in degrees or in mercator
      //             units that are wrong everywhere except the equator.
      //
      // ST_Transform on `way` costs nothing here: LIMIT 1 means it runs on the
      // handful of rows the index already chose.
      `SELECT name,
              ST_Distance(ST_Transform(way, 4326)::geography, $1::geography) AS metres
         FROM ${table}
        WHERE name IS NOT NULL AND ${where}
        ORDER BY way <-> ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), 3857)
        LIMIT 1`,
      [`SRID=4326;POINT(${lon} ${lat})`, lon, lat],
    );
    return rows[0] ? { name: rows[0].name, metres: Number(rows[0].metres) } : null;
  };

  return {
    enabled: () => Boolean(pool),

    async connect() {
      if (!url) {
        log.info('geo: no DATABASE_URL — history and place names are off');
        return false;
      }
      pool = new pg.Pool({ connectionString: url, max: 4 });
      try {
        await pool.query('SELECT 1');
        // The schema ships with the code and is applied on every boot. It was
        // briefly mounted into docker-entrypoint-initdb.d instead, which is
        // wrong twice over: that directory only runs on first initialisation,
        // so no later migration would ever apply, and it needs a file on the
        // server that the rollout does not put there. Every statement is
        // IF NOT EXISTS, so running it each time costs a few milliseconds.
        await pool.query(await readFile(SCHEMA, 'utf8'));
        log.info('geo: connected, schema applied');
        return true;
      } catch (e) {
        // A database that is configured but unreachable must not stop the
        // service: people's positions still matter without a place name.
        log.error('geo: cannot connect —', e && e.message ? e.message : e);
        pool = null;
        return false;
      }
    },

    // Called for positions that actually changed, so a phone repeating itself
    // in a pocket does not fill the table with the same point.
    async record(p) {
      if (!pool || !p || p.latitude === null || p.longitude === null) return false;
      await pool.query(
        `INSERT INTO positions (person, chat, at, geom, accuracy, heading, live, live_until)
         VALUES ($1, $2, to_timestamp($3), ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
                 $6, $7, $8, to_timestamp($9))`,
        [String(p.id), p.chat ?? null, p.at, p.longitude, p.latitude,
         p.accuracy ?? null, p.heading ?? null, Boolean(p.liveUntil), p.liveUntil ?? null],
      );
      return true;
    },

    async placeOf(lat, lon) {
      if (!pool || !Number.isFinite(lat) || !Number.isFinite(lon)) return '';
      try {
        const [road, area] = await Promise.all([
          nearest('planet_osm_line', 'highway IS NOT NULL', lat, lon),
          nearest('planet_osm_polygon', 'TRUE', lat, lon),
        ]);
        return placeName({ road, area });
      } catch (e) {
        // Missing tables mean the extract was never imported. Say so once per
        // call rather than failing the request the dashboard is waiting on.
        log.error('geo: cannot describe a point —', e && e.message ? e.message : e);
        return '';
      }
    },

    // The last known position of everyone seen recently — what the in-memory
    // store would have held if the process had not restarted. Bounded by the
    // same window the store uses, so this cannot bring back someone the store
    // would have dropped anyway.
    async latest(maxAgeSeconds) {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (person)
                person, chat,
                extract(epoch FROM at)::bigint AS at,
                extract(epoch FROM live_until)::bigint AS live_until,
                ST_Y(geom::geometry) AS latitude,
                ST_X(geom::geometry) AS longitude,
                accuracy, heading
           FROM positions
          WHERE at > now() - make_interval(secs => $1)
          ORDER BY person, at DESC`,
        [Number(maxAgeSeconds)],
      );
      // Shaped as positions.update() expects, so restoring is the same code
      // path as an arriving update rather than a second way in.
      return rows.map((r) => ({
        id: String(r.person),
        chat: r.chat ?? null,
        name: '',
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        accuracy: r.accuracy === null ? null : Number(r.accuracy),
        heading: r.heading === null ? null : Number(r.heading),
        at: Number(r.at),
        liveUntil: r.live_until === null ? null : Number(r.live_until),
        stopped: false,
      }));
    },

    // A LineString needs two points; one place is not a path, and refusing is
    // better than sharing a link that opens on nothing.
    async createShare({ token, person, name = '', points, ttlSeconds }) {
      if (!pool || !Array.isArray(points) || points.length < 2) return false;
      const wkt = points.map((p) => `${p.longitude} ${p.latitude}`).join(',');
      await pool.query(
        `INSERT INTO shares (token, person, name, path, expires_at)
         VALUES ($1, $2, $3, ST_GeogFromText($4),
                 now() + make_interval(secs => $5))`,
        [token, String(person), name, `SRID=4326;LINESTRING(${wkt})`, Number(ttlSeconds)],
      );
      return true;
    },

    // Expired shares answer as though they never existed, which is the whole
    // point of the expiry.
    async readShare(token) {
      if (!pool) return null;
      const { rows } = await pool.query(
        `SELECT name,
                extract(epoch FROM created_at)::bigint AS at,
                ST_AsGeoJSON(path::geometry) AS geojson
           FROM shares
          WHERE token = $1 AND expires_at > now()`,
        [String(token)],
      );
      if (!rows[0]) return null;
      const coords = JSON.parse(rows[0].geojson).coordinates || [];
      return {
        name: rows[0].name || '',
        at: Number(rows[0].at),
        // GeoJSON is longitude first; the map wants latitude first.
        points: coords.map(([lon, lat]) => [lat, lon]),
      };
    },

    async revokeShare(token) {
      if (!pool) return 0;
      const res = await pool.query('DELETE FROM shares WHERE token = $1', [String(token)]);
      return res.rowCount;
    },

    // ------------------------------------------------------------- fences
    //
    // The tables have been in schema.sql since PostGIS arrived and nothing
    // used them until now.

    async listFences() {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT id, name, ST_AsGeoJSON(area::geometry) AS geojson,
                ST_Y(ST_Centroid(area::geometry)) AS latitude,
                ST_X(ST_Centroid(area::geometry)) AS longitude
           FROM fences ORDER BY name`,
      );
      return rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        // GeoJSON is longitude first; the map wants latitude first.
        ring: (JSON.parse(r.geojson).coordinates?.[0] || []).map(([lon, lat]) => [lat, lon]),
      }));
    },

    // A circle, expressed as the polygon the column already expects.
    // ST_Buffer on geography takes metres, so the radius means what it says
    // without anybody choosing a projection.
    async createFence({ name, latitude, longitude, radius }) {
      if (!pool) return null;
      const { rows } = await pool.query(
        `INSERT INTO fences (name, area)
         VALUES ($1, ST_Buffer(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)::geography)
         RETURNING id`,
        [String(name), Number(longitude), Number(latitude), Number(radius)],
      );
      return Number(rows[0].id);
    },

    async deleteFence(id) {
      if (!pool) return 0;
      // fence_events cascades on the foreign key, so the history of a deleted
      // fence goes with it rather than becoming rows pointing at nothing.
      const res = await pool.query('DELETE FROM fences WHERE id = $1', [Number(id)]);
      return res.rowCount;
    },

    // One point against every fence: which side, and how far from the edge.
    //
    // Distances in metres because both sides are geography. ST_ExteriorRing
    // rather than ST_Boundary only because it is typed LINESTRING and so casts
    // back to geography cleanly; checked against PostGIS 3.4, the two agree to
    // the metre.
    //
    // No WHERE clause. An ST_DWithin prefilter would use the index but would
    // silently omit the fence somebody has just walked out of, which is the
    // event most worth having. At tens of fences this is a trivial scan; if it
    // ever became thousands, the fix is to prefilter and union in the fences
    // the watcher already holds state for.
    async fencesAt(lat, lon) {
      if (!pool || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const point = `SRID=4326;POINT(${lon} ${lat})`;
      const { rows } = await pool.query(
        `SELECT id, name,
                ST_Intersects(area, $1::geography) AS inside,
                ST_Distance($1::geography, ST_ExteriorRing(area::geometry)::geography) AS margin
           FROM fences`,
        [point],
      );
      return rows.map((r) => ({
        fence: Number(r.id),
        name: r.name,
        inside: r.inside === true,
        margin: Number(r.margin),
      }));
    },

    async recordFenceEvent({ person, fence, entered, at }) {
      if (!pool) return false;
      await pool.query(
        `INSERT INTO fence_events (person, fence_id, entered, at)
         VALUES ($1, $2, $3, to_timestamp($4))`,
        [String(person), Number(fence), Boolean(entered), Number(at)],
      );
      return true;
    },

    // The last thing recorded about each person and fence, so a restart picks
    // up where it left off instead of announcing that everybody has just
    // arrived everywhere.
    async lastFenceStates() {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (person, fence_id) person, fence_id, entered
           FROM fence_events ORDER BY person, fence_id, at DESC`,
      );
      return rows.map((r) => ({
        person: String(r.person),
        fence: Number(r.fence_id),
        where: r.entered ? 'in' : 'out',
      }));
    },

    async historyOf(person, { limit = 500 } = {}) {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT extract(epoch FROM at)::bigint AS at,
                ST_Y(geom::geometry) AS latitude,
                ST_X(geom::geometry) AS longitude
           FROM positions WHERE person = $1
          ORDER BY at DESC LIMIT $2`,
        [String(person), limit],
      );
      return rows.map((r) => ({
        at: Number(r.at),
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
      }));
    },

    // One statement, both tables, so an erasure cannot be half done. This is
    // kept indefinitely otherwise, which is exactly why it has to be possible
    // to remove a person completely and on request.
    async forget(person) {
      if (!pool) return 0;
      const { rows } = await pool.query(
        `WITH gone AS (DELETE FROM positions WHERE person = $1 RETURNING 1),
              ev   AS (DELETE FROM fence_events WHERE person = $1 RETURNING 1),
              sh   AS (DELETE FROM shares WHERE person = $1 RETURNING 1)
         SELECT (SELECT count(*) FROM gone) + (SELECT count(*) FROM ev)
              + (SELECT count(*) FROM sh) AS n`,
        [String(person)],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async close() {
      if (pool) { await pool.end().catch(() => {}); pool = null; }
    },
  };
}
