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
