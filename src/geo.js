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
    async createShare({ token, person, name = '', points, breaks = [], ttlSeconds }) {
      if (!pool || !Array.isArray(points) || points.length < 2) return false;
      const wkt = points.map((p) => `${p.longitude} ${p.latitude}`).join(',');
      // When each point was passed, kept beside the line rather than in it:
      // PostGIS can carry a measure per vertex, but an array the page reads
      // directly is simpler than asking every query to unpack one.
      const times = points.map((p) => (Number.isFinite(Number(p.at)) ? Math.floor(Number(p.at)) : null));
      await pool.query(
        `INSERT INTO shares (token, person, name, path, times, breaks, expires_at)
         VALUES ($1, $2, $3, ST_GeogFromText($4), $6::bigint[], $7::int[],
                 now() + make_interval(secs => $5))`,
        [token, String(person), name, `SRID=4326;LINESTRING(${wkt})`, Number(ttlSeconds), times,
         (breaks || []).map(Number)],
      );
      return true;
    },

    // Expired shares answer as though they never existed, which is the whole
    // point of the expiry.
    async readShare(token) {
      if (!pool) return null;
      const { rows } = await pool.query(
        `SELECT name, times, breaks, person,
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
        // Shares made before times were kept have none, and say so by being
        // null rather than by inventing any.
        times: Array.isArray(rows[0].times) && rows[0].times.length === coords.length
          ? rows[0].times.map((t) => (t === null ? null : Number(t)))
          : null,
        // Where the path resumes after a hidden stretch. Older shares had
        // none to keep.
        breaks: Array.isArray(rows[0].breaks) ? rows[0].breaks.map(Number) : [],
        // Whose path it is — for the server, which applies their private
        // places when the share is read. Never sent to the page.
        person: String(rows[0].person),
      };
    },

    async shareOwner(token) {
      if (!pool) return null;
      const { rows } = await pool.query('SELECT person FROM shares WHERE token = $1', [String(token)]);
      return rows[0] ? String(rows[0].person) : null;
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

    // Everybody's fences when `owner` is undefined (an admin, or the watcher
    // that needs all of them); otherwise only that person's. A fence is a
    // named place in somebody's life — "home" — and is theirs, not the map's.
    async listFences({ owner } = {}) {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT id, name, owner, ST_AsGeoJSON(area::geometry) AS geojson,
                ST_Y(ST_Centroid(area::geometry)) AS latitude,
                ST_X(ST_Centroid(area::geometry)) AS longitude
           FROM fences
          WHERE $1::text IS NULL OR owner = $1
          ORDER BY name`,
        [owner === undefined ? null : String(owner)],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        owner: r.owner ?? null,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        // GeoJSON is longitude first; the map wants latitude first.
        ring: (JSON.parse(r.geojson).coordinates?.[0] || []).map(([lon, lat]) => [lat, lon]),
      }));
    },

    // A circle, expressed as the polygon the column already expects.
    // ST_Buffer on geography takes metres, so the radius means what it says
    // without anybody choosing a projection.
    async createFence({ name, latitude, longitude, radius, owner = null }) {
      if (!pool) return null;
      const { rows } = await pool.query(
        `INSERT INTO fences (name, area, owner)
         VALUES ($1, ST_Buffer(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)::geography, $5)
         RETURNING id`,
        [String(name), Number(longitude), Number(latitude), Number(radius), owner === null ? null : String(owner)],
      );
      return Number(rows[0].id);
    },

    async fenceOwner(id) {
      if (!pool) return undefined;
      const { rows } = await pool.query('SELECT owner FROM fences WHERE id = $1', [Number(id)]);
      // undefined: no such fence. null: an ownerless, admin-only one.
      return rows[0] ? rows[0].owner ?? null : undefined;
    },

    async countFences(owner) {
      if (!pool) return 0;
      const { rows } = await pool.query('SELECT count(*) AS n FROM fences WHERE owner = $1', [String(owner)]);
      return Number(rows[0].n);
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
        `SELECT id, name, owner,
                ST_Intersects(area, $1::geography) AS inside,
                ST_Distance($1::geography, ST_ExteriorRing(area::geometry)::geography) AS margin
           FROM fences`,
        [point],
      );
      return rows.map((r) => ({
        fence: Number(r.id),
        name: r.name,
        owner: r.owner ?? null,
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

    // ------------------------------------------------------------- circles

    async upsertUser({ id, name = '', username = '' }) {
      if (!pool) return false;
      await pool.query(
        `INSERT INTO users (id, name, username) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username`,
        [String(id), String(name).slice(0, 200), String(username).slice(0, 64)],
      );
      return true;
    },

    // Telegram's OpenID subject is scoped to this site and does not match the
    // id the bot sees, so the two are linked once and remembered.
    async userBySub(sub) {
      if (!pool) return null;
      const { rows } = await pool.query('SELECT id FROM users WHERE oidc_sub = $1', [String(sub)]);
      return rows[0] ? String(rows[0].id) : null;
    },

    async linkSub(id, sub) {
      if (!pool) return false;
      // A subject belongs to one person; linking it again moves it.
      await pool.query('UPDATE users SET oidc_sub = NULL WHERE oidc_sub = $2 AND id <> $1', [String(id), String(sub)]);
      const res = await pool.query('UPDATE users SET oidc_sub = $2 WHERE id = $1', [String(id), String(sub)]);
      return res.rowCount === 1;
    },

    async listUsers() {
      if (!pool) return [];
      const { rows } = await pool.query('SELECT id, name, username FROM users');
      return rows.map((r) => ({ id: String(r.id), name: r.name, username: r.username }));
    },

    async listGrants() {
      if (!pool) return [];
      const { rows } = await pool.query('SELECT owner, viewer FROM grants');
      return rows.map((r) => ({ owner: String(r.owner), viewer: String(r.viewer) }));
    },

    async addGrant(owner, viewer) {
      if (!pool) return false;
      await pool.query(
        'INSERT INTO grants (owner, viewer) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [String(owner), String(viewer)],
      );
      return true;
    },

    async removeGrant(owner, viewer) {
      if (!pool) return 0;
      const res = await pool.query('DELETE FROM grants WHERE owner = $1 AND viewer = $2', [String(owner), String(viewer)]);
      return res.rowCount;
    },

    async createInvite({ token, owner, ttlSeconds }) {
      if (!pool) return false;
      await pool.query(
        `INSERT INTO invites (token, owner, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [String(token), String(owner), Number(ttlSeconds)],
      );
      return true;
    },

    // Single use: the row is gone whether or not the invite had expired, and
    // only a live one returns its owner.
    async redeemInvite(token) {
      if (!pool) return null;
      const { rows } = await pool.query(
        'DELETE FROM invites WHERE token = $1 RETURNING owner, expires_at > now() AS live',
        [String(token)],
      );
      return rows[0] && rows[0].live ? String(rows[0].owner) : null;
    },

    // ------------------------------------------------------------- devices

    async listDevices() {
      if (!pool) return [];
      const { rows } = await pool.query('SELECT id, owner, name, platform, token_hash FROM devices');
      return rows.map((r) => ({ ...r, id: Number(r.id), owner: String(r.owner) }));
    },

    async createDevice({ owner, name, platform, tokenHash }) {
      const { rows } = await pool.query(
        `INSERT INTO devices (owner, name, platform, token_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [String(owner), name, platform, tokenHash],
      );
      return Number(rows[0].id);
    },

    async deleteDevice(id) {
      if (!pool) return 0;
      const res = await pool.query('DELETE FROM devices WHERE id = $1', [Number(id)]);
      return res.rowCount;
    },

    async touchDevice(id) {
      if (!pool) return;
      await pool.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [Number(id)]);
    },

    // ----------------------------------------------------- private places

    async listZones() {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT id, owner, name, radius,
                ST_Y(centre::geometry) AS latitude, ST_X(centre::geometry) AS longitude
           FROM zones`,
      );
      return rows.map((r) => ({
        id: Number(r.id), owner: String(r.owner), name: r.name,
        latitude: Number(r.latitude), longitude: Number(r.longitude), radius: Number(r.radius),
      }));
    },

    // Given the centre already moved; the spot that was clicked never gets
    // this far.
    async createZone({ owner, name = '', latitude, longitude, radius }) {
      const { rows } = await pool.query(
        `INSERT INTO zones (owner, name, centre, radius)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
         RETURNING id`,
        [String(owner), String(name).slice(0, 80), Number(longitude), Number(latitude), Number(radius)],
      );
      return Number(rows[0].id);
    },

    async deleteZone(id) {
      if (!pool) return 0;
      const res = await pool.query('DELETE FROM zones WHERE id = $1', [Number(id)]);
      return res.rowCount;
    },

    // ---------------------------------------------------------- live links

    async listLiveLinks() {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT token, person, reason,
                extract(epoch FROM created_at)::bigint AS created,
                extract(epoch FROM expires_at)::bigint AS expires
           FROM live_links
          WHERE expires_at > now()`,
      );
      return rows.map((r) => ({
        token: r.token, person: String(r.person), reason: r.reason,
        createdAt: Number(r.created), expiresAt: Number(r.expires),
      }));
    },

    // Links that ran out are cleared as new ones are made; nothing reads them.
    async createLiveLink({ token, person, reason, createdAt, expiresAt }) {
      await pool.query('DELETE FROM live_links WHERE expires_at < now()');
      await pool.query(
        `INSERT INTO live_links (token, person, reason, created_at, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))`,
        [String(token), String(person), String(reason), Number(createdAt), Number(expiresAt)],
      );
      return true;
    },

    async revokeLiveLink(token) {
      if (!pool) return 0;
      const res = await pool.query('DELETE FROM live_links WHERE token = $1', [String(token)]);
      return res.rowCount;
    },

    // -------------------------------------------------------------- checks

    async listChecks() {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT person,
                extract(epoch FROM started_at)::bigint AS started,
                extract(epoch FROM ends_at)::bigint AS ends,
                extract(epoch FROM asked_at)::bigint AS asked,
                extract(epoch FROM told_at)::bigint AS told,
                extract(epoch FROM ok_at)::bigint AS ok
           FROM checks
          WHERE ends_at > now()`,
      );
      const at = (v) => (v === null ? null : Number(v));
      return rows.map((r) => ({
        person: String(r.person), startedAt: Number(r.started), until: Number(r.ends),
        askedAt: at(r.asked), toldAt: at(r.told), okAt: at(r.ok),
      }));
    },

    async saveCheck({ person, startedAt, until, askedAt = null, toldAt = null, okAt = null }) {
      await pool.query(
        `INSERT INTO checks (person, started_at, ends_at, asked_at, told_at, ok_at)
         VALUES ($1, to_timestamp($2::double precision), to_timestamp($3::double precision),
                 to_timestamp($4::double precision), to_timestamp($5::double precision),
                 to_timestamp($6::double precision))
         ON CONFLICT (person) DO UPDATE
           SET started_at = EXCLUDED.started_at, ends_at = EXCLUDED.ends_at,
               asked_at = EXCLUDED.asked_at, told_at = EXCLUDED.told_at, ok_at = EXCLUDED.ok_at`,
        [String(person), startedAt, until, askedAt, toldAt, okAt],
      );
      return true;
    },

    async deleteCheck(person) {
      if (!pool) return 0;
      const res = await pool.query('DELETE FROM checks WHERE person = $1', [String(person)]);
      return res.rowCount;
    },

    async historyOf(person, { limit = 500, since = null, until = null } = {}) {
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT extract(epoch FROM at)::bigint AS at,
                ST_Y(geom::geometry) AS latitude,
                ST_X(geom::geometry) AS longitude
           FROM positions
          WHERE person = $1 AND ($3::bigint IS NULL OR at > to_timestamp($3))
                AND ($4::bigint IS NULL OR at <= to_timestamp($4))
          ORDER BY at DESC LIMIT $2`,
        [String(person), limit, since === null ? null : Math.floor(Number(since)),
         until === null ? null : Math.floor(Number(until))],
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
              sh   AS (DELETE FROM shares WHERE person = $1 RETURNING 1),
              ll   AS (DELETE FROM live_links WHERE person = $1 RETURNING 1),
              ck   AS (DELETE FROM checks WHERE person = $1 RETURNING 1),
              -- Grants, invites, devices, their fences and private places
              -- go with the user row, on the foreign keys' cascade.
              us   AS (DELETE FROM users WHERE id = $1 RETURNING 1)
         SELECT (SELECT count(*) FROM gone) + (SELECT count(*) FROM ev)
              + (SELECT count(*) FROM sh) + (SELECT count(*) FROM ll)
              + (SELECT count(*) FROM ck) + (SELECT count(*) FROM us) AS n`,
        [String(person)],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async close() {
      if (pool) { await pool.end().catch(() => {}); pool = null; }
    },
  };
}
