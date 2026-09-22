-- schema.sql — what livegeo keeps in PostGIS.
--
-- Two different kinds of thing live in this database. The `positions`,
-- `fences` and `fence_events` tables are ours. The `planet_osm_*` tables are
-- produced by osm2pgsql from an OpenStreetMap extract and are only ever read.
--
--   osm2pgsql -d livegeo --create --slim -C 2000 --hstore <region>-latest.osm.pbf
--
-- Geography rather than geometry throughout, so distances come back in metres
-- without anyone having to think about projections.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS positions (
  id        bigserial PRIMARY KEY,
  person    text NOT NULL,
  chat      text,
  at        timestamptz NOT NULL,
  geom      geography(Point, 4326) NOT NULL,
  accuracy  real,
  heading   real,
  live      boolean NOT NULL DEFAULT false
);
-- Added after the fact: `live` says a position was live when it was recorded,
-- but not for how long. Without the deadline a restored position cannot be
-- shown as live with time remaining, which is most of what makes it useful.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS live_until timestamptz;

CREATE INDEX IF NOT EXISTS positions_geom_idx ON positions USING gist (geom);
-- Reading a history is always "this person, most recent first".
CREATE INDEX IF NOT EXISTS positions_person_at_idx ON positions (person, at DESC);

CREATE TABLE IF NOT EXISTS fences (
  id   bigserial PRIMARY KEY,
  name text NOT NULL,
  area geography(Polygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS fences_area_idx ON fences USING gist (area);

CREATE TABLE IF NOT EXISTS fence_events (
  id       bigserial PRIMARY KEY,
  person   text NOT NULL,
  fence_id bigint REFERENCES fences(id) ON DELETE CASCADE,
  entered  boolean NOT NULL,
  at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS fence_events_person_at_idx ON fence_events (person, at DESC);

-- A path somebody chose to hand to somebody else. A frozen copy rather than a
-- reference: the link should show what was shared at the moment of sharing,
-- and should not quietly keep following a person afterwards. It expires by
-- itself, and can be revoked before that.
CREATE TABLE IF NOT EXISTS shares (
  token      text PRIMARY KEY,
  person     text NOT NULL,
  name       text NOT NULL DEFAULT '',
  path       geography(LineString, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_expires_idx ON shares (expires_at);
-- When each vertex of a shared path was passed, in epoch seconds, index for
-- index with the line. Added after shares existed; older rows have none.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS times bigint[];
