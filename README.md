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
are then written to PostGIS and kept for `HISTORY_DAYS` (90 by default). See
«Places and history» before turning it on.

## A bot, or your own account

Locations can arrive either way, and which one runs is decided by which secret
is set. Nothing downstream knows the difference: both produce the same
position, and the map, the history and the sharing are identical.

|  | **Bot** — `BOT_TOKEN` | **Account** — `TELEGRAM_SESSION` |
|---|---|---|
| Is told about | locations shared **with the bot** | locations shared in **any chat the account is in** |
| People must | find the bot and press start | already be in a chat with you |
| You must hold | one token from @BotFather | an api_id, an api_hash, and a session as good as your password |
| Runs on | HTTPS to api.telegram.org | MTProto, a raw socket to a datacentre |

**The bot is the one to start with.** It asks less of you — no login, no
session string, and a token you can revoke without touching your account — and
it asks less of the people sharing, who need no relationship with you beyond
opening a chat. It is also far easier to reach from a restricted network,
because it is ordinary HTTPS rather than a binary protocol to a hardcoded
address.

The account's one advantage is reach: it sees a live location shared into a
group without anyone doing anything differently. If that is what you have, it
still works exactly as before.

Either way this needs an always-on Node host — the smallest VPS will do. The
account cannot run on Workers because MTProto needs a raw socket; the bot
could, one day, and does not today only because the positions live in this
process's memory.

## Setting it up with a bot

**① Make the bot.** Message [@BotFather](https://t.me/BotFather), send
`/newbot`, pick a name. He replies with a token — that is `BOT_TOKEN`, and it
is the only credential this needs.

Then `/setprivacy` → **Enable**. Privacy mode means the bot is told only about
messages meant for it, which is both the correct setting and the one that
makes a bot in a group harmless.

**② Tell it who may look.** `DASHBOARD_USERS` is a comma-separated list of
Telegram ids allowed to open the map. [@userinfobot](https://t.me/userinfobot)
will tell you yours.

```sh
# /etc/telegram-live-location.env
BOT_TOKEN=123456:AA…
DASHBOARD_USERS=509090598,108205212
PUBLIC_URL=https://livegeo.<you>.workers.dev
```

`PUBLIC_URL` is where the dashboard answers, so the bot can send a link that
works. Behind a quick tunnel, leave it unset: the tunnel's current address is
used instead (see «First, the way in that opens no way in»). With neither,
`/login` has nothing to point at, and says so — at startup, and to whoever asks.

**③ Share.** Whoever should appear on the map opens the bot, presses start,
then **Attach (📎) → Location → Share Live Location**. Telegram stops when the
period they chose runs out. `/stop` removes them and deletes their path.

### Signing in, and who sees whom

**Everyone the bot has met can sign in**, and sees a circle rather than the
whole map: themselves, plus whoever has chosen to let them. Like Find My, and
one way only — Ada letting Grace see her does not let Ada see Grace.

- `/invite` — the bot replies with a link for one person. Whoever taps it
  opens the bot, and can see you from then on. It works once, for a day, and
  you are told who used it: an invite that leaked does not add anyone quietly.
- `/circle` — who can see you and whom you can see, with a button to end
  either. The **Circle** button on the map does the same.
- `/login` — a link that signs you in to the map. It works once and expires in
  five minutes. A chat app fetching it for a preview does not use it up: it
  opens a page that signs you in, and only that counts as the one use.
- `/live` — a link anyone can follow you on for an hour, without Telegram; see
  «Following somebody live, without Telegram».
- `/sos`, `/safe`, `/checkon`, `/checkoff`, `/ok` — see «When something is
  wrong».
- `/report`, `/reports off` — see «Road reports».

`DASHBOARD_USERS` are the **admins**: they see everyone, as before, and receive
alerts for fences made before fences had owners. `DASHBOARD_TOKEN` still works
and counts as an admin, so nothing set up earlier stops working.

Circles need `DATABASE_URL` — grants have to outlive a restart. Without one the
service is what it always was: admins and the token, nobody else, and it says
so at startup.

What a person can do is narrower than what they can see:

| | yourself | someone you can see | anyone else |
|---|---|---|---|
| see on the map, history, name, photo | yes | yes | *not found* |
| publish their path as a share link | yes | **no** | *not found* |
| hand out a live link to them, or raise an SOS | yes | **no** | *not found* |
| erase their history | yes | **no** | *not found* |

Seeing somebody is not their consent to have their movements published, or
erased. And somebody you may not see answers exactly like somebody who does
not exist — the same status, the same body — so the answer cannot be used to
find out who is here.

Fences belong to whoever made them. Only the owner is alerted, and only about
people the owner may see.

Sessions are checked on **every** request, so `/stop`, removing an admin from
`DASHBOARD_USERS`, or taking back a grant all take effect at once — including
on a map somebody already has open, which drops the person immediately rather
than at the next reload.

The test suite includes a **leak matrix**: every route `server.js` matches, as
an admin, as a person with a grant, and as one without, with the route list
read from the source itself — a route added later without a decision about who
may reach it fails the suite instead of shipping.

### Sign in with Telegram

The button, rather than a link from the bot. It uses Telegram's OpenID
Connect provider (`oauth.telegram.org`) with PKCE: the code is exchanged here,
the `id_token` is verified against Telegram's published keys — signature,
issuer, audience, expiry, nonce — and neither it nor the client secret ever
reaches a browser. The protocol code is ported from `arashatt/telegram`, where
it already runs.

It needs a domain. Register it on the bot with BotFather's `/setdomain` — the
Worker's `*.workers.dev` hostname qualifies; a quick-tunnel hostname does not,
because it changes whenever the tunnel restarts. Then:

```sh
TELEGRAM_CLIENT_SECRET=…     # from BotFather; this is what switches it on
PUBLIC_URL=https://…         # the redirect is PUBLIC_URL/auth/telegram/callback
```

The client id is the bot's own id — the digits before the colon in
`BOT_TOKEN` — unless `TELEGRAM_CLIENT_ID` says otherwise. It asks for
`openid profile` and nothing more; `TELEGRAM_OIDC_SCOPE` replaces that.

**The first time, there is one more step.** Telegram's sign-in gives this site
an id of its own, which does not match the id the bot sees — so it cannot
tell, on its own, which person on the map you are. The page asks you to send
`/login` to the bot and open the link in the same browser. That proves the
Telegram account the bot knows; both proofs in one browser are the same
person, and they are linked from then on. It adds nothing to steal: anyone
holding your `/login` link could already sign in as you.

The callback logs the *names* of the claims Telegram sends, never their
values. If Telegram ever includes the id the bot sees, that log line will show
it, and this step can go.

- **The Login Widget** — the older *Log in with Telegram* iframe, deprecated by
  Telegram in favour of the above. It stays hidden until `BOT_DOMAIN` is set.

Sessions are cookies signed with a key derived from the bot token, so rotating
`BOT_TOKEN` ends every session at once.

The service refuses to start with neither `DASHBOARD_TOKEN` nor
`DASHBOARD_USERS` set. A map of where people are, with nothing deciding who may
look at it, is not a state worth starting in.

## Setting it up with an account

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
HISTORY_DAYS=90               # days of history kept in PostGIS; 0 keeps it for ever
TILE_UPSTREAM=                # where basemap tiles come from; default is OSM
TILE_CACHE=                   # where they are kept; default /tmp/livegeo-tiles
TILE_MAX_AGE=2592000          # seconds before a cached tile is refetched
VECTOR_UPSTREAM=              # district names and styled layers without an import; default OpenFreeMap
VECTOR_MAX_AGE=604800         # seconds before a cached vector tile is refetched
SHARE_TTL=604800              # how long a shared path link stays readable
SOS_CALL=                     # who an SOS says to call; default Iran's 110 / 115
CHECK_STOP=900                # seconds standing still before a check asks
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

You are blue — your dot, your path and the way you are heading, paler once you
stop sharing — and your row in the list says **you**, so you can find yourself
among everyone else. Everybody else is green while they share and grey after;
anyone who asked for help is red, you included.

A dot travels to where somebody is now rather than jumping there — over about
a second, never slower than their fixes came, and not at all for a jump across
town or with reduced motion switched on. While they are moving, a soft fan
under the dot points the way they are going: the phone's own heading when
Telegram sends one, otherwise their last step (watches send none). It goes
away a few minutes after they stop, since standing still sends no update to
say so.

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

The other kind of bad fix is one that lands far away: a cell tower's guess,
or a bad satellite lock, hundreds of metres or kilometres off and then back.
A fix is left out of the path, the history and GPX files when reaching it from
the last good one would have taken more than about 250 km/h, well off the way
travelled, and a later fix carries on from before it (`src/track.js`). Up to
three bad fixes in a row go this way. A real jump (a flight, a phone off for a
day) stays, because nothing after it goes back. So do fixes Telegram delivers
in a bunch, which lie along the way, and the newest fix, which is where the
map says somebody is until the next one arrives. Nothing is deleted: the table
keeps what came in, and the filter runs whenever a path is read.

### What time it was, anywhere on a path

Hover over a path — or tap it, on a phone — and it says when that part was
travelled, how long ago, and how fast: `≈ 14:32 · 8m ago · 4.1 km/h`. Lighting
somebody also draws their last day from history, not just the recent trail.

The `≈` is the honest part. Between two fixes nothing was observed — the same
filter above drops readings that did not move far enough — so a time between
them is an estimate at a steady pace. At a fix itself the time is exact, and
the `≈` goes away.

Shared paths keep their times too. A share made before times were recorded
still opens, and says "time not recorded" rather than inventing one.

Where a stretch was hidden — somebody inside a [private place](#private-places)
— the path has a gap, and hovering over the gap gives no time: nothing was
travelled in view there to read one from.

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

With a quick tunnel, **leave `PUBLIC_URL` unset**. The service asks cloudflared
for the tunnel's current address — `http://tunnel:20241/quicktunnel`, on the
compose network only (`TUNNEL_METRICS_URL` to point it elsewhere) — and puts
that in whatever the bot sends: `/login` always answers with a link that works
today, so it is also the way to find the dashboard after the address changed.
Links already handed out go with the old address, though: a live link or an
SOS sent before cloudflared restarted stops working. A named tunnel or the
Worker is what gives links that outlast a restart. `/healthz` says which the
links are using — `"address": "PUBLIC_URL"`, `"quick tunnel"` or `"none"` —
and never the address itself.

A `PUBLIC_URL` on `trycloudflare.com` — copied from the tunnel's log — is not
believed over the tunnel, since it stops working the next time cloudflared
restarts: while the tunnel answers, its current address is used, and the copy
only when it cannot be asked. The startup log says which.

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

## The map comes from here

The dashboard is a self-hosted WebGL2 map using **MapLibre GL JS 6.11.1**.
It starts as a flat, north-up **Map** in daylight, following the original map
poster reference: pink road hierarchy, teal ground, green parks, cyan water,
a left-hand map key and a compass. **3D · auto** and **Chase** remain optional
cameras. Layers offers Day, Golden hour, Night, automatic solar light and Lite.
Buildings are subtle footprints in Map, with illustrative heights in 3D.

The camera initially fits everyone sharing. People, accuracy halos, private
areas, trail gaps/times, fences and safety actions keep the same server data
and permission logic as the Classic map. Person buttons remain above the 3D
city. Private people are areas, never radar points. The optional radar reuses
loaded road geometry and has no second WebGL renderer or tile stream.
At world scale, private people appear only in a non-geographic area count and
the People panel. Area/trail detail returns from zoom 8, keeping a tiny veil
from looking like an exact location pin.

**Classic map** in Layers is remembered in the browser. Leaflet also starts
automatically without WebGL2/ES modules or if the GPU cannot initialise.
The live-link and shared-path pages continue using their existing Leaflet
renderers. Their shared drawing files have not changed.

The WebGL map requests **no OSM raster tiles by default**. Natural Earth public
domain land supplies global coverage. Detailed geometry uses the optional
osm2pgsql/PostGIS import first, then adapts the existing cached OpenMapTiles
source wherever the local tile is empty. The source is OpenFreeMap by default;
`VECTOR_UPSTREAM=off` disables that fallback. Roads, land cover, buildings,
place names and selected landmarks retain the same style across regions.
Layers also offers the off-by-default OSM raster map.
Classic uses the existing cached `/tiles/{z}/{x}/{y}.png` proxy. Its upstream
is configured with `TILE_UPSTREAM`; cached tiles survive upstream outages.

All scripts, styles, glyphs, fonts, RTL shaping and land data are committed and
served from this origin, with licences under `public/vendor/`. MapLibre, fonts,
glyphs, RTL and land data use the `/lib/map-assets/` alias so an existing
Cloudflare Worker with an older `/vendor/` bundle still receives them from
the app deployment. The alias checks its vendor root and uses ETag revalidation. See
[asset sources and exact glyph regeneration command](public/vendor/README.md).
Barlow Condensed and Vazirmatn are OFL fonts. The self-hosted RTL plugin shapes
Persian, including presentation-form glyphs. There are no CDN, analytics or
external browser resource requests. OSM attribution remains visible.

### Styled OpenStreetMap layers

`/carto/{z}/{x}/{y}.mvt` uses `ST_AsMVT` locally, with the dashboard's authentication,
correct vector MIME type, negotiated gzip, private caching and 4096-unit
geometry with a 192-unit tile buffer. Seven layers: landuse, parks, water,
buildings, rail, roads and places. Roads include class/name/bridge/tunnel/layer.
Building heights use validated `height` or `building:levels` hstore tags,
otherwise stable defaults by building type; heights are labelled illustrative.
The worldwide adapter clips/reprojects tiles up to zoom 19 from upstream zoom
14, preserves polygon holes, caps features before encoding and coalesces/cache
requests. It uses the same seven layers and never fetches resources from the
browser.

**Fast zooms.** A quick wheel zoom asks for every level's tiles on the way and
gives most of them up a moment later. The server builds one tile at a time,
newest request first (the view being looked at now), and skips a build nobody
is waiting for any more. It keeps 24 decoded source tiles, so a zoom never
refetches them halfway. When the source cannot be read, the answer is a
`503` with `no-store`, never an empty tile: MapLibre keeps an empty tile for
as long as it stays in view, which left holes that never filled in. A failed
source is retried after 5 seconds. The 3D map asks again for failed tiles
still in view, after 3 s and then less often, up to every 30 s. The client
stops at z16: nothing in the data needs more, and MapLibre enlarges z16
tiles past that. The wheel, a trackpad pinch and a drag work over people,
pins and labels as well as over the bare map. A press that turned into a
drag does not also open what it started on.
**Mountain relief** adds stepped elevation colors and shaded ridges/valleys
from global Mapzen Terrarium tiles. `/relief/{z}/{x}/{y}.png` is authenticated,
proxied and cached by the app; no browser contacts the data provider. Source
zoom is capped at 12 and the style begins at zoom 5. Map projection stays flat,
so privacy areas and point/trail placement use their existing geometry.

`TERRAIN_UPSTREAM` accepts a Terrarium XYZ template or `off`;
`TERRAIN_MAX_AGE` defaults to 30 days. The default is the public, keyless AWS
Terrain Tiles dataset. Only valid 256px RGB/RGBA elevation PNGs of at most 1 MiB
are accepted, redirects are rejected, requests time out after 8 seconds,
repeated misses back off for a minute and stale tiles remain usable. Requests
coalesce; the in-memory cache holds 64 tiles and disk pruning runs on writes
at a 128 MiB / 768-tile target. Lite disables relief rendering. Failures leave
the map usable and show a status in Layers, rather than inventing elevation.
Provider credits are linked on-map at `/lib/terrain-credits.html`.

`?layers=roads,water` selects a subset. Omit `layers` for all, `layers=` for none;
unknown names return 400. Queries keep independent limits: 350 landuse, 500
parks, 400 water polygons + 500 water lines, 1800 buildings, 400 rail, 2400
roads and 150 place labels. Regional details start at z8; buildings at z15.
The cache holds 128 tiles for five minutes (empty tiles 30 seconds), coalesces
concurrent requests and retains at most two compressed variants per tile.
Missing imports retry after a minute, so an import needs no application restart.

Classic also retains the worldwide styled SVG fallback added on main:
`src/cartography-vector.js` reads cached OpenMapTiles from `VECTOR_UPSTREAM`
(default OpenFreeMap), via the server. `VECTOR_UPSTREAM=off` disables that
upstream. The same cache supplies `/api/district`; WebGL's district readout
uses it when the local `/api/place` has no name. The GPX dialog keeps its own
Leaflet preview and the original preview/download/copy/send flow.

The existing `/carto/{z}/{x}/{y}.svg` endpoint remains for Classic, with the
same six feature toggles, geometry limits, holes and corrected Y axis. Its
raster layer has separate features/labels. Purple remains reserved for places,
and red for SOS. No decorative vehicles, people or moving lights are drawn.

`npm test` includes rendering, caching, fallback and access-control regressions.
CI also runs `npm run test:cartography` against PostGIS to verify real geometry,
tile alignment, edge buffering and feature budgets. To run that check locally,
set `CARTOGRAPHY_TEST_DATABASE_URL` to a disposable PostGIS database. The test
uses temporary fixture tables and does not change an imported OSM dataset.

### The district name

Zoomed in to a town, the map names where its middle is, in the bottom-right
corner, the way a game names the district you drive into: the neighbourhood,
quarter or suburb, else the village, town or city. A name in another script
comes with a Latin line under it (OSM's `name:en`), in spaced capitals. It
fades out from zoom 11 outwards, where one name would cover a whole city.
From zoom 15 in, the street at the middle is named above it: the nearest
named road within 36 pixels, or 40 m, whichever is more.

Both work anywhere the tiles cover, which is the whole planet, and both stay
however far in you zoom: closer than zoom 15 the district is the one zoom 15
names, rather than whatever happens to fall within a few hundred pixels,
which by then is a few dozen metres. Most of the world has no neighbourhood
points, and a town's point can be further from where you are in it than the
view reaches, so when nothing is in reach the name is the suburb, village,
town or city whose point is within 2.5, 2.5, 5 or 10 km, the nearest for its
size.

The page asks `/api/district?lat=…&lon=…&z=…` once the map has settled, and
gets one or two lines of text back. The names are OpenStreetMap's place nodes,
from the imported extract where there is one (see **Places and history**).
Everywhere else they come from the `place` layer of vector tiles in the
OpenMapTiles layout, from `VECTOR_UPSTREAM`, the same tiles the styled map
layers draw from. That is
[OpenFreeMap](https://openfreemap.org) by default: free, keyless, and covering
the planet. Those tiles are proxied and cached on disk under
`TILE_CACHE/vector` like the raster ones, so the browser still talks to
nobody else, and a stale tile beats none. `VECTOR_UPSTREAM` is a TileJSON
address or a `{z}/{x}/{y}` template, and `off` leaves only the import; a
TileJSON may not point the server at a different host.

Where somebody is looking is never logged. The upstream does see which tiles
the server fetches, roughly which areas are looked at, just as OSM's tile
servers do for the street map.

The Latin line is set in Oswald (SIL OFL 1.1, `public/vendor/fonts`, from
`@fontsource/oswald` 5.3.0). The name itself is in the system font, because
it can be in any script.

## Handing a path to somebody

Clicking yourself opens your card; if you have gone anywhere, it offers a link.
Anyone with that link sees that one path on a map, without the dashboard token.
It is your own path or nobody's — an admin can share anybody's — because being
able to see somebody is not their consent to have where they went published.

It is a **frozen copy**, not a window. The link shows what had been travelled
at the moment of sharing and does not keep following the person afterwards,
which is the difference between sharing a walk and handing over a tracker. It
expires after `SHARE_TTL` — a week by default — and the card can revoke it
before that.

It never shows where the path really starts or ends. A path usually starts or
ends at somebody's door, so a random 200–500 m comes off each end of every
share, and anything inside one of your [private places](#private-places) is
taken out — when the link is made and again every time it is opened, so hiding
a place later covers links you have already sent. The page says the ends are
left out, draws each end fading away rather than stopping at a point that
would look like the truth, and offers the path as a GPX file.

The link admits exactly three things: the viewer page, the one path behind it,
and the map tiles that page draws on. It is not a way into the dashboard, the
positions, or anybody else's path, and there are tests that say so.

Requires PostGIS; without `DATABASE_URL` the button reports that rather than
appearing to work.

## Following somebody live, without Telegram

A shared path is a frozen copy. Sometimes what you want is the opposite — *watch
me get home* — for somebody who has no Telegram, or no bot, or is not in your
circle. Your own card has **Follow me for 15 min · 1 h · 4 h**, and the bot has
`/live` (an hour), `/live 15m` and `/live 4h`. Either makes a link; whoever
opens it watches you move on a page of its own, gliding and turning as on the
dashboard, until it runs out.

What it shows is what your circle is shown, and less:

- **It starts now.** The path on it begins when the link was made. Where you
  were before — usually the way from your door — is not in it.
- **Private places apply.** Inside one, the page shows the blur and *somewhere
  private*, like everybody else who cannot see you exactly.
- **It ends.** When the time is up, when you stop it (**Circle → Live links →
  Stop**, or `/live stop`), or when you `/stop`, the page is told at once, says
  so, and takes you off the map.

The link opens that page, one stream carrying you, and the map tiles the page
draws on — nothing else, and nobody else. You can have five running. Links are
kept in the database, so a restart does not end them early. Requires PostGIS,
and `PUBLIC_URL` for the bot to hand out a working link.

## Private places

The people who can see you do not need to know where you live. A private place
is a circle you draw — **Circle → Private places → Hide a place**, then click
the spot — and while you are inside it, your circle sees a soft, slowly
breathing blur with your name on it instead of you: the place, not the point.

That is literal. The server does not send your position and leave the page to
blur it; to anybody who may see you but is not you or an admin, it sends the
place's centre and radius instead. There is nothing exact to find in what their
page received. The same goes for the list, the stream, your history, a watch
paired to somebody in your circle, and share links. Your path breaks where it
goes into the place and starts again where it comes out, fading at each end,
and hovering never reads a time across the gap.

You see yourself exactly, and so do admins (`DASHBOARD_USERS` and the shared
token): they run the database, and hiding you from them on the map would be
theatre.

**The circle is not centred on your door.** The known way to beat privacy
zones is to fit a circle to where somebody's paths stop; a few trips give away
its centre, which is their front door. So the server keeps a centre moved at
random by up to half the radius from the spot you clicked, and throws the spot
away. Fitting the circle finds only the moved centre, and your door could be
anywhere within half the radius of it, all of it equally likely. Everything
within half the radius of the spot you clicked is hidden whichever way the
offset fell — which is why your own place is drawn a little off-centre.

**Arrival alerts respect it.** A fence crossing that happens inside your private
place is told only to you and admins. Otherwise somebody could drop a 25 m
fence on a guessed doorstep and learn exactly what the blur is hiding.

What it cannot do:

- It hides *where*, not *whether*: your circle sees you go into the blur and
  come out of it.
- The street you always walk home along still points into the blur. A bigger
  radius buys more doubt.
- What was already sent stays sent. Maps open when you make a place are told to
  forget you and draw you again, but yesterday's screenshot is not recalled.

A place's radius is anything from 200 m to 5 km, and you can have ten. Like
everything else, they go with you on `/stop`.

## Taking a path with you (GPX)

Your own card has **A day as GPX…**. It opens a dialog with today in it, and ‹ › or
the date field go to other days. The dialog shows what the file holds before
anything is saved:

- that day's path on a small map;
- how far, from when to when, and how many readings;
- how many breaks: the file starts a new segment at each one.

Then:

- **Download** saves it as a GPX 1.1 file, the format Strava, Garmin Connect,
  Komoot and OsmAnd import.
- **Send…** hands it to another app, where the phone allows sharing files.
- **Copy** puts it on the clipboard.
- **Show the file** shows the file itself.

The last two exist because a download can silently fail in a phone's in-app
browser. The dialog says plainly that the file is your exact path, private
places included, so whoever gets it sees all of it.

The day runs midnight to midnight where you are, and the file is named for it.
It is your own path, or an admin's export: your circle sees your path on the
map, but a file made to be kept is for the person who walked it.

A pause of more than ten minutes starts a new segment, so the morning's walk
and the evening's drive are not joined by a straight line that an importer
would count as distance. The file has the fixes the service recorded, so it is
exactly as detailed as the history — see «Why the path is not every reading».

Over HTTP: `GET /api/gpx/<your id>?from=<epoch>&to=<epoch>`, a week at most. A
share link offers its path the same way, at `/api/shared/<token>?format=gpx`.
Requires PostGIS.

## When something is wrong: SOS, and check on me

Ride apps put a safety button on the map and watch their rides for stops that
should not be happening. Here the people who can see you are the ones who
answer — and they are told through the bot, so both need `BOT_TOKEN`, PostGIS
and, for the links in the messages, `PUBLIC_URL`.

**SOS.** Send `/sos` to the bot, or press **SOS** on your own card (which says
what it will do before it does it). Everybody who can see you — your circle
and the admins — gets a message saying you asked for help and near where, a
Telegram pin that opens in any maps app, and a live link that follows you for
the next hour. Their maps turn your row red and take them to you once.

For that hour **your private places do not hide you** from them: you asked to
be found, and a blur would be in the way. Only where you are — the path you
came by, and your history, stay veiled. `/safe`, **I'm safe** on your card, or
stopping its link ends it, and everybody who was told is told you are safe.
If it simply runs out, the blur comes back and the bot asks whether you still
need help. It survives a restart.

**Check on me.** `/checkon` (two hours; `/checkon 1h` or `4h`), or **Check on
me for 2 h** on your card, while you are sharing a live location. If you then
stand still for a quarter of an hour (`CHECK_STOP`) somewhere that is not one
of your places — a private place or a fence of your own — or your live
location stops, the bot asks whether you are all right. `/ok` answers it.
Only if you do not answer within five minutes is everybody who can see you
told how long you have been stopped and where, with a pin; moving on, or a
late `/ok`, is passed on to them too. `/checkoff` ends it.

Asking first is the point: a long lunch is not an emergency, and a check that
told everybody every time you sat down would be switched off by the second
day. It never lifts a private place — it only fires outside them, and if your
live location ends somewhere of your own, the check just ends.

**Neither calls anybody.** Every message says so, with the number to call
instead: `SOS_CALL`, which is Iran's `110 (police) or 115 (ambulance)` unless
you set it. Both depend on Telegram reaching the people told, which on a
filtered network is only as reliable as their connection. If you are in
danger, call first.

## Road reports

A closed road, an accident, a hazard (something on the road, a pothole, a
stopped vehicle, weather, roadworks) or a traffic jam, reported by whoever
sees it and shown to **everyone who can sign in, never with who reported
it** (`src/incidents.js`). The rules are Waze's, as the traffic research
describes them:

- **Report.** **Report** on the map puts a cross in the middle; move the map
  so it is on the spot, pick what it is, and send. From the bot, `/report`
  asks what it is and places it where your live location is, moved back along
  your way by three seconds at your speed, for the time it takes to press the
  button. Both say who will see it before it is sent. Ten an hour each.
- **Believed, then faded.** A report starts at 60% (a new reporter's
  reliability) and fades, faster for a jam than a closure. Somebody else
  reporting the same thing — same kind, within 150 m (300 m for a closure or
  a jam), going the same way — adds to it. Each pin shows how sure, and is
  fainter the less sure; one report stays about 14 minutes for a jam, 40 for
  an accident, 80 for a hazard and 8 hours for a closure, and longer as others
  confirm it.
- **Confirmed or dismissed.** Tap a pin: **Still there** or **Not there**. Two
  "not there" with nobody but the reporter behind it take it down at once.
  People who share their live location and pass within 200 m heading towards
  one are asked through the bot, silently, whether it is still there — about
  each report once, at most every five minutes, never about their own. The
  first question says what it is; **Stop asking me** or `/reports off` ends
  them. Your own report can be taken back until somebody else backs it.
- **Reliability is learnt.** When a report is confirmed (80% with two people
  behind it) or taken down by answers within 15 minutes, everyone who answered
  becomes a little more or less reliable, and their next reports and answers
  count for that much more or less.
- **No police or speed cameras.** Warning of them is banned or restricted in
  several countries, so there is nothing to report them with.

Who reported or answered is kept only as a keyed hash of their id, so the
tables do not say who said what. `/stop` or **forget** removes someone's
answers, reliability and preferences; their reports stay, tied to nobody.
Reports nobody has added to for `HISTORY_DAYS` are deleted with the rest of
the history. **Road reports** in Layers hides the pins.

`test/incidents.test.mjs` runs the research's check of the whole idea: a
simulated day in which honest people are right 85% of the time and one person
in five lies — fake reports, and the opposite answer to every question. After
a two-hour warm-up, 76% of what the map shows is real and 82% of what is real
is shown. The research aims for 90% and 80% with Waze's number of drivers;
nearly all the difference is incidents that have cleared and not yet faded.

## The Android app

`android/`: the live map full-screen on a phone, a tablet or a car's head
unit, and a way for that device to share where it is. Android 7 or later. It
needs no Google Play services, so it also runs on head units and phones sold
without Google.

**What it is.** The map page, the same one a browser gets, in a web view, so
everything on the map works the same in both. Around it, the app's own
screens, made to feel like a game's:
- a radar loading screen with tips, which stays up until the 3D map has drawn
  rather than until the page has arrived;
- full screen with the system bars hidden, and the screen kept on;
- Back closes the map's dialogs and panels first;
- a buzz for a key pressed, and a pattern and a tone for going live and
  stopping.

In the app, the map starts in the tilted 3D camera. A choice made in the
*Camera* menu is kept.

A web view too old for the 3D map gets the classic map instead of an empty
screen. Head units in particular ship a web view that is never updated. The
3D map needs Chrome 94's JavaScript (ES2022), and `map-bootstrap.js` checks
for it before loading anything. Everything the classic map runs is kept to
ES2019, which is about what Chrome 74 on Android 10 reads.
`test/old-webview.test.mjs` parses it that way on every push.

**Connecting.** No address is built in: behind a quick tunnel, the map's
address changes every time cloudflared restarts. Send `/login` to the bot,
then do one of these:
- share the link it sends to LiveGeo (long-press it in Telegram, then
  *Share*);
- copy it and tap *Paste link*;
- tap it, and Android offers the app.

A link carries the map's address, so any https link is a candidate. Before
keeping one, the app asks that address for `/healthz`, which only a LiveGeo
server answers the way it does (`ok`, `watching` and `people`):
- **A map.** The app keeps the address and opens the link.
- **Anything else** (a download page, GitHub, a news site). The app says
  **not your map** and keeps nothing. Version 0.1.0 kept whatever it was
  given, so a device that kept such an address forgets it the next time it
  starts.
- **No answer.** The address is kept, because a map that is down or has
  moved cannot say what it is.

When a link offers several addresses, a sign-in link (`/auth/…`) wins. A
clipboard holding the release's download link and the bot's link opens the
map.

When the map cannot be reached, the app tells you which of three things
happened:
- the map **moved**: the name no longer resolves, or Cloudflare answers 530.
  Send `/login` again and share the new link.
- the map is **not answering**: the tunnel is there, the server behind it is
  not.
- the device is **offline**. This includes a network that is not really
  online yet, such as a hotel's sign-in page.

**Going live.** Inside the app, the map's toolbar has *Go live*.
- **Pairing.** The first time, the app pairs the device as one of your
  devices using the page's own session, so there is no code to type. It
  shows up in the Circle panel, for example as "Samsung SM-A515F", and
  removing it there cuts it off. If somebody else signs in on the device,
  *Go live* pairs it to them first.
- **Sharing.** It asks for location, then shares for an hour, four hours or
  until you stop. Sharing runs as a foreground service with a Stop button in
  its notification, so it carries on with the screen off. Signing out of the
  map in the app stops it.
- **What it sends.** It reads GPS every 5 seconds, using the network's guess
  only while GPS is silent. A fix is sent when it has moved further than its
  own accuracy (never less than 25 m), or after two minutes without one.
  Fixes queue on the device without signal and are sent when it returns.
- **In the toolbar.** The button says *Live · 58 min* while it lasts. A day's
  GPX from the card saves through Android's save dialog, and *Send…* opens
  the share sheet.

**Getting it.** Download the APK from the repository's Releases page
(*LiveGeo for Android x.y.z*) and open it on the device. Android asks once to
allow installing from whichever app opened it.

The *Android app* workflow builds it. Every push that touches `android/` or
the shared core runs the tests, builds the APK, and starts it on an Android 10
emulator with no Google services, whose web view is old enough to get the
classic map. On the emulator it walks through:
- the first run;
- a link to a website that is not a map, which must be refused and not kept;
- a dead link;
- a real LiveGeo map. `bin/selfcheck.mjs` runs behind a quick tunnel made for
  the run, and the map must load past the loading screen, with *Go live* on
  it and no error thrown by the page;
- rotation, and a trip to the home screen.

It fails on any crash. To publish a release, run the workflow by hand
(*Actions → Android app → Run workflow*) with a version such as `1.0.0`.

**Signing.** Android installs an update only over an app signed with the same
key. Make one once, keep it safe offline, and give it to the workflow:

```sh
keytool -genkeypair -keystore livegeo.jks -storetype PKCS12 -alias livegeo \
  -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=LiveGeo"
base64 -w0 livegeo.jks > livegeo.jks.b64
```

Then add these repository secrets:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the contents of `livegeo.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `livegeo` |
| `ANDROID_KEY_PASSWORD` | the same password, for a PKCS12 store |

Lose the key and no later release installs over the earlier ones. Without
these secrets, each build is signed with a key made for that run only. It
installs, but the next release needs the old one removed first, and with it
the device's pairing and the map's address. The release notes say which
kind of key signed each release.

**Building it yourself** needs the Android SDK and JDK 17:
`cd android && ./gradlew :app:assembleDebug`. The logic it shares with the
Galaxy Watch lives in `watch/wearos/core`:
- the API client, the outbox and the send cadence;
- reading a sign-in link, asking an address whether it is a map, telling
  why the map did not load, and pairing with a session.

It is plain Kotlin with its own tests (`./gradlew :core:test`).

**Not yet run on a real device.** It compiles and its logic is tested, and CI
starts it on an emulator and walks its screens. GPS in a moving car, battery
over a shift, and each head unit's quirks are the part only hardware can show.

## Watches

A watch with its own GPS and signal can report where it is directly — no
phone, no Telegram — and show the circle of whoever it belongs to. The apps
are in `watch/`; this is the part of the service they talk to.

**Pairing.** Send `/pair` to the bot, or press **Pair a watch** in the Circle
panel, and type the six-digit code into the watch. It works once, for five
minutes. The watch gets a long token and keeps it; only its SHA-256 is stored,
so reading the database tells you which watches exist, not how to be one.
Remove a watch from the Circle panel and its token stops working on its next
request. `/stop` removes every watch along with everything else.

Six digits can be guessed, so guessing is what is limited: a few wrong codes
per address, and if wrong codes arrive in a burst from everywhere, every live
code is burned and has to be asked for again.

**What a watch may do.** A watch is its owner for *reading* — the same people,
history and fences its owner may see — and for reporting where it is. It
cannot erase anybody, publish a path, change who sees whom, make fences or
pair other watches. A token on a wrist can be lost with the wrist.

**What it sends.** One fix, a list, or `{ "fixes": [...] }`, up to 500:

```http
POST /api/ingest
Authorization: Bearer <device token>

{ "fixes": [ { "lat": 36.2970, "lon": 59.6060, "accuracy": 6,
               "heading": 90, "at": 1790000000, "until": 1790003600 } ] }
```

`at` is seconds (milliseconds are recognised), defaulting to now; anything more
than a minute in the future or a day in the past is refused. `until` is when
the watch's sharing session ends — capped at a day — and without it a watch
counts as live for fifteen minutes after its last fix. A final fix with
`"stopped": true` ends it. The answer says what was taken and why anything was
not: `{ "accepted": 1, "rejected": [ { "index": 1, "error": "too old" } ] }`.

A watch's fixes are its owner's position, so a watch and that person's
Telegram sharing merge into one marker, and the noise filter, history and
fences all apply. Fixes older than what the map already shows — a buffer
uploaded after a stretch without signal — go into the history, so the path is
complete, but are not replayed onto the map or through the fences: a marker
jumping backwards, or an arrival announced hours late, would be worse than
neither.

Reading uses the same token: `GET /api/me`, `GET /api/positions`,
`POST /api/stream`, `GET /api/history/:id`, `GET /api/fences`, and tiles.

A watch sees what its owner sees, private places included: somebody inside one
is listed as *somewhere private*, with no distance, and their map shows the
area, not a pin.

### Galaxy Watch

`watch/wearos` — Kotlin and Compose for Wear OS, standalone: it needs no phone.
Galaxy Watch 4 and later; the older Tizen watches are out of scope.

It shares for an hour, four hours, or until you stop, from a foreground
service with a Stop button in its notification, and shows your circle with how
far away and how long ago each person was seen. Tap someone for a small map,
drawn from this server's own `/tiles` — no Google Maps key, and no looks sent
to Google.

Battery decides how it behaves: a fix a minute, sent only if it has moved
beyond its own accuracy or has been quiet for five minutes, which keeps
somebody standing still showing as live. Everything goes through an outbox on
disk first, so a lift or a tunnel loses nothing.

**Getting it onto a watch.** It is built by the *Watch apps* workflow, because
building it needs the Android SDK. Set a repository variable
`LIVEGEO_SERVER` to your deployment's public URL — one app per deployment,
since typing a URL on a watch is not something to ask of anyone — and run the
workflow. Download the `livegeo-wearos-debug` artifact, then with the watch's
*Developer options → ADB debugging* and *Debug over Wi-Fi* on:

```sh
adb connect <watch-ip>:<port>
adb install app-debug.apk
```

Open it, send `/pair` to the bot, type the code. A build made without
`LIVEGEO_SERVER` says so on its pairing screen instead of letting pairing fail.
The Play Store route needs a developer account and a stated reason for using
location, which is yours to give.

The logic — client, outbox, sessions, cadence, tile maths — is plain Kotlin in
`watch/wearos/core` with its own tests, which CI runs. One of them runs the
client against a real server:
`LIVEGEO_TEST_SERVER=http://… LIVEGEO_TEST_CODE=123456 ./gradlew :core:test`.

### Apple Watch

`watch/apple` — a standalone watchOS 10 app in SwiftUI: no iPhone app beside
it. The same things as the Galaxy Watch: share for an hour, four hours or
until you stop; your circle with distance and how long ago; tap someone for a
map (MapKit). Sharing keeps going with your wrist lowered, for as long as the
session you chose. The token is kept in the Keychain, since to the server it
*is* the watch.

**Getting it onto a watch** needs a Mac with Xcode and an Apple ID:

```sh
brew install xcodegen
cd watch/apple
xcodegen generate                 # makes Livegeo.xcodeproj from project.yml
open Livegeo.xcodeproj
```

In Xcode set your team under *Signing & Capabilities*, set `LIVEGEO_SERVER`
under *Build Settings* to your deployment's URL, pick your watch as the
destination and run. A free Apple ID installs for seven days at a time;
TestFlight or the App Store needs the paid developer programme.

The *Watch apps* workflow proves it builds on every change, on a Mac runner,
unsigned. The logic is a Swift package in `watch/apple/Core` whose tests run
there too, holding it to the same rules as the Galaxy Watch's Kotlin core —
and, with `LIVEGEO_TEST_SERVER` and `LIVEGEO_TEST_CODE` set, against a real
server.

**Neither watch app has been run on a real watch yet.** Both compile, and
their logic is tested; how they behave on a wrist — battery, background
delivery, the permission prompts — is the part only hardware can show.

## Telling you when somebody arrives

A fence is a named circle. When somebody crosses into one or out of it, the bot
sends a message to everyone on `DASHBOARD_USERS`, the crossing is written down,
and every open map redraws.

Make one by pressing **New fence** and clicking the map: it asks for a name and
a radius. Click a fence to remove it. Both need PostGIS — without
`DATABASE_URL` the button does not appear, the same way place names do not.

### Why it does not tell you constantly

A geofence is a machine for crying wolf. A phone resting near a boundary
reports itself inside, then outside, then inside, indefinitely, and each flip
would be a message on somebody's lock screen. An alert nobody trusts is worse
than no alert, so two rules decide what gets sent:

- **A fix closer to the edge than its own accuracy proves nothing.**
  `FENCE_FLOOR` (default 50 m) is the floor, and a fix reporting worse accuracy
  than that raises the bar itself — the same idea as `MIN_MOVE` for travel.
  Twelve fixes flapping across a line produce nothing at all.
- **A crossing has to hold.** `FENCE_DWELL` (default 60 s) is how long, so
  driving past the end of the road is not arriving home.

The first sighting of somebody is never an arrival — they were already there —
and where everyone was is read back from `fence_events` on startup, so a deploy
neither forgets nor re-announces. `/stop` erases somebody's crossings along
with everything else.

Two things worth knowing. **The bot can only message somebody who has started
it**, so a viewer who has never opened it is simply not told. And with no
`DASHBOARD_USERS` — a `DASHBOARD_TOKEN`-only setup, or the account ingest,
which has no way to send a message — crossings are still recorded and still
drawn, they just are not pushed anywhere.

To check the whole chain against your own database:

```sh
docker compose exec -T app node bin/fence-check.mjs
```

It walks a phone past a fence it creates and removes, and asserts what should
and should not be said. It exists because every piece of this was individually
correct the first time and the feature still did nothing: fences were being
checked only for positions that passed the movement filter, so somebody who
arrived and put their phone down never produced the fix that would have
confirmed it. Only an end-to-end run showed that.

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
`positions` table. This is the part to be deliberate about — it is a record of
where people went, and they agreed to share a live location in a chat, not to
be logged. So it is kept for `HISTORY_DAYS` (default 90) and no longer: every
six hours, and a minute after each start, older positions and fence crossings
are deleted, a few thousand rows at a time, and only the count is logged —
and road reports nobody has added to in that time, with their answers.
`HISTORY_DAYS=0` keeps everything, as before there was a limit. The
dashboard's *forget* button erases a person from the database as well as from
the map, and `POST /api/forget/<id>` does the same from a script.

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

The **Server** workflow (Actions → Server → Run workflow) does the one-off jobs
on the host over the same ssh path, as a fixed list of named actions rather
than a command box: `status`, `setup-postgis`, `restart`, `restart-docker`,
`network-check`, and `clean-history` (report) / `clean-history-apply`. Its
logs are public like every Actions log, so what each prints is counts, states
and names — never positions, ids, secrets or firewall rules.

### When a deploy says `No chain/target/match by that name`

The whole line reads `failed to set up container networking … iptables: No
chain/target/match by that name`. Docker publishes a container's port through
a `DOCKER` chain in the `nat` table, which it creates when it starts, and
something on the server has deleted it. Usually that is a firewall reload that
wipes everything — `nftables.service` (a stock `/etc/nftables.conf` begins
with `flush ruleset`), `firewalld --reload`, `netfilter-persistent reload`, an
`iptables-restore` script — or an upgrade that switched `iptables` between its
nf_tables and legacy backends. Containers that are already running carry on,
so nothing looks wrong until the next deploy has to create one.

A deploy **repairs this itself**: on exactly this error it restarts Docker
once, which recreates the chain (and restarts PostGIS with it, for a few
seconds), tries again, and leaves a warning on the run saying so. It then
starts the app in a new container. The one the deploy had made before the
restart comes back with no working DNS inside it, not even for `postgis`
(`getaddrinfo EAI_AGAIN postgis` in its log), and stays that way until it is
replaced. By hand, the Server workflow's `restart-docker` does the same, or on
the server:

```sh
systemctl restart docker && cd /opt/telegram-live-location && docker compose up -d \
  && docker compose up -d --force-recreate --no-deps app
```

Restarting Docker restarts the quick tunnel too, which gives the map a new
address; send the bot `/login` for a link to it.

To find out why it happened — or why a restart did not help — run
`network-check`. It reports the iptables backend, whether the chain exists
under each backend, whether the running kernel still has its modules or wants
a reboot, which firewall services are active and whether `nftables.conf`
flushes the ruleset, and which firewall, Docker and kernel packages were
upgraded in the last three days. If the kernel was upgraded under the running
system, reboot. If the `iptables` alternative was switched, switch it back
(`update-alternatives --config iptables`) and restart Docker. If it is
`nftables.service` and you do not use it on purpose,
`systemctl disable --now nftables` stops it happening again.

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

If the bot cannot reach Telegram when the service starts (no DNS in a
container Docker has just restarted, or a network outage), the map, the API
and paired watches carry on without it. The log says `bot: cannot reach
Telegram yet`, and the bot signs in as soon as it can. It used to exit
instead, and Docker restarting it turned a short outage into a crash loop.

## Layout

| | |
|---|---|
| `src/mtproto.js` | the only file that talks to Telegram; connection and event wiring |
| `src/positions.js` | turning an update into a position, and holding them; pure, fully tested |
| `src/server.js` | the dashboard, its JSON, and the SSE stream |
| `src/zones.js` | private places: what a circle is shown instead of where somebody is; pure, fully tested |
| `src/gpx.js` | a path as a GPX file; pure, fully tested |
| `src/live.js` | live links: one person, followed from now, for a while |
| `src/sos.js` | an SOS: who is told, and what they are told |
| `src/checks.js` | check on me: when to ask, and when to tell; the judgement is one pure function |
| `src/incidents.js` | road reports: merging, belief, fading, reliability and whom to ask; the rules are pure functions |
| `src/track.js` | a path without the fixes a phone got wrong; pure, fully tested |
| `src/district.js` | the name of where the middle of the map is: place nodes from the import, else vector tiles from the upstream |
| `src/cartography-vector.js` | the styled map layers from those vector tiles, where there is no import |
| `src/vector-tiles.js` | the vector tile upstream (OpenFreeMap by default), proxied and cached on disk |
| `src/mvt.js` | just enough of a vector tile reader for both |
| `src/config.js` | environment, checked once at startup |
| `public/index.html` | the dashboard: MapLibre/Classic adapter, local MVT, authenticated stream |
| `public/live.html` | the page a live link opens |
| `public/lib/people-map.js` | how a person is drawn — the glide, the beam, the blur — for both |
| `public/lib/app-bridge.js` | the page's side of the Android app: Go live, files and sharing through the app; inert in a browser |
| `android/` | the Android app: the map full-screen, its loading and connect screens, Go live |
| `bin/login.mjs` | the one interactive step |
| `docs/DESIGN-HANDOFF.md` | the state of every screen, the rules a redesign must keep, and what is known to be wrong — for a UI/UX designer taking it over |

### Dashboard verification and demo views

`npm test` runs the existing application checks, SVG/MVT HTTP and cache tests,
and a real Chromium smoke test. CI's existing Ubuntu image supplies Chrome;
locally set `CHROMIUM_PATH` if Chrome is not in a standard location. Smoke
checks WebGL, both Classic paths, Persian shaping, privacy, SOS, keyboard
cards, escaping, cameras, layers, idle repaint count and phone legend layout.
The existing CI/Deploy workflows are unchanged.

[Current reference implementation and verification](docs/reference-map/README.md) document
the flat-map correction. Run `node bin/demo-reference.mjs` to reproduce them.
The [earlier 3D demo and measurements](docs/game-map/README.md) use only
invented people and a generated city with local Telegram/tile stubs. Run
`CHROMIUM_PATH=/path/to/chrome npm run demo:game` to reproduce them.
