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
