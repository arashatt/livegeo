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

-- People, and who may see whom. Everyone the bot has met is a user; a grant
-- lets `viewer` see `owner`, one way only. Deleting a user takes their grants,
-- invites and fences with them, which is what makes /stop complete.
CREATE TABLE IF NOT EXISTS users (
  id         text PRIMARY KEY,
  name       text NOT NULL DEFAULT '',
  username   text NOT NULL DEFAULT '',
  -- Telegram's OpenID sign-in issues a subject id scoped to the site, which
  -- does not match the id the bot sees. Linked once, when both are known.
  oidc_sub   text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grants (
  owner      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, viewer),
  CHECK (owner <> viewer)
);
CREATE INDEX IF NOT EXISTS grants_viewer_idx ON grants (viewer);

-- A one-time link that lets whoever opens it see the person who made it.
CREATE TABLE IF NOT EXISTS invites (
  token      text PRIMARY KEY,
  owner      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Whose fence this is. NULL for fences made before there were owners, which
-- only admins see.
ALTER TABLE fences ADD COLUMN IF NOT EXISTS owner text REFERENCES users(id) ON DELETE CASCADE;

-- A watch, paired once with a code and known afterwards by its token. Only
-- the token's SHA-256 is kept: reading this table tells you which devices
-- exist, not how to be one.
CREATE TABLE IF NOT EXISTS devices (
  id           bigserial PRIMARY KEY,
  owner        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL DEFAULT '',
  platform     text NOT NULL DEFAULT '',
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

-- Places somebody hides from their circle. The centre is not the spot they
-- picked: it was moved at random by up to half the radius when the place was
-- made, and the spot itself was never stored (see zones.js for why).
CREATE TABLE IF NOT EXISTS zones (
  id         bigserial PRIMARY KEY,
  owner      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL DEFAULT '',
  centre     geography(Point, 4326) NOT NULL,
  radius     real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zones_owner_idx ON zones (owner);

-- Where a shared path resumes after a hidden stretch, as indexes into it. A
-- LineString has no way to say "and then a jump", so the jumps sit beside it,
-- the same way the times do.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS breaks int[];

-- A link that lets whoever holds it follow one person live, for a while (see
-- live.js). Kept here so a restart does not end every link early — and an SOS
-- is one of these with reason 'sos', which is how an emergency outlasts a
-- deploy. Nothing about where anybody went is stored with it.
CREATE TABLE IF NOT EXISTS live_links (
  token      text PRIMARY KEY,
  person     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     text NOT NULL DEFAULT 'share',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS live_links_person_idx ON live_links (person);
