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

-- Which installation of the watch app paired, as the watch says (a random id
-- of its own). The same one pairing again, when the map's address changed,
-- replaces its old entry instead of leaving its old token working.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS install text NOT NULL DEFAULT '';

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

-- Somebody who asked to be checked on (checks.js): until when, and how far the
-- conversation about a stop has got — asked, told, answered. Kept so that a
-- restart does not silently end a check somebody is relying on.
CREATE TABLE IF NOT EXISTS checks (
  person     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  asked_at   timestamptz,
  told_at    timestamptz,
  ok_at      timestamptz
);

-- Road reports (incidents.js): closed roads, accidents, hazards and jams,
-- shown to everyone who can sign in and never with who reported them. A
-- reporter is a keyed hash of their id, not the id, so these tables do not
-- say who said what. `logit` is the belief at `last_at`, before it fades;
-- `peak` the most it has been believed, which decides whether it is shown.
CREATE TABLE IF NOT EXISTS incidents (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  geom       geography(Point, 4326) NOT NULL,
  heading    real,
  reporter   text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  last_at    timestamptz NOT NULL,
  logit      double precision NOT NULL,
  peak       double precision NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'active',
  resolved   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status);
-- Every report, "still there" and "not there", as it came: append-only, so a
-- belief can always be worked out again.
CREATE TABLE IF NOT EXISTS incident_evidence (
  incident bigint NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  reporter text NOT NULL,
  kind     text NOT NULL,
  weight   double precision NOT NULL,
  at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_evidence_incident_idx ON incident_evidence (incident);
-- How reliable each reporter has been, as Beta(alpha, beta).
CREATE TABLE IF NOT EXISTS reporters (
  reporter text PRIMARY KEY,
  alpha    double precision NOT NULL DEFAULT 3,
  beta     double precision NOT NULL DEFAULT 2
);
-- Whether the bot may ask somebody "still there?", and whether it has told
-- them it will.
CREATE TABLE IF NOT EXISTS road_prefs (
  person    text PRIMARY KEY,
  questions boolean NOT NULL DEFAULT true,
  told      boolean NOT NULL DEFAULT false
);
