#!/bin/sh
# setup-postgis.sh — switch on place names and history, once, on the server.
#
#   cd /opt/telegram-live-location && ./bin/setup-postgis.sh
#
# PostGIS is optional and off by default: the postgis service sits behind a
# compose profile, so an ordinary deploy never starts it and never needs a
# password. This turns it on, and is safe to run again — it will not rotate a
# working password or duplicate a line.
#
# It does not import an OpenStreetMap extract. History starts recording
# immediately; place names stay empty until osm2pgsql has run. See the README.

set -eu

ENV_FILE="${ENV_FILE:-/etc/telegram-live-location.env}"
DIR="${DIR:-$(pwd)}"
DB=livegeo
USER=livegeo

cd "$DIR"

[ -f compose.yml ] || { echo "no compose.yml in $DIR — is this the deploy directory?" >&2; exit 1; }
grep -q '^  postgis:' compose.yml || {
  echo "compose.yml has no postgis service. Deploy first so the current one is on the server." >&2
  exit 1
}
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE does not exist" >&2; exit 1; }

# --- the password, invented once and then left alone -------------------------
if grep -q '^POSTGRES_PASSWORD=.' "$ENV_FILE"; then
  echo "POSTGRES_PASSWORD: already set, keeping it"
  PASS=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)
else
  PASS=$(openssl rand -hex 24)
  # Replace an empty assignment rather than adding a second one.
  if grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PASS}|" "$ENV_FILE"
  else
    printf 'POSTGRES_PASSWORD=%s\n' "$PASS" >> "$ENV_FILE"
  fi
  echo "POSTGRES_PASSWORD: generated"
fi

# --- how the app reaches it --------------------------------------------------
# "postgis" is the service name; both containers are on the same compose
# network, so this never leaves the host.
URL="postgres://${USER}:${PASS}@postgis:5432/${DB}"
if grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${URL}|" "$ENV_FILE"
else
  printf 'DATABASE_URL=%s\n' "$URL" >> "$ENV_FILE"
fi
echo "DATABASE_URL: set"

chmod 640 "$ENV_FILE"

# --- keep the profile on for every later deploy ------------------------------
# Compose reads .env from the project directory, so the profile survives the
# next rollout without the workflow having to know about it.
if [ -f .env ] && grep -q '^COMPOSE_PROFILES=' .env; then
  sed -i 's|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=postgis|' .env
else
  printf 'COMPOSE_PROFILES=postgis\n' >> .env
fi
echo "COMPOSE_PROFILES: postgis"

# --- bring it up -------------------------------------------------------------
echo "starting postgis…"
docker compose --profile postgis up -d postgis

printf 'waiting for it to be ready'
i=0
while [ "$i" -lt 60 ]; do
  if docker compose exec -T postgis pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
    echo " ok"
    break
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done
[ "$i" -lt 60 ] || { echo; echo "postgis did not become ready — docker compose logs postgis" >&2; exit 1; }

# The app creates the extension and the tables on connect, so it has to go
# first — an empty database is the expected state at this point.
echo "restarting the app so it picks up DATABASE_URL…"
docker compose --profile postgis up -d --force-recreate app

printf 'waiting for it to apply the schema'
i=0
while [ "$i" -lt 30 ]; do
  if docker compose exec -T postgis psql -U "$USER" -d "$DB" -tAc \
       "SELECT to_regclass('public.positions') IS NOT NULL;" 2>/dev/null | grep -q t; then
    echo " ok"
    break
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done
[ "$i" -lt 30 ] || { echo; echo "the app did not create its tables — docker compose logs app" >&2; exit 1; }

echo "postgis version: $(docker compose exec -T postgis psql -U "$USER" -d "$DB" -tAc 'SELECT postgis_version();')"
echo "tables: $(docker compose exec -T postgis psql -U "$USER" -d "$DB" -tAc \
  "SELECT string_agg(tablename, ' ') FROM pg_tables WHERE schemaname='public';")"

echo
echo "done. History is recording now."
echo "Place names stay empty until an OpenStreetMap extract is imported — README «Places and history»."
