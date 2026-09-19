# telegram-live-location

A live map of the locations people share with a Telegram account.

Someone shares a live location in a chat; this service is in that chat, so
Telegram tells it every time they move, and an open browser tab shows the
marker move with them — pushed, not polled.

```
Telegram  ──MTProto──▶  src/mtproto.js  ──▶  src/positions.js  ──SSE──▶  browser
 (edits to one message)     (adapter)            (store)              (OSM map)
```

## What it cannot do

**It cannot find where someone is.** Nothing in Telegram can. Every method
in the live-location API is either *"here is my location"* or *"read a
location somebody chose to share"*; `messages.getRecentLocations` returns
locations already sent to a chat. This service shows you what people
deliberately shared with the account it runs as, and nothing else.

Treat what it does show as personal data. Everyone whose position appears
here chose to share it *in Telegram* — they did not choose to have it put on
a web page, so tell them, keep the dashboard private, and keep the retention
short (`STALE_AFTER`).

That last part stops being true the moment you set `DATABASE_URL`: positions
are then written to PostGIS and kept until something deletes them. See
«Places and history» before turning it on.

## Why a user account rather than a bot

A bot is only told about locations shared **with the bot**. A user account is
told about locations shared in **any chat it is in**. That is the only
difference, and it is why this needs MTProto and therefore a real account —
what Telegram calls a userbot.

The consequence: this cannot run on Cloudflare Workers. MTProto is a binary
protocol over a raw TCP socket, and the client holds a long-lived connection
and session. It needs an always-on Node host — the smallest VPS will do.

## Setting it up

**① Credentials.** Sign in at [my.telegram.org](https://my.telegram.org) →
*API development tools* → note the **api_id** and **api_hash**. These identify
the application, not the account.

**② Install.**

```sh
git clone <this repo> && cd telegram-live-location
npm install
```

**③ Sign in, once.** This is the only interactive step:

```sh
TELEGRAM_API_ID=… TELEGRAM_API_HASH=… npm run login
```

It asks for a phone number, the code Telegram sends, and a two-step password
if the account has one, then prints a **session string**.

> The session string is a signed-in session. Anyone who holds it is signed in
> as that account — treat it exactly like the password, never commit it.

**④ Configure.** Put the values in an environment file, e.g. `/etc/telegram-live-location.env`:

```sh
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=…
TELEGRAM_SESSION=…            # from step ③
DASHBOARD_TOKEN=…             # invent a long random string
TELEGRAM_CHATS=               # chat ids to watch; empty = every chat
PORT=8080
HOST=127.0.0.1
STALE_AFTER=3600              # drop a position nobody updated for this long
TRAIL_MAX=120                 # points kept in the path behind each person
MIN_MOVE=25                   # metres before a fix counts as travel, not noise
DATABASE_URL=                 # optional PostGIS — see «Places and history»
TILE_UPSTREAM=                # where basemap tiles come from; default is OSM
TILE_CACHE=                   # where they are kept; default /tmp/livegeo-tiles
TILE_MAX_AGE=2592000          # seconds before a cached tile is refetched
SHARE_TTL=604800              # how long a shared path link stays readable
```

Leaving `TELEGRAM_CHATS` empty means *every chat the account is in* is
watched. Naming the one chat you mean is almost always what you want.

**⑤ Run.**

```sh
set -a; . /etc/telegram-live-location.env; set +a
npm start
```

Then open `http://<host>:8080/?token=<DASHBOARD_TOKEN>`. The token is stored
in a cookie on first load, so it leaves the address bar.

### As a service

```ini
# /etc/systemd/system/telegram-live-location.service
[Unit]
Description=Telegram live location map
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/telegram-live-location
EnvironmentFile=/etc/telegram-live-location.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The page does not depend on that stream arriving. If nothing comes within eight
seconds of opening it, or if the stream goes quiet for seventy, it falls back to
asking `/api/positions` every five seconds and says `polling` where it would say
`live`. That is there because a proxy that buffers a stream produces a dashboard
that looks connected and shows nothing, which is the worst way for this to fail.

Falling back is not permanent. It retries the stream every minute and goes back
to `live` the moment one delivers, so a page left open across a change in what
is in front of it recovers on its own.

Behind nginx, **turn buffering off** or the live stream will arrive in
lumps — the app sends `X-Accel-Buffering: no`, but be explicit:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

## Using it

In Telegram, in a chat the account is in: 📎 → **Location** → **Share My Live
Location for…**. The marker appears and follows them until the period ends or
they stop sharing.

A one-off location (📎 → Location → *Send this location*) also shows, as a
point that is never marked live.

The dashboard lists everyone currently sharing, marks live ones, counts down
the time remaining, and draws the path behind each. Clicking a person centres
the map on them.

### Why the path is not every reading

A phone that is not moving does not report a position that is not moving: the
fix wanders inside its own accuracy radius several times a minute. Drawn, that
is a scribble where somebody stood still — and since two fixes each accurate to
r can differ by nearly 2r through noise alone, small differences carry no
information at all.

So a reading only joins the path when it is further from the last one than the
uncertainty in it — `MIN_MOVE` metres, or the accuracy Telegram reports for
that fix, whichever is larger. Below that the marker stays where it is rather
than twitching, and nothing is recorded. The entry is still kept alive, so
standing still does not make somebody expire off the map.

Raise `MIN_MOVE` if paths still look restless, lower it if short walks are
being missed. It is only the floor: a poor fix always raises the bar for
itself.

## How live locations actually work

A live location is **one message that its sender keeps editing**. So:

- the first position arrives as a new message
- every later position is an **edit of that same message**
  (`updateEditMessage` / `updateEditChannelMessage`)
- sharing ends with a final edit whose point is `geoPointEmpty`

Two consequences the code depends on. A sender keeps **one** entry that moves,
rather than accumulating entries. And `period` is stored as a **deadline**
rather than a boolean, so if the closing edit never arrives — a dropped
connection, a restart — the marker stops calling itself live on its own.

One detail worth knowing: `stopped` is a field of `inputMediaGeoLive`, the
*sending* side. The `messageMediaGeoLive` a receiver gets has no such field,
so an empty point is the only real end-of-sharing signal. The parser keeps a
check for the flag anyway, and a test pins down that the wire format does not
carry one.

## Putting it behind a Cloudflare Worker

The dashboard is bound to loopback, so reaching it means an ssh tunnel. A
Worker on `*.workers.dev` is a free public HTTPS hostname with no domain and no
tunnel — useful when the network you read it from blocks more than it allows.

One browser rule decides the shape of this. **An HTTPS page cannot call an HTTP
API**, and this service cannot serve HTTPS without a certificate it has no
domain to obtain. So the Worker is the browser's only origin: it serves the
vendored Leaflet, caches tiles at the edge, and proxies everything else here.

**That means live positions pass through Cloudflare.** Today they never leave
your server. This is the one thing to decide before setting it up, and it is
why none of it is on by default.

Nothing in `public/index.html` changes — every path on the page is relative, and
a single origin keeps them all resolving.

### First, the way in that opens no way in

Before the published port below: there is a second route, and for most people
it is the better one. Cloudflare Tunnel is **outbound**. `cloudflared` dials
Cloudflare on port 7844 and requests arrive back down the connection it opened,
so the service keeps its loopback binding, nothing is published, and the
question of whether `ufw` can filter a Docker port never comes up. It also puts
TLS on the Cloudflare-to-server hop, which the published-port route cannot do
at all, having no certificate and no name to get one for.

```sh
docker compose --profile tunnel up -d
docker compose logs tunnel | grep -o 'https://[^ ]*trycloudflare.com'
```

That prints a public HTTPS address for the dashboard. No account, no domain, no
Worker. Leave `EDGE_KEY` unset for this — with it set the tunnel arrives at a
service that answers nobody.

cloudflared buffers server-sent events on a **GET** request and releases them
only when the connection closes ([cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449),
open) — and delivers the identical stream over **POST** as it arrives. So the
page opens `/api/stream` with POST and reads it by hand, rather than using
`EventSource`, which can only ever issue a GET. That keeps the dashboard live
through a tunnel instead of degrading it to polling.

What it costs: a quick tunnel's hostname is random and **changes every time
cloudflared restarts**, and Cloudflare offers it with no uptime guarantee. It
is the right tool for reaching the dashboard today and the wrong one to build a
habit on. Any domain on Cloudflare's nameservers turns it into a named tunnel
with a hostname you keep — set `TUNNEL_TOKEN` from the Zero Trust dashboard and
`TUNNEL_ARGS=run` in `.env`, beside `compose.yml`.

If UDP is filtered where this runs, `TUNNEL_PROTOCOL=http2` moves the same
connection to TCP on the same port.

A named tunnel is also what makes Cloudflare Access possible, which would
replace the shared dashboard token with per-person sign-in. Worth knowing,
because the token is one secret held by everyone who has it and there is no
taking it back from one of them.

The two combine: point the Worker's `ORIGIN` at the tunnel hostname and you get
edge tile caching and a stable `workers.dev` address in front of an origin that
is still not listening for anything. That also sidesteps the IP problem
described further down, since a tunnel hostname is a hostname.

### Setting it up with a published port

On the server. **These go in two different files**, and putting them in the
wrong one fails quietly: `EDGE_KEY` is read by the service, while `BIND` is
read by Compose when it builds the port mapping, and Compose does not look at
`env_file` for that.

```sh
cd /opt/telegram-live-location

# read by the service, inside the container
echo "EDGE_KEY=$(openssl rand -hex 24)" >> /etc/telegram-live-location.env

# read by Compose, substituted into the port mapping
echo 'BIND=0.0.0.0' >> .env

docker compose up -d
docker ps --format '{{.Names}}  {{.Ports}}'    # expect 0.0.0.0:8080->8080
```

Set `EDGE_KEY` **last**, or set it after the Worker is deployed: from the
moment it exists the service answers nobody else, so an ssh tunnel to the
dashboard gets `403` until there is an edge to come through.

`EDGE_KEY` means a scanner that finds the open port gets `403` without having
to guess the dashboard token to learn that. It is the control that matters
here.

An IP allowlist is defence in depth on top of it, and **`ufw` cannot provide
it**: Docker publishes a port by inserting its own rules ahead of ufw's INPUT
chain, so `ufw deny 8080` appears to work and does nothing. It has to go in the
`DOCKER-USER` chain instead, and a mistake in the ordering there locks you out
of the machine rather than the port. Worth doing deliberately, with console
access to hand, rather than as a final step over ssh.

The Worker needs a **hostname** for the server, not its IP. A Worker cannot
fetch a bare IP at all: the subrequest leaves through Cloudflare's own network,
which refuses it with `error code: 1003` and returns that page as though the
service had answered. Any name that resolves to the address will do, and one
costs nothing:

```sh
# no account, no setup — the address is the name
ORIGIN_HOST=65.109.176.30.sslip.io
getent hosts "$ORIGIN_HOST"                       # confirm it points at you
curl -sS "http://$ORIGIN_HOST:8080/healthz"       # and that it answers
```

[DuckDNS](https://www.duckdns.org) gives you a name of your own for the same
price and does not depend on someone else's wildcard resolver staying up.

Then deploy the Worker:

```sh
cd worker
npx wrangler secret put ORIGIN            # http://<hostname>:8080 — not an IP
npx wrangler secret put EDGE_KEY          # the same value
npx wrangler secret put DASHBOARD_TOKEN   # the same value again
npx wrangler deploy
```

`DASHBOARD_TOKEN` is there so the Worker can gate tiles the way this service
does, rather than becoming an open tile proxy for anyone who finds the
hostname.

### Switching back

Remove `BIND` and `EDGE_KEY` and `docker compose up -d`; stop a tunnel with
`docker compose --profile tunnel down`. The service is
untouched by any of this — it serves its own page, its own tiles and its own
API throughout — so going back is closing the port, not a migration. The Worker
can be left deployed; without a reachable origin it simply stops being useful.

### What it costs

The leg from Cloudflare to the server is plain HTTP, because the server has no
certificate. Positions are encrypted from the browser to Cloudflare and not for
the rest of the way, which is worth knowing before turning this on and is
fixable only by giving the server a name it can get a certificate for.

The free tier allows 100k requests a day, and every tile is one invocation even
when the edge already has it — roughly one to two thousand map pans. The app's
25-second heartbeat keeps `/api/stream` inside Cloudflare's 100-second idle
timeout. How many simultaneous streams the free tier tolerates is not something
this has been measured against; for a handful of viewers it has not come up.

A Worker passes the stream through unbuffered — it returns the upstream body
rather than reading it — so this route was live before the POST change and is
unaffected by it.

## The basemap comes from here

The page makes no third-party requests. Leaflet is served from
`public/vendor`, and map tiles come through `/tiles/{z}/{x}/{y}.png`, which
fetches from OpenStreetMap once and then caches on disk.

This is not about speed. The browser and the server are often on very
different networks — the dashboard is frequently reached over an ssh tunnel
from somewhere that filters heavily, while the server itself sits somewhere
that does not. Proxying means the map works whenever the *server* can reach
OSM, rather than requiring it of whoever is looking at the page.

It also degrades the right way. If the upstream is unreachable and a tile was
fetched before, the cached copy is served and the response says
`x-tile-source: stale` — a slightly old map beats a grid of grey squares.

Tiles are behind the dashboard token like everything else, so this cannot be
used as somebody else's free tile proxy.

OSM's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
covers a private dashboard with a month-long cache. If this ever serves more
than a handful of people, run your own renderer and point `TILE_UPSTREAM` at
it — it is one environment variable, and the PostGIS extract from the next
section is most of what a renderer needs anyway.

## Handing a path to somebody

Clicking a person opens their card; if they have gone anywhere, it offers a
link. Anyone with that link sees that one path on a map, without the dashboard
token.

It is a **frozen copy**, not a window. The link shows what had been travelled
at the moment of sharing and does not keep following the person afterwards,
which is the difference between sharing a walk and handing over a tracker. It
expires after `SHARE_TTL` — a week by default — and the card can revoke it
before that.

The link admits exactly three things: the viewer page, the one path behind it,
and the map tiles that page draws on. It is not a way into the dashboard, the
positions, or anybody else's path, and there are tests that say so.

Worth being deliberate about, because this is the one feature here that hands
somebody else's movements to a third party. The person walking agreed to share
a live location in a chat. A link is a further step, and it is yours to take on
their behalf — which is why it expires on its own and why revoking is one
click. Requires PostGIS; without `DATABASE_URL` the button reports that rather
than appearing to work.

## Places and history

Turn it on, on the server. The deploy copies `compose.yml` but nothing else,
so fetch the script alongside it:

```sh
cd /opt/telegram-live-location
curl -fsSLO https://raw.githubusercontent.com/arashatt/livegeo/main/bin/setup-postgis.sh
chmod +x setup-postgis.sh && ./setup-postgis.sh
```

It invents a password, writes `DATABASE_URL`, starts PostGIS and restarts the
app. Running it twice is harmless — it will not rotate a working password.

PostGIS is off until then. The service sits behind a compose profile, so an
ordinary deploy never starts it and never needs a password; a server that has
not run the script deploys exactly as before.

Without `DATABASE_URL` the service is as it always was: positions live in
memory and `STALE_AFTER` throws them away. With it, PostGIS does three things.

**It names places.** `36.36457, 59.49061` becomes *Vakilabad Blvd, Mashhad*,
by asking an OpenStreetMap extract what is nearest. A road is only named if
you are within 120m of it and an area within 25km, because the nearest named
thing to a point at sea is a city on another continent and saying so would be
worse than saying nothing.

**It survives a restart.** The store is in memory, so a deploy used to blank
the map until everyone happened to move again — which, for someone standing
still or whose sharing had just ended, was never. At startup the last known
position of everyone seen within `STALE_AFTER` is read back, before Telegram is
even connected. Without a database the same gap is narrowed by asking the
account's own chats what is currently being shared, so a restart recovers
whoever is still sharing even with `TELEGRAM_CHATS` empty.

**It remembers.** Every position that actually moved is written to the
`positions` table and kept until deleted. This is the part to be deliberate
about — it is a record of where people went, and they agreed to share a live
location in a chat, not to be logged. The dashboard's *forget* button erases
a person from the database as well as from the map, and `POST /api/forget/<id>`
does the same from a script.

Import an extract for your region — a country, not the planet:

```sh
apt-get install -y osm2pgsql
curl -O https://download.geofabrik.de/asia/iran-latest.osm.pbf
osm2pgsql -d livegeo --create --slim -C 2000 --hstore iran-latest.osm.pbf
```

Leave the defaults alone: the queries expect osm2pgsql's own `planet_osm_*`
tables in SRID 3857, which is what `--create` writes without `-l`.

`sql/schema.sql` holds our own tables and is applied automatically by the
`postgis` service in `compose.yml` the first time it starts. Everything still
works before the extract is imported — place names come back empty until the
`planet_osm_*` tables exist, and history is unaffected either way.

OpenStreetMap data is ODbL. Using an extract to geocode is unproblematic;
redistributing a derived database carries share-alike obligations, and the
attribution on the map has to stay.

## Deploying

Two workflows. **CI** runs the tests on Node 20 and 22 for every push and pull
request, checks every module still loads, and checks that starting without
configuration fails with a clear message rather than something obscure.

**Deploy** runs on `main`: it builds the image, *starts it and calls
`/healthz`*, checks the dashboard still answers `401` without a token, and
only then publishes to `ghcr.io/<you>/telegram-live-location`. An image that
cannot serve is never pushed.

The rollout step is **skipped until you give it a server**, so the workflow is
green from the first push rather than red until configured.

### Pointing it at your server

On the server, once:

```sh
mkdir -p /opt/telegram-live-location && cd /opt/telegram-live-location
curl -O https://raw.githubusercontent.com/<you>/telegram-live-location/main/compose.yml
# and put the secrets from «Setting it up» in:
$EDITOR /etc/telegram-live-location.env
```

The registry is private if the repository is, so let the server read it with a
[personal access token](https://github.com/settings/tokens) that has
`read:packages`:

```sh
echo <token> | docker login ghcr.io -u <you> --password-stdin
```

Then in the repository, under **Settings → Secrets and variables → Actions**:

| | name | what |
|---|---|---|
| Variable | `DEPLOY_HOST` | the server's hostname or address — **setting this is what turns the rollout on** |
| Variable | `DEPLOY_USER` | the ssh user (default `root`) |
| Variable | `DEPLOY_SSH_PORT` | the ssh port (default `22`) — not to be confused with `DEPLOY_PORT` |
| Variable | `DEPLOY_PATH` | where `compose.yml` lives (default `/opt/telegram-live-location`) |
| Variable | `DEPLOY_PORT` | host port to publish on loopback (default `8080`) |
| Secret | `DEPLOY_SSH_KEY` | a private key whose public half is in the server's `authorized_keys` |
| Secret | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <host>`, or of `ssh-keyscan -p <port> <host>` when ssh is not on 22 |

`DEPLOY_KNOWN_HOSTS` is not optional padding: the deploy pins the server's host
key instead of accepting whatever answers on that address.

On a non-standard ssh port the host must be bracketed, or the pinned key will
never match what is being connected to:

```
[198.51.100.7]:3031 ssh-ed25519 AAAAC3Nza…
```

`ssh-keyscan -p` writes that form for you. Reading the keys off the server
itself (`/etc/ssh/ssh_host_*_key.pub`) is better still when you have a shell
there, since nothing can intercept a scan that never crosses the network.

Make a key that is only good for this:

```sh
ssh-keygen -t ed25519 -f deploy_key -N '' -C 'github-actions'
ssh-copy-id -i deploy_key.pub <user>@<host>       # or append it yourself
ssh-keyscan <host>                                 # → DEPLOY_KNOWN_HOSTS
ssh-keyscan -p <port> <host>                       # …if ssh is not on 22
cat deploy_key                                     # → DEPLOY_SSH_KEY, then delete it
```

After that, every push to `main` builds, proves the image runs, publishes it,
pulls it on the server, restarts, and waits for `/healthz` to come back. If it
does not come back, the run fails rather than reporting a deploy that isn't
serving.

Nothing secret is in the image: it carries only code, and the server reads
`/etc/telegram-live-location.env` at run time.

### Without CI

The image is ordinary, so this is all the rollout does:

```sh
cd /opt/telegram-live-location
IMAGE=ghcr.io/<you>/telegram-live-location:main docker compose pull
IMAGE=ghcr.io/<you>/telegram-live-location:main docker compose up -d
```

`npm run login` still has to be done once by hand, wherever you can run node —
it is interactive, and its output is the `TELEGRAM_SESSION` the container
needs. The systemd unit above remains a fine alternative if you would rather
not run Docker.

## Verifying

```sh
npm test
```

53 checks, no network and no account: geo objects are built with the real
`teleproto` constructors, so a renamed field fails here rather than in
production, and the dashboard is driven over a real HTTP server including the
SSE stream.

**What the tests do not cover, and you should check first on the VPS:**
`src/mtproto.js` — connecting, signing in, and receiving updates. It is
deliberately the thinnest file in the repo for that reason. It could not be
exercised where this was written, because that environment allows a TCP
connection to Telegram's data centres but blocks the MTProto handshake itself.
So treat the first run as the real test of that file:

1. `npm run login` completes and prints a session string
2. `npm start` logs `signed in as @…`
3. share a live location in a watched chat — the log shows `new: …`, then
   `edit: …` each time you move
4. the dashboard shows the marker moving

`GET /healthz` needs no token and reports how many people and watchers there
are, which is enough for a uptime check.

## Layout

| | |
|---|---|
| `src/mtproto.js` | the only file that talks to Telegram; connection and event wiring |
| `src/positions.js` | turning an update into a position, and holding them; pure, fully tested |
| `src/server.js` | the dashboard, its JSON, and the SSE stream |
| `src/config.js` | environment, checked once at startup |
| `public/index.html` | the map: Leaflet, OpenStreetMap tiles, one EventSource |
| `bin/login.mjs` | the one interactive step |
