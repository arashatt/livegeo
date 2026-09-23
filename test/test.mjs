// test.mjs — `npm test`. Plain node, no framework.
//
// Everything here runs without a network or a Telegram account. The geo
// objects are built with the real library constructors, so a change in
// teleproto that renamed a field would fail here rather than in production.
//
// What is NOT covered: src/mtproto.js, which is connection and event wiring.
// It can only be exercised against Telegram itself — see README «Verifying».

import { Api } from 'teleproto';
import { fromMessage, senderOf, Positions, metresBetween, movementThreshold } from '../src/positions.js';
import { personOf, makeDirectory } from '../src/directory.js';
import { placeName, makeGeo } from '../src/geo.js';
import { parseTilePath, tileUrl, makeTiles } from '../src/tiles.js';
import { peersFor } from '../src/mtproto.js';
import worker from '../worker/src/index.js';
import { fromUpdate } from '../src/positions.js';
import { connect as connectBot, commandIn, liveMinutes, liveFor } from '../src/bot.js';
import { makeLive } from '../src/live.js';
import { mint, readSession, checkWidget, makeLinks, makeViewers } from '../src/login.js';
import { verdict, makeWatcher, announce } from '../src/fences.js';
import { canSee, canActFor, makeCircles } from '../src/circles.js';
import { makeDevices, makeCodes, makeLimiter, hashToken } from '../src/devices.js';
import { fromDevice, readFixes } from '../src/ingest.js';
import { verifyIdToken, resetCaches, bytesToB64u } from '../src/oidc.js';
import {
  offsetCentre, zoneAt, veilPoints, veilPerson, trimEnds, trimLengths, breaksOf, withBreaks, makeZones,
} from '../src/zones.js';
import { toGpx, splitAtPauses, dayOf, contentDisposition, xmlText } from '../src/gpx.js';
import { seal, unseal } from '../src/login.js';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import '../public/lib/path-time.js';
const { PathTime } = globalThis;
import { createHash, createHmac } from 'node:crypto';
import { serve, staticFile } from '../src/server.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok  ', name); }
  else { fail += 1; console.log('  FAIL', name, extra ?? ''); }
};
const head = (s) => console.log(`\n${s}`);

const point = (lat, long, accuracy) =>
  new Api.GeoPoint({ lat, long, accessHash: 0n, accuracyRadius: accuracy });

const liveMsg = (lat, long, { period = 900, heading, accuracy = 10, from = 42, name } = {}) => ({
  senderId: from,
  peerId: new Api.PeerUser({ userId: BigInt(from) }),
  sender: name ? { firstName: name } : undefined,
  media: new Api.MessageMediaGeoLive({ geo: point(lat, long, accuracy), period, heading }),
});

// ------------------------------------------------------------------ parsing

head('reading a live location');
{
  const p = fromMessage(liveMsg(35.7, 51.4, { heading: 90, name: 'آرش' }), { at: 1000 });
  t('a live location is recognised', p !== null);
  t('coordinates come through', p.latitude === 35.7 && p.longitude === 51.4, p);
  t('accuracy comes through', p.accuracy === 10);
  t('heading comes through', p.heading === 90);
  t('the name is picked up', p.name === 'آرش', p.name);
  t('period becomes a deadline', p.liveUntil === 1900, p.liveUntil);
  t('and it is not stopped', p.stopped === false);
}

head('reading everything else');
{
  const still = { senderId: 7, peerId: new Api.PeerUser({ userId: 7n }),
    media: new Api.MessageMediaGeo({ geo: point(1, 2, 5) }) };
  const s = fromMessage(still, { at: 10 });
  t('a one-off location is read', s.latitude === 1 && s.longitude === 2);
  t('but is never live', s.liveUntil === null);

  t('a text message is not a location',
    fromMessage({ senderId: 7, message: 'hello' }) === null);
  t('an empty message is not a location', fromMessage(null) === null);
  t('a message with no sender is ignored',
    fromMessage({ media: new Api.MessageMediaGeo({ geo: point(1, 2) }) }) === null);

  const bogus = { senderId: 7, peerId: new Api.PeerUser({ userId: 7n }),
    media: new Api.MessageMediaGeo({ geo: point(999, 2) }) };
  t('an impossible latitude is refused', fromMessage(bogus) === null);
}

head('ending a share');
{
  const stop = {
    senderId: 42, peerId: new Api.PeerUser({ userId: 42n }),
    media: new Api.MessageMediaGeoLive({ geo: new Api.GeoPointEmpty({}), period: 900 }),
  };
  const p = fromMessage(stop, { at: 50 });
  t('an empty point means stopped', p.stopped === true);
  t('and it is no longer live', p.liveUntil === null);

  // A received messageMediaGeoLive has no `stopped` field — it is only on the
  // sending side's inputMediaGeoLive — so the constructor drops it. Proven
  // here so nobody later "fixes" the parser to rely on a flag that can never
  // arrive.
  const viaApi = new Api.MessageMediaGeoLive({ geo: point(1, 2), period: 900, stopped: true });
  t('the wire format carries no stopped flag', viaApi.stopped === undefined, viaApi.stopped);

  // The fallback still catches one if some other layer supplies it.
  const flagged = fromMessage({
    senderId: 42, peerId: { userId: 42 },
    media: { className: 'MessageMediaGeoLive', geo: { className: 'GeoPoint', lat: 1, long: 2 }, period: 900, stopped: true },
  }, { at: 60 });
  t('but a flag is honoured if one ever appears', flagged.stopped === true && flagged.liveUntil === null);
}

head('identifying the sender');
{
  t('from senderId', senderOf({ senderId: 5 }) === '5');
  t('from a peer', senderOf({ peerId: new Api.PeerUser({ userId: 9n }) }) === '9');
  t('a BigInt id becomes a string', senderOf({ senderId: 123456789012345n }) === '123456789012345');
  t('nothing at all is null', senderOf({}) === null);
}

// -------------------------------------------------------------------- store

head('one sender, one entry');
{
  const store = new Positions({ now: () => 1000 });
  store.update(fromMessage(liveMsg(35.70, 51.40), { at: 1000 }));
  store.update(fromMessage(liveMsg(35.71, 51.41), { at: 1001 }));
  store.update(fromMessage(liveMsg(35.72, 51.42), { at: 1002 }));

  const rows = store.list();
  t('moving does not add people', rows.length === 1, rows.length);
  t('the newest position wins', rows[0].latitude === 35.72);
  t('the path is kept', rows[0].trail.length === 3, rows[0].trail);
  t('in the order it was walked', rows[0].trail[0].latitude === 35.70);
  t('it is reported live', rows[0].live === true);
  t('two senders are two entries',
    (store.update(fromMessage(liveMsg(1, 2, { from: 99 }), { at: 1003 })), store.list().length) === 2);
}

head('a sender standing still');
{
  const store = new Positions({ now: () => 1000 });
  t('the first fix is a change', store.update(fromMessage(liveMsg(35.7, 51.4), { at: 1000 })) !== null);
  t('repeating it is not', store.update(fromMessage(liveMsg(35.7, 51.4), { at: 1001 })) === null);
  t('so the path does not pad', store.list()[0].trail.length === 1);
  t('but a real move is', store.update(fromMessage(liveMsg(35.8, 51.4), { at: 1002 })) !== null);
}

head('the path is bounded');
{
  const store = new Positions({ trailMax: 10, now: () => 1000 });
  for (let i = 0; i < 40; i++) store.update(fromMessage(liveMsg(30 + i * 0.01, 50), { at: 1000 + i }));
  const trail = store.list()[0].trail;
  t('a long walk does not grow without bound', trail.length === 10, trail.length);
  t('and the recent end is what is kept',
    Math.abs(trail[trail.length - 1].latitude - (30 + 39 * 0.01)) < 1e-9);
}

head('stopping and going stale');
{
  const store = new Positions({ now: () => 2000 });
  store.update(fromMessage(liveMsg(35.7, 51.4), { at: 1990 }));
  store.update(fromMessage({
    senderId: 42, peerId: new Api.PeerUser({ userId: 42n }),
    media: new Api.MessageMediaGeoLive({ geo: new Api.GeoPointEmpty({}), period: 900 }),
  }, { at: 1995 }));
  const after = store.list()[0];
  t('a stop keeps the last place seen', after.latitude === 35.7, after);
  t('but stops calling it live', after.live === false);

  const stale = new Positions({ staleAfter: 60, now: () => 5000 });
  stale.update(fromMessage(liveMsg(1, 2), { at: 4000 }));
  t('an old position is dropped', stale.list().length === 0);

  const fresh = new Positions({ staleAfter: 60, now: () => 5000 });
  fresh.update(fromMessage(liveMsg(1, 2), { at: 4990 }));
  t('a recent one is not', fresh.list().length === 1);
  t('and can be forgotten', (fresh.forget('42'), fresh.list().length) === 0);
}

head('live is a deadline, not a flag');
{
  const store = new Positions({ now: () => 3000 });
  store.update(fromMessage(liveMsg(1, 2, { period: 600 }), { at: 2900 }));
  t('still inside the period: live', store.list()[0].live === true);

  const later = new Positions({ now: () => 9999 });
  later.update(fromMessage(liveMsg(1, 2, { period: 600 }), { at: 2900 }));
  later.staleAfter = 1e9;
  t('past the period: not live, even with no closing edit', later.list()[0].live === false);
}

// ------------------------------------------------------------------- server

head('the dashboard');
{
  const config = { dashboardToken: 'sekret', port: 0, host: '127.0.0.1' };
  const store = new Positions();
  store.update(fromMessage(liveMsg(35.7, 51.4, { name: 'آرش' }), { at: Math.floor(Date.now() / 1000) }));
  const { server, publish } = serve(store, config, { log: { info() {}, error() {} } });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  t('no token is refused', (await fetch(`${base}/`)).status === 401);
  t('a wrong token is refused', (await fetch(`${base}/?token=nope`)).status === 401);
  t('positions are refused too', (await fetch(`${base}/api/positions`)).status === 401);
  t('a token of the wrong length is refused', (await fetch(`${base}/?token=sekre`)).status === 401);

  const page = await fetch(`${base}/?token=sekret`);
  t('the right token serves the page', page.status === 200);
  t('which is the map', (await page.text()).includes('openstreetmap'));
  t('and sets a cookie so the token leaves the address bar',
    /tll_token=/.test(page.headers.get('set-cookie') || ''));

  const withCookie = await fetch(`${base}/api/positions`, { headers: { cookie: 'tll_token=sekret' } });
  t('the cookie works on later requests', withCookie.status === 200);
  const body = await withCookie.json();
  t('and carries the people', body.people.length === 1 && body.people[0].name === 'آرش', body);

  t('health needs no token', (await fetch(`${base}/healthz`)).status === 200);

  // The stream: connect, read the greeting, then a pushed update.
  const res = await fetch(`${base}/api/stream`, { headers: { cookie: 'tll_token=sekret' } });
  t('the stream opens', res.status === 200 && /event-stream/.test(res.headers.get('content-type')));
  // Compression implies buffering, and a buffered stream is not a stream.
  t('and asking not to be recompressed on the way',
    /no-transform/.test(res.headers.get('cache-control')), res.headers.get('cache-control'));

  // The page opens this with POST, because cloudflared delivers a stream over
  // POST and holds the identical one over GET. Both have to work: the origin
  // is reached directly as often as through anything.
  const posted = await fetch(`${base}/api/stream`, {
    method: 'POST', headers: { cookie: 'tll_token=sekret' },
  });
  t('the stream opens over POST as well',
    posted.status === 200 && /event-stream/.test(posted.headers.get('content-type')),
    posted.status);
  const firstEvent = await posted.body.getReader().read();
  t('and greets the caller straight away',
    /event: hello/.test(new TextDecoder().decode(firstEvent.value)));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const readChunk = async () => decoder.decode((await reader.read()).value || new Uint8Array());

  const hello = await readChunk();
  t('it greets with who is already there', hello.includes('event: hello') && hello.includes('آرش'), hello.slice(0, 80));

  const moved = store.update(fromMessage(liveMsg(36.0, 52.0, { name: 'آرش' }), { at: Math.floor(Date.now() / 1000) }));
  publish(moved);
  const pushed = await readChunk();
  t('a move is pushed to the open map', pushed.includes('event: position') && pushed.includes('36'), pushed.slice(0, 80));

  await reader.cancel().catch(() => {});
  server.close();
}

// ---------------------------------------------------------------- directory

head('turning an id into a person');
{
  const u = personOf({ firstName: 'Arash', lastName: 'A', username: 'arashatt', photo: {} }, 108205212);
  t('the name is joined', u.name === 'Arash A', u.name);
  t('the handle carries an @', u.username === '@arashatt', u.username);
  t('having a photo is reported', u.photo === true);
  t('the id comes back as a string', u.id === '108205212');

  const group = personOf({ title: 'The group' }, 7);
  t('a group falls back to its title', group.name === 'The group', group.name);

  const bare = personOf({ firstName: 'Solo' }, 9);
  t('no handle is empty, never undefined', bare.username === '');
  t('no photo is false', bare.photo === false);
}

head('the directory does not ask twice');
{
  let asked = 0;
  const dir = makeDirectory();
  dir.attach({
    getEntity: async (id) => { asked += 1; return { firstName: 'Once', username: 'once' }; },
    downloadProfilePhoto: async () => Buffer.from('jpegbytes'),
  });

  const a = await dir.lookup(108205212);
  const b = await dir.lookup('108205212');
  t('the answer comes back', a.username === '@once', a);
  t('a number and a string are the same id', b.username === '@once');
  t('Telegram was asked once, not twice', asked === 1, asked);

  const photo = await dir.photo(108205212);
  t('the photo comes back as bytes', Buffer.isBuffer(photo) && photo.length > 0);
}

head('an id it cannot resolve still answers');
{
  const dir = makeDirectory();
  dir.attach({
    getEntity: async () => { throw new Error('no access hash'); },
    downloadProfilePhoto: async () => { throw new Error('nope'); },
  });

  const who = await dir.lookup(42);
  t('the page gets a shape rather than an error', who.id === '42' && who.name === '', who);
  t('and no photo', (await dir.photo(42)) === null);
}

head('before Telegram is connected');
{
  const dir = makeDirectory();
  const who = await dir.lookup(1);
  t('the id answers as unknown rather than hanging', who.id === '1' && who.username === '');
  t('and asking for a photo is not an error', (await dir.photo(1)) === null);
}

// ---------------------------------------------------------------------- geo

head('naming a place');
{
  t('a road you are on is named',
    placeName({ road: { name: 'Vakilabad Blvd', metres: 12 }, area: { name: 'Mashhad', metres: 400 } })
      === 'Vakilabad Blvd, Mashhad');

  t('a road far away is not',
    placeName({ road: { name: 'Some Highway', metres: 4000 }, area: { name: 'Mashhad', metres: 900 } })
      === 'Mashhad');

  t('an area alone still places you',
    placeName({ area: { name: 'Kuh Park', metres: 250 } }) === 'Kuh Park');

  t('an area on another continent does not',
    placeName({ area: { name: 'Mashhad', metres: 4_000_000 } }) === '');

  t('an area with no distance is not trusted either',
    placeName({ area: { name: 'Mashhad', metres: null } }) === '');

  t('nothing found says nothing', placeName({}) === '');
  t('and undefined is not a crash', placeName() === '');

  t('the same name is not said twice',
    placeName({ road: { name: 'Mashhad', metres: 10 }, area: { name: 'Mashhad', metres: 10 } })
      === 'Mashhad');

  t('a road distance that is not a number is not trusted',
    placeName({ road: { name: 'Nowhere', metres: null }, area: { name: 'Somewhere', metres: 5 } })
      === 'Somewhere');
}

head('geo without a database');
{
  const geo = makeGeo({ url: '', log: { info() {}, error() {} } });
  t('connecting says no rather than throwing', (await geo.connect()) === false);
  t('it reports itself disabled', geo.enabled() === false);
  t('recording is a no-op', (await geo.record({ id: '1', latitude: 1, longitude: 2, at: 1 })) === false);
  t('describing a point is empty', (await geo.placeOf(35.7, 51.4)) === '');
  t('history is empty, not an error', (await geo.historyOf('1')).length === 0);
  t('erasing removes nothing and does not throw', (await geo.forget('1')) === 0);
  await geo.close();
}

// -------------------------------------------------------------------- tiles

head('a tile path is three integers or nothing');
{
  const ok = parseTilePath('/tiles/13/5242/3162.png');
  t('a real tile parses', ok && ok.z === 13 && ok.x === 5242 && ok.y === 3162, ok);
  t('zoom 0 has exactly one tile', parseTilePath('/tiles/0/0/0.png') !== null);

  t('past the edge of the world is not a tile', parseTilePath('/tiles/0/1/0.png') === null);
  t('past max zoom is not a tile', parseTilePath('/tiles/25/1/1.png') === null);
  t('negatives do not parse', parseTilePath('/tiles/-1/0/0.png') === null);
  t('decimals do not parse', parseTilePath('/tiles/1.5/0/0.png') === null);

  // The reason this function exists: it feeds a filesystem path.
  t('traversal does not parse', parseTilePath('/tiles/../../etc/passwd') === null);
  t('encoded traversal does not parse', parseTilePath('/tiles/%2e%2e/1/1.png') === null);
  t('a slash smuggled in does not parse', parseTilePath('/tiles/1/1/..%2f..%2fetc.png') === null);
  t('an empty path does not parse', parseTilePath('') === null);
  t('undefined does not throw', parseTilePath() === null);

  t('the upstream url is filled in',
    tileUrl('https://example.test/{z}/{x}/{y}.png', { z: 3, x: 4, y: 5 })
      === 'https://example.test/3/4/5.png');
}

head('static files stay inside public/');
{
  t('a vendored file resolves', staticFile('/vendor/leaflet/leaflet.js') !== null);
  t('its type is known', staticFile('/vendor/leaflet/leaflet.css').type.startsWith('text/css'));
  t('an image resolves', staticFile('/vendor/leaflet/images/layers.png').type === 'image/png');

  t('encoded traversal is refused', staticFile('/vendor/%2e%2e/%2e%2e/etc/passwd') === null);
  t('a deep encoded escape is refused', staticFile('/vendor/..%2f..%2f..%2fetc/shadow') === null);
  t('an unknown extension is refused', staticFile('/vendor/leaflet/leaflet.map') === null);
  t('a null byte is refused', staticFile('/vendor/leaflet\0.js') === null);
}

head('tiles are cached, and stale beats blank');
{
  const dir = await mkdtemp(join(tmpdir(), 'tiles-'));
  let calls = 0;
  const png = Buffer.from('\x89PNG-one');
  const fetchImpl = async () => { calls += 1; return { ok: true, arrayBuffer: async () => png }; };
  const quiet = { info() {}, error() {} };

  const tiles = makeTiles({ cacheDir: dir, upstream: 'https://x.test/{z}/{x}/{y}.png',
                            userAgent: 'test', log: quiet, fetchImpl });

  const first = await tiles.get({ z: 2, x: 1, y: 1 });
  t('the first ask goes upstream', first.from === 'upstream' && calls === 1, first.from);
  t('and returns the bytes', first.bytes.equals(png));

  const second = await tiles.get({ z: 2, x: 1, y: 1 });
  t('the second ask is served from disk', second.from === 'cache', second.from);
  t('and upstream was not asked again', calls === 1, calls);

  // Now the network goes away, as it does on the sort of connection this was
  // built for.
  const broken = makeTiles({ cacheDir: dir, upstream: 'https://x.test/{z}/{x}/{y}.png',
                             userAgent: 'test', log: quiet, maxAge: -1,
                             fetchImpl: async () => { throw new Error('unreachable'); } });
  const stale = await broken.get({ z: 2, x: 1, y: 1 });
  t('an unreachable upstream serves the stale tile', stale && stale.from === 'stale', stale);

  const missing = await broken.get({ z: 2, x: 0, y: 0 });
  t('but a tile never seen is simply absent', missing === null);

  // What broke the live map: a fresh Docker volume is root-owned and the app
  // is not root, so the very first cache write fails. The tile had already
  // been fetched; discarding it over that is the bug.
  let warned = '';
  const notADir = join(dir, 'a-file-not-a-directory');
  await writeFile(notADir, 'x');
  const unwritable = makeTiles({
    cacheDir: notADir,   // a regular file: mkdir under it fails, as EACCES would
    upstream: 'https://x.test/{z}/{x}/{y}.png',
    userAgent: 'test',
    log: { info() {}, error: (...a) => { warned = a.join(' '); } },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => png }),
  });
  const served = await unwritable.get({ z: 4, x: 2, y: 3 });
  t('a tile that cannot be cached is still served',
    served !== null && served.bytes.equals(png), served);
  t('and it is still reported as fresh', served.from === 'upstream', served && served.from);
  t('while the cache failure is logged, not swallowed', warned.includes('could not cache'), warned);

  await rm(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------- which chats

head('choosing what to backfill from');
{
  t('named chats win outright',
    JSON.stringify(peersFor(['111', '222'], [{ id: 999 }])) === JSON.stringify(['111', '222']));

  // The case that lost 509090598: no TELEGRAM_CHATS used to mean no backfill,
  // so a restart forgot everyone until their next move.
  const dialogs = [{ id: 1, inputEntity: 'peer-1' }, { id: 2 }, { id: 3, inputEntity: 'peer-3' }];
  t('with none named, the account\'s own chats are used',
    JSON.stringify(peersFor([], dialogs)) === JSON.stringify(['peer-1', 2, 'peer-3']));

  t('a dialog with nothing usable is skipped',
    JSON.stringify(peersFor([], [{ id: 1 }, {}, null])) === JSON.stringify([1]));

  t('no chats and no dialogs is empty, not a crash', peersFor([], []).length === 0);
  t('undefined dialogs do not throw', peersFor([], undefined).length === 0);
  t('undefined chats fall through to dialogs',
    JSON.stringify(peersFor(undefined, [{ id: 7 }])) === JSON.stringify([7]));
}

// --------------------------------------------------------------- the edge

head('the Worker in front of the dashboard');
{
  // A stand-in for the edge cache. Workers have `caches`; Node does not.
  const cached = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = cached.get(req.url);
        return hit ? new Response(hit, { headers: { 'x-tile-source': 'cache' } }) : undefined;
      },
      async put(req, res) { cached.set(req.url, await res.arrayBuffer()); },
    },
  };
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); return p; } };
  const realFetch = globalThis.fetch;

  let asked = [];
  const png = 'PNGBYTES';
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : (input.url ?? String(input));
    asked.push({ url: u, init });
    if (u.includes('tile.openstreetmap.org')) return new Response(png, { status: 200 });
    return new Response('from-origin', { status: 200, headers: { 'x-from': 'origin' } });
  };

  const env = {
    ORIGIN: 'http://origin.test:8080',
    EDGE_KEY: 'edge-secret',
    DASHBOARD_TOKEN: 'tok',
    ASSETS: { fetch: async (req) => new Response('leaflet:' + new URL(req.url).pathname) },
  };
  const get = (path, headers = {}) =>
    worker.fetch(new Request('https://edge.test' + path, { headers }), env, ctx);

  // --- tiles ---
  const noAuth = await get('/tiles/9/337/201.png');
  t('a tile without the token is refused', noAuth.status === 401, noAuth.status);

  const first = await get('/tiles/9/337/201.png?token=tok');
  t('with the token it is fetched', first.status === 200, first.status);
  t('and reported as coming from upstream', first.headers.get('x-tile-source') === 'upstream');
  t('from OpenStreetMap, identifying itself',
    asked.at(-1).url.includes('tile.openstreetmap.org/9/337/201.png')
    && asked.at(-1).init.headers['user-agent'].startsWith('livegeo/'), asked.at(-1));

  await Promise.all(pending);   // the cache write is deferred, as at the edge
  const before = asked.length;
  const second = await get('/tiles/9/337/201.png?token=tok');
  t('a second ask is served from the edge cache',
    second.headers.get('x-tile-source') === 'cache', second.headers.get('x-tile-source'));
  t('and does not go upstream again', asked.length === before, asked.length - before);

  t('a cookie works as well as a query token',
    (await get('/tiles/9/337/201.png', { cookie: 'tll_token=tok' })).status === 200);

  // URL parsing collapses traversal before any of this runs, and it decodes
  // %2e to do it — so neither `..` nor `%2e%2e` can reach the tile handler in
  // the first place. What is worth asserting is the consequence: such a path
  // never turns into a fetch for a tile.
  asked = [];
  const trav = await get('/tiles/%2e%2e/1/1.png?token=tok');
  t('an encoded traversal never becomes a tile fetch',
    !asked.some((a) => a.url.includes('tile.openstreetmap.org')), asked.map((a) => a.url));
  t('and is not served as one', trav.headers.get('x-tile-source') === null);

  const short = await get('/tiles/9/337.png?token=tok');
  t('a malformed tile path stays under /tiles and is 404', short.status === 404, short.status);

  // --- assets ---
  const assetBody = await (await get('/vendor/leaflet/leaflet.js')).text();
  t('a vendored file comes from the assets binding, prefix stripped',
    assetBody === 'leaflet:/leaflet/leaflet.js', assetBody);

  // --- proxying ---
  asked = [];
  const api = await get('/api/positions?token=tok');
  t('the api is proxied to the origin',
    asked[0].url === 'http://origin.test:8080/api/positions?token=tok', asked[0] && asked[0].url);
  t('carrying the edge key', asked[0].init.headers.get('x-edge-key') === 'edge-secret');
  t('and the response comes back', api.headers.get('x-from') === 'origin');

  asked = [];
  await worker.fetch(new Request('https://edge.test/api/forget/7', {
    method: 'POST', headers: { 'x-edge-key': 'forged-by-the-caller' },
  }), env, ctx);
  t('the method survives the proxy', asked[0].init.method === 'POST', asked[0].init.method);
  t('a caller cannot supply its own edge key',
    asked[0].init.headers.get('x-edge-key') === 'edge-secret',
    asked[0].init.headers.get('x-edge-key'));

  const noOrigin = await worker.fetch(new Request('https://edge.test/api/positions'),
    { ...env, ORIGIN: '' }, ctx);
  t('with no origin configured it says so rather than pretending',
    noOrigin.status === 503, noOrigin.status);

  // Cloudflare refuses a subrequest to a bare IP and returns its own 1003
  // page, which the proxy would pass on as if the service had said it. This
  // was how the first deploy failed, so it is asserted rather than documented.
  asked = [];
  const byIp = await worker.fetch(new Request('https://edge.test/api/positions'),
    { ...env, ORIGIN: 'http://10.0.0.1:8080' }, ctx);
  t('an origin given as an IP is refused here, not by Cloudflare',
    byIp.status === 503, byIp.status);
  t('and says what to do about it',
    (await byIp.text()).includes('hostname'));
  t('without reaching for the network', asked.length === 0, asked.length);

  const v6 = await worker.fetch(new Request('https://edge.test/api/positions'),
    { ...env, ORIGIN: 'http://[2a01:4f9::1]:8080' }, ctx);
  t('an IPv6 literal the same', v6.status === 503, v6.status);

  globalThis.fetch = realFetch;
  delete globalThis.caches;
}

// ------------------------------------------------------- noise vs travel

head('measuring a distance');
{
  // Mashhad to Tehran, about 740km by great circle.
  const d = metresBetween({ latitude: 36.2605, longitude: 59.6168 },
                          { latitude: 35.6892, longitude: 51.3890 });
  t('a long distance is right to within a percent', Math.abs(d - 740000) < 8000, Math.round(d));

  // One of the real jitter hops from the screenshot: a few metres.
  const near = metresBetween({ latitude: 36.36457, longitude: 59.49061 },
                             { latitude: 36.36461, longitude: 59.49065 });
  t('a few metres reads as a few metres', near > 3 && near < 8, near);

  t('the same point is zero', metresBetween({ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 1 }) === 0);
  t('a missing point is infinitely far', metresBetween(null, { latitude: 1, longitude: 1 }) === Infinity);
}

head('how far counts as moving');
{
  t('the floor applies when nothing is known',
    movementThreshold({}, {}, 25) === 25);
  t('a poor fix raises it',
    movementThreshold({ accuracy: 100 }, { accuracy: 10 }, 25) === 100);
  t('the worse of the two wins',
    movementThreshold({ accuracy: 10 }, { accuracy: 80 }, 25) === 80);
  t('a very good fix does not lower it below the floor',
    movementThreshold({ accuracy: 3 }, { accuracy: 3 }, 25) === 25);
}

head('a phone standing still');
{
  const store = new Positions({ minMove: 25, now: () => 2000 });
  const at = (lat, lon, accuracy, when) => ({
    id: '509090598', latitude: lat, longitude: lon, accuracy, at: when, liveUntil: 9999, stopped: false, name: '',
  });

  const first = store.update(at(36.36457, 59.49061, 100, 1000));
  t('the first fix is always recorded', first !== null && first.trail.length === 1);

  // Four hops of a few metres each, well inside a 100m accuracy radius —
  // exactly the scribble in the screenshot.
  const jitter = [
    at(36.36461, 59.49065, 100, 1010),
    at(36.36452, 59.49058, 100, 1020),
    at(36.36466, 59.49070, 100, 1030),
    at(36.36449, 59.49055, 100, 1040),
  ].map((p) => store.update(p));

  t('none of the jitter is published', jitter.every((r) => r === null), jitter.filter(Boolean).length);
  t('and the trail does not grow', store.get('509090598').trail.length === 1,
    store.get('509090598').trail.length);
  t('the marker stays on the point actually known',
    store.get('509090598').latitude === 36.36457);
  t('but the entry stays fresh, so standing still is not vanishing',
    store.get('509090598').at === 1040, store.get('509090598').at);

  // Now a real walk: ~300m north, far beyond the uncertainty.
  const walked = store.update(at(36.36730, 59.49061, 100, 1100));
  t('a move larger than the uncertainty is travel', walked !== null);
  t('and it joins the trail', walked.trail.length === 2, walked.trail.length);
}

head('a good fix moving a short way');
{
  // With accuracy of 5m, a 40m walk is unambiguous — the floor must not hide it.
  const store = new Positions({ minMove: 25, now: () => 2000 });
  const p = (lat, accuracy, when) => ({
    id: 'a', latitude: lat, longitude: 59.0, accuracy, at: when, liveUntil: 9999, stopped: false, name: '',
  });
  store.update(p(36.0000, 5, 10));
  const short = store.update(p(36.00036, 5, 20));    // ~40m
  t('40m with a 5m fix is movement', short !== null && short.trail.length === 2, short && short.trail.length);

  const tiny = store.update(p(36.00046, 5, 30));     // ~11m further
  t('11m further is below the floor and is not', tiny === null);
}

// ------------------------------------------------------------- sharing

head('sharing a path');
{
  // Without a database there is nowhere to keep a share, and the routes must
  // say so rather than half-working.
  const geo = makeGeo({ url: '', log: { info() {}, error() {} } });
  await geo.connect();
  t('creating a share needs a database',
    (await geo.createShare({ token: 'x', person: '1', points: [{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }], ttlSeconds: 60 })) === false);
  t('reading one comes back empty', (await geo.readShare('x')) === null);
  t('revoking one removes nothing', (await geo.revokeShare('x')) === 0);

  // One point is a place, not a path.
  t('a single point is refused before it reaches the database',
    (await geo.createShare({ token: 'x', person: '1', points: [{ latitude: 1, longitude: 1 }], ttlSeconds: 60 })) === false);

  const store = new Positions();
  const { server } = serve(store, {
    dashboardToken: 'tok', port: 0, host: '127.0.0.1', staleAfter: 3600, trailMax: 10, shareTtl: 600,
  }, { geo, log: { info() {}, error() {} } });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  t('Leaflet is public, because a share page needs it and it carries no data',
    (await fetch(`${base}/vendor/leaflet/leaflet.css`)).status === 200);
  t('a share link that does not exist is 404, not 401',
    (await fetch(`${base}/share/nosuchtokenhere`)).status === 404);
  t('and neither does its data',
    (await fetch(`${base}/api/shared/nosuchtokenhere`)).status === 404);

  // The important one: a share token is not a way into anything else.
  t('a share token does not open the dashboard',
    (await fetch(`${base}/?s=nosuchtokenhere`)).status === 401);
  t('nor the positions behind it',
    (await fetch(`${base}/api/positions?s=nosuchtokenhere`)).status === 401);
  t('creating a share still needs the dashboard token',
    (await fetch(`${base}/api/share/someone`, { method: 'POST' })).status === 401);

  server.close();
}


// ----------------------------------------------- locations shared with a bot

head('what a bot is told');
{
  const at = 1_700_000_000;
  const live = (extra = {}) => ({
    update_id: 1,
    message: {
      message_id: 9, date: at, chat: { id: 555, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Ada', last_name: 'Lovelace' },
      location: { latitude: 36.297, longitude: 59.606, live_period: 3600, horizontal_accuracy: 12, ...extra },
    },
  });

  const first = fromUpdate(live(), { at });
  t('a shared live location becomes a position', first !== null);
  t('keyed on the sender, not the chat', first.id === '42', first.id);
  t('carrying their name', first.name === 'Ada Lovelace', first.name);
  t('the accuracy Telegram reports', first.accuracy === 12, first.accuracy);
  t('and an expiry rather than a flag', first.liveUntil === at + 3600, first.liveUntil);
  t('not stopped', first.stopped === false);

  // The same message, edited — which is what movement actually is.
  const moved = fromUpdate({
    update_id: 2, edited_message: { ...live().message, location: { latitude: 36.31, longitude: 59.58, live_period: 3600 } },
  }, { at });
  t('an edit is a position too, and the same person', moved.id === '42' && moved.latitude === 36.31);

  // live_period is documented as present for active live locations only, so
  // an edit that has lost it is how sharing ends.
  const ended = fromUpdate({
    update_id: 3, edited_message: { ...live().message, location: { latitude: 36.31, longitude: 59.58 } },
  }, { at });
  t('an edit with no live period means sharing stopped', ended.stopped === true);
  t('and is no longer live', ended.liveUntil === null);

  // A plain pin is not a stop. Reading it as one would erase somebody from
  // the map for sending a location on purpose.
  const pin = fromUpdate({
    update_id: 4, message: { ...live().message, location: { latitude: 36.31, longitude: 59.58 } },
  }, { at });
  t('but a plain dropped pin is not a stop', pin.stopped === false, pin.stopped);

  t('a message with no location is not a position',
    fromUpdate({ update_id: 5, message: { ...live().message, location: undefined } }) === null);
  t('nor is one from another bot',
    fromUpdate({ update_id: 6, message: { ...live().message, from: { id: 7, is_bot: true, first_name: 'B' } } }) === null);
  t('an impossible latitude is refused',
    fromUpdate({ update_id: 7, message: { ...live().message, location: { latitude: 99, longitude: 0 } } }) === null);

  t('a command is recognised', commandIn({ message: { text: '/stop', chat: { id: 1 }, from: { id: 2 } } }).name === '/stop');
  t('even addressed to the bot by name',
    commandIn({ message: { text: '/stop@livegeobot extra', chat: { id: 1 }, from: { id: 2 } } }).name === '/stop');
  t('and plain text is not one', commandIn({ message: { text: 'hello', chat: { id: 1 } } }) === null);
}

head('the bot loop, without Telegram');
{
  const calls = [];
  const said = [];
  let served = [[{
    update_id: 100,
    message: {
      message_id: 1, date: 1, chat: { id: 555, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      location: { latitude: 1, longitude: 2, live_period: 600 },
    },
  }, {
    update_id: 101,
    message: { message_id: 2, date: 2, chat: { id: 555, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Ada' }, text: '/stop' },
  }]];

  const stub = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'livegeobot' } }));
    if (method === 'sendMessage') { said.push(body.text); return new Response(JSON.stringify({ ok: true, result: {} })); }
    if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: served.shift() || [] }));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };

  const got = [];
  const forgotten = [];
  const bot = await connectBot(
    { botToken: 'T', chats: [] },
    {
      fetch: stub, poll: 0,
      log: { info() {}, error() {} },
      onPosition: (p) => got.push(p),
      onForget: (id) => { forgotten.push(id); },
      onLogin: (id) => `https://example.test/auth/${id}-link`,
    },
  );
  // Waited on rather than slept through: a fixed pause is a test that fails
  // on a loaded machine and passes everywhere else.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(got.length && forgotten.length && said.length)) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await bot.stop();

  t('it identifies itself first', calls[0].method === 'getMe', calls[0] && calls[0].method);
  t('and clears any leftover webhook, which would break every poll',
    calls.some((c) => c.method === 'deleteWebhook'));
  t('it asks only for the update kinds it handles',
    calls.find((c) => c.method === 'getUpdates').body.allowed_updates.join() === 'message,edited_message,callback_query');
  t('a shared location reaches the store', got.length === 1 && got[0].id === '42', got.length);
  t('/stop forgets the sender', forgotten.join() === '42', forgotten);
  t('and says so', said.some((m) => /no longer shown/.test(m)), said);
  t('the offset advances past what was handled',
    calls.filter((c) => c.method === 'getUpdates').at(-1).body.offset === 102,
    calls.filter((c) => c.method === 'getUpdates').at(-1).body.offset);
}

head('who may look');
{
  const botToken = '123456:AAstub';
  const viewers = makeViewers(['42', '77']);
  t('the list admits who is on it', viewers.has(42) && viewers.has('77'));
  t('and nobody else', !viewers.has('43'));

  const cookie = mint('42', { botToken });
  t('a minted session reads back', readSession(cookie, { botToken }) === '42');
  // Flipped, not overwritten — see the widget forgery below for why.
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('x') ? 'y' : 'x');
  t('a tampered one does not', readSession(tampered, { botToken }) === null);
  t('nor one signed with a different bot token',
    readSession(cookie, { botToken: 'other' }) === null);
  t('nor an expired one',
    readSession(mint('42', { botToken, life: -1 }), { botToken }) === null);
  t('and nonsense is refused rather than thrown at', readSession('garbage', { botToken }) === null);

  // The widget's payload, signed exactly as Telegram signs it.
  const fields = {
    id: '42', first_name: 'Ada', username: 'ada',
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const secret = createHash('sha256').update(botToken).digest();
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  t('a correctly signed widget reply verifies',
    checkWidget({ ...fields, hash }, { botToken }) === '42');
  // Flip the last character rather than overwrite it: overwriting with a
  // fixed '0' forged nothing whenever the real hash already ended in 0, which
  // made this fail one run in sixteen.
  const forged = hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0');
  t('a forged one does not', checkWidget({ ...fields, hash: forged }, { botToken }) === null);
  t('an altered field invalidates the signature',
    checkWidget({ ...fields, id: '43', hash }, { botToken }) === null);
  // A signature stays valid forever; the timestamp is what stops a replay.
  t('and an old one is refused however well signed', (() => {
    const old = { ...fields, auth_date: String(Math.floor(Date.now() / 1000) - 86_401) };
    const h = createHmac('sha256', secret)
      .update(Object.keys(old).sort().map((k) => `${k}=${old[k]}`).join('\n')).digest('hex');
    return checkWidget({ ...old, hash: h }, { botToken }) === null;
  })());

  const links = makeLinks();
  const token = links.issue('42');
  t('a link opens once', links.redeem(token) === '42');
  t('and not twice', links.redeem(token) === null);
  t('an unknown link opens nothing', links.redeem('nope') === null);
  const stale = makeLinks({ life: -1 });
  t('and an expired one is gone', stale.redeem(stale.issue('42')) === null);
}


// -------------------------------------------------- arriving, and not saying
// so when nothing happened

head('which side of a fence a reading proves');
{
  const at = (margin, inside, accuracy = null) => verdict({ inside, margin, accuracy }, { floor: 50 });
  t('well inside is inside', at(200, true) === 'in');
  t('well outside is outside', at(200, false) === 'out');
  // The floor exists because every fix is uncertain even when it does not say
  // by how much.
  t('a metre from the edge proves nothing', at(1, true) === null, at(1, true));
  t('nor does forty-nine', at(49, false) === null);
  t('fifty-one does', at(51, false) === 'out');
  // A fix that admits to being worse than the floor raises the bar itself.
  t('a poor fix needs more room', at(80, true, 200) === null, at(80, true, 200));
  t('and gets there eventually', at(300, true, 200) === 'in');
  t('a missing margin decides nothing', at(undefined, true) === null);
}

head('a phone sitting on a boundary');
{
  const w = makeWatcher({ floor: 50, dwell: 60 });
  const fence = { fence: 1, name: 'home' };
  // Settled inside first, so there is a state for the jitter to flap against.
  w.observe({ person: 'p', at: 0, accuracy: 10, readings: [{ ...fence, inside: true, margin: 400 }] });
  t('being somewhere is not arriving there', w.where('p', 1) === 'in');

  // Now the phone sits by the gate: every fix lands within its own accuracy of
  // the edge, on alternating sides. This is the case that decides whether the
  // feature is usable or a notification firehose.
  let events = [];
  for (let i = 0; i < 40; i++) {
    events = events.concat(w.observe({
      person: 'p', at: 100 + i * 30, accuracy: 50,
      readings: [{ ...fence, inside: i % 2 === 0, margin: 10 + (i % 3) }],
    }));
  }
  t('forty flips across the line produce nothing at all', events.length === 0, events.length);
  t('and it is still recorded as being there', w.where('p', 1) === 'in');
}

head('actually arriving, and actually leaving');
{
  const w = makeWatcher({ floor: 50, dwell: 60 });
  const fence = { fence: 7, name: 'the office' };
  const see = (at, inside, margin) =>
    w.observe({ person: 'p', at, accuracy: 10, readings: [{ ...fence, inside, margin }] });

  see(0, false, 900);                       // first sighting: outside, silent
  t('turning up outside announces nothing', w.where('p', 7) === 'out');

  t('crossing does not announce immediately', see(100, true, 300).length === 0);
  t('nor before the dwell is up', see(140, true, 320).length === 0);
  const arrived = see(200, true, 340);
  t('but it does once it has held', arrived.length === 1, arrived.length);
  t('as an arrival, named', arrived[0].entered === true && arrived[0].name === 'the office');

  t('staying there says nothing more', see(400, true, 350).length === 0);

  see(1000, false, 300);
  const left = see(1100, false, 320);
  t('and leaving is announced once', left.length === 1 && left[0].entered === false);
  t('and only once', see(1200, false, 400).length === 0);
}

head('a car that turns round');
{
  const w = makeWatcher({ floor: 50, dwell: 60 });
  const fence = { fence: 3, name: 'school' };
  const see = (at, inside, margin) =>
    w.observe({ person: 'p', at, accuracy: 5, readings: [{ ...fence, inside, margin }] });

  see(0, false, 800);
  t('driving in says nothing yet', see(10, true, 200).length === 0);
  // Out again well before the dwell elapses — a transit, not an arrival.
  t('and driving straight out says nothing ever', see(30, false, 200).length === 0);
  t('leaving the state where it started', w.where('p', 3) === 'out');
  t('a later real arrival still works', (() => {
    see(100, true, 300);
    return see(170, true, 300).length === 1;
  })());
}

head('fences across a restart');
{
  const fence = { fence: 1, name: 'home' };
  const fresh = makeWatcher({ floor: 50, dwell: 0 });
  // Without seeding, the first fix after a restart is a first sighting and
  // says nothing — which is right, but it also means the state is unknown.
  t('a cold watcher announces nothing on first sight',
    fresh.observe({ person: 'p', at: 0, accuracy: 5, readings: [{ ...fence, inside: true, margin: 400 }] }).length === 0);

  const seeded = makeWatcher({ floor: 50, dwell: 0 });
  seeded.seed([{ person: 'p', fence: 1, where: 'in' }]);
  t('a seeded one knows where everybody was', seeded.where('p', 1) === 'in');
  t('and does not re-announce it',
    seeded.observe({ person: 'p', at: 0, accuracy: 5, readings: [{ ...fence, inside: true, margin: 400 }] }).length === 0);
  const out = seeded.observe({ person: 'p', at: 10, accuracy: 5, readings: [{ ...fence, inside: false, margin: 400 }] });
  t('but does announce a change against it', out.length === 1 && out[0].entered === false);
}

head('forgetting reaches the fences too');
{
  const w = makeWatcher({ floor: 50, dwell: 0 });
  w.observe({ person: 'p', at: 0, accuracy: 5, readings: [{ fence: 1, name: 'home', inside: true, margin: 400 }] });
  w.observe({ person: 'q', at: 0, accuracy: 5, readings: [{ fence: 1, name: 'home', inside: true, margin: 400 }] });
  t('two people are tracked', w.size === 2, w.size);
  w.forget('p');
  // /stop has to reach here, or somebody who asked to be forgotten could still
  // set off an alert about a place they had been.
  t('forgetting one leaves the other', w.size === 1 && w.where('p', 1) === null);
  w.dropFence(1);
  t('and deleting a fence clears what was held about it', w.size === 0, w.size);
}

head('what the message says');
{
  t('an arrival reads plainly',
    announce({ who: 'Ada', name: 'home', entered: true }) === 'Ada arrived at home');
  t('and a departure', announce({ who: 'Ada', name: 'home', entered: false }) === 'Ada left home');
  t('somebody with no name is still somebody',
    announce({ who: '', name: 'home', entered: true }) === 'Someone arrived at home');
}


// -------------------------------------------- what time it was, on a path

head('finding the part of a path under the pointer');
{
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const mid = PathTime.nearestSegment(pts, { x: 50, y: 4 });
  t('the first segment, halfway along', mid.index === 0 && Math.abs(mid.t - 0.5) < 1e-9, mid);
  t('four pixels off it', Math.abs(mid.distance - 4) < 1e-9, mid.distance);
  const down = PathTime.nearestSegment(pts, { x: 103, y: 75 });
  t('the second segment, three-quarters down', down.index === 1 && Math.abs(down.t - 0.75) < 1e-9, down);
  // Past the end of a segment is clamped to its end, not extrapolated beyond.
  const beyond = PathTime.nearestSegment(pts, { x: -40, y: 0 });
  t('before the start is the start', beyond.index === 0 && beyond.t === 0, beyond);
  t('two fixes on one pixel do not divide by zero',
    PathTime.nearestSegment([{ x: 5, y: 5 }, { x: 5, y: 5 }], { x: 8, y: 9 }).distance === 5);
  t('a single point is not a path', PathTime.nearestSegment([{ x: 0, y: 0 }], { x: 0, y: 0 }) === null);
}

head('the time at a point between two fixes');
{
  const times = [1000, 1600, 1900];
  t('a steady pace between fixes', PathTime.timeAt(times, 0, 0.5) === 1300);
  t('exact at the far end', PathTime.timeAt(times, 1, 1) === 1900);
  t('clamped rather than extrapolated', PathTime.timeAt(times, 0, 1.4) === 1600);
  // A share made before times were stored has none, and the page must say so
  // rather than print midnight on the first of January 1970.
  t('no times is no answer', PathTime.timeAt(null, 0, 0.5) === null);
  t('nor is half a pair', PathTime.timeAt([1000, null], 0, 0.5) === null);
  t('and a missing time is not the start of 1970',
    PathTime.speedBetween({ latitude: 0, longitude: 0, at: null }, { latitude: 0, longitude: 1, at: 100 }) === null);
}

head('speed between fixes');
{
  // One degree of latitude is about 111.2 km; over an hour that is a car.
  const a = { latitude: 36, longitude: 59, at: 0 };
  const b = { latitude: 37, longitude: 59, at: 3600 };
  const kmh = PathTime.speedBetween(a, b) * 3.6;
  t('a hundred and eleven km in an hour', Math.abs(kmh - 111.2) < 0.5, kmh);
  t('reads as a whole number at driving pace', PathTime.speedLabel(PathTime.speedBetween(a, b)) === '111 km/h');
  t('and to a decimal at walking pace', PathTime.speedLabel(4.1 / 3.6) === '4.1 km/h');
  t('standing still says so', PathTime.speedLabel(0.05) === 'still');
  t('a fix that goes back in time has no speed',
    PathTime.speedBetween({ ...b, at: 100 }, { ...a, at: 50 }) === null);
}

head('history and the live trail as one path');
{
  const history = [   // newest first, as the database returns it
    { latitude: 1, longitude: 1, at: 300 },
    { latitude: 1, longitude: 0.5, at: 200 },
    { latitude: 1, longitude: 0, at: 100 },
  ];
  const trail = [
    { latitude: 1, longitude: 1, at: 300 },        // also in history
    { latitude: 1, longitude: 1.5, at: 400 },
  ];
  const merged = PathTime.merge(history, trail);
  t('in time order', merged.map((q) => q.at).join() === '100,200,300,400', merged.map((q) => q.at));
  t('with the overlap kept once', merged.length === 4, merged.length);
  t('and a fix with no position dropped',
    PathTime.merge([{ latitude: null, longitude: null, at: 5 }], []).length === 0);
}


// ------------------------------------------------------ who may see whom

head('the one gate');
{
  const grants = new Map([['ada', new Set(['grace'])]]);   // Ada may see Grace
  const ada = { id: 'ada', admin: false };
  const grace = { id: 'grace', admin: false };
  t('you see yourself', canSee(grace, 'grace', grants));
  t('a grant lets you see its owner', canSee(ada, 'grace', grants));
  t('and runs one way only', !canSee(grace, 'ada', grants));
  t('an admin sees everyone', canSee({ id: null, admin: true }, 'ada', grants));
  t('nobody signed in sees nothing', !canSee(null, 'ada', grants));
  t('an id-less viewer who is not admin sees nothing', !canSee({ id: null, admin: false }, 'ada', grants));
  // Numbers and strings are the same person; Telegram sends one, URLs the other.
  t('an id is an id however it is typed', canSee({ id: 42, admin: false }, '42', grants));
  t('seeing somebody is not acting for them', !canActFor(ada, 'grace'));
  t('acting for yourself is', canActFor(grace, 'grace'));
  t('and an admin may', canActFor({ id: null, admin: true }, 'grace'));
}

head('the leak matrix: every route, as every kind of viewer');
{
  // A stand-in for PostGIS holding just what these routes read, so this runs
  // in CI where there is no database. The real queries are exercised against
  // PostGIS separately; what this checks is the routing around them.
  const db = {
    users: [{ id: '1', name: 'Admin', username: '' }, { id: '2', name: 'Ada', username: '' }, { id: '3', name: 'Grace', username: '' }],
    grants: [{ owner: '3', viewer: '2' }],   // Grace lets Ada see her
    fences: [], shares: [], nextFence: 1, forgotten: [],
  };
  const geo = {
    enabled: () => true,
    listUsers: async () => db.users,
    listGrants: async () => db.grants,
    upsertUser: async () => true,
    addGrant: async (o, v) => { db.grants.push({ owner: o, viewer: v }); },
    removeGrant: async (o, v) => { db.grants = db.grants.filter((g) => !(g.owner === o && g.viewer === v)); return 1; },
    historyOf: async (id) => [{ at: 1, latitude: 1, longitude: 1 }],
    forget: async (id) => { db.forgotten.push(id); return 1; },
    listFences: async ({ owner } = {}) => db.fences.filter((f) => owner === undefined || f.owner === owner),
    createFence: async ({ name, owner }) => { const id = db.nextFence++; db.fences.push({ id, name, owner, ring: [] }); return id; },
    fenceOwner: async (id) => { const f = db.fences.find((x) => x.id === id); return f ? f.owner : undefined; },
    countFences: async (owner) => db.fences.filter((f) => f.owner === owner).length,
    deleteFence: async (id) => { const n = db.fences.length; db.fences = db.fences.filter((f) => f.id !== id); return n - db.fences.length; },
    createShare: async ({ token, person }) => { db.shares.push({ token, person }); return true; },
    shareOwner: async (token) => db.shares.find((x) => x.token === token)?.person ?? null,
    revokeShare: async (token) => { db.shares = db.shares.filter((x) => x.token !== token); return 1; },
    readShare: async () => null,
    placeOf: async () => '',
    devices: [], nextDevice: 1,
    listDevices: async () => geo.devices,
    createDevice: async ({ owner, name, platform, tokenHash }) => { const id = geo.nextDevice++; geo.devices.push({ id, owner, name, platform, token_hash: tokenHash }); return id; },
    deleteDevice: async (id) => { geo.devices = geo.devices.filter((d) => d.id !== id); return 1; },
    touchDevice: async () => {},
    listLiveLinks: async () => [],
    createLiveLink: async () => true,
    revokeLiveLink: async () => 1,
  };
  const botToken = '123:leakmatrix';
  const circles = makeCircles({ geo, admins: ['1'] });
  await circles.load();
  const devices = makeDevices({ geo, log: { info() {}, error() {} } });
  await devices.load();
  const codes = makeCodes({ perAddress: 3, globalFailures: 6 });
  const ingested = [];

  const store = new Positions({ minMove: 1 });
  const now = Math.floor(Date.now() / 1000);
  // Two kilometres each, a fix every 55 m: long enough to share once a few
  // hundred metres come off each end.
  for (const [id, name, lat] of [['2', 'Ada', 36.30], ['3', 'Grace', 36.31]]) {
    for (let i = 0; i < 40; i++) {
      store.update({ id, name, latitude: lat + i * 0.0005, longitude: 59.6, accuracy: 5, at: now - 60 + i, liveUntil: now + 600 });
    }
  }
  const { server, publish } = serve(store, {
    dashboardToken: 'tok', botToken, viewers: ['1'], port: 0, host: '127.0.0.1', shareTtl: 60,
  }, {
    geo, circles, devices, codes, links: makeLinks(), log: { info() {}, error() {} }, live: makeLive({ geo }),
    onIngest: async (fixes, device) => { ingested.push(...fixes.map((f) => ({ ...f, device: device.id }))); },
  });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const as = {
    token: { cookie: 'tll_token=tok' },
    admin: { cookie: `tll_session=${encodeURIComponent(mint('1', { botToken }))}` },
    ada: { cookie: `tll_session=${encodeURIComponent(mint('2', { botToken }))}` },
    grace: { cookie: `tll_session=${encodeURIComponent(mint('3', { botToken }))}` },
    stranger: { cookie: `tll_session=${encodeURIComponent(mint('999', { botToken }))}` },
  };
  const hit = (who, path, method = 'GET') => fetch(base + path, { method, headers: as[who], redirect: 'manual' });
  const ids = async (who) => (await (await hit(who, '/api/positions')).json()).people.map((p) => p.id).sort().join();

  // --- the route list comes from server.js itself. Every path it matches has
  // to be classified here, so a route added later without a decision about
  // who may reach it fails this test instead of shipping.
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const routes = [...new Set([...source.matchAll(/pathname(?: ===|\.startsWith\()\s*'([^']+)'/g)].map((m) => m[1]))];
  const classified = {
    public: ['/healthz', '/vendor/', '/lib/', '/auth/logout', '/auth/', '/auth/widget',
      '/auth/telegram/start', '/auth/telegram/callback'],
    shareToken: ['/share/', '/api/shared/'],
    liveToken: ['/live/', '/api/live-stream/'],
    signedIn: ['/', '/index.html', '/api/me', '/api/place'],
    filtered: ['/api/positions', '/api/stream'],
    canSee: ['/api/history/', '/api/person/', '/api/photo/'],
    selfOnly: ['/api/share/', '/api/forget/', '/api/gpx/', '/api/live', '/api/live/'],
    owned: ['/api/fences', '/api/fences/'],
    ownCircle: ['/api/circle', '/api/circle/', '/api/circle/invite', '/api/circle/viewer/', '/api/circle/owner/'],
    pairing: ['/api/devices/pair'],
    ownDevices: ['/api/devices/code', '/api/devices', '/api/devices/'],
    deviceOnly: ['/api/ingest'],
    ownZones: ['/api/zones', '/api/zones/'],
  };
  const known = new Set(Object.values(classified).flat());
  const unclassified = routes.filter((r) => !known.has(r));
  t('every route server.js matches has a decided audience', unclassified.length === 0, unclassified);
  t('and the list really was read from the source', routes.length >= 20, routes.length);

  // --- our own scripts are checked every time, so a deploy cannot leave a
  // fresh page running last week's copy of the code it loads
  {
    const first = await fetch(base + '/lib/people-map.js');
    const tag = first.headers.get('etag');
    t('a script of ours is served to anybody', first.status === 200 && (await first.text()).includes('PeopleMap'));
    t('and must be revalidated', first.headers.get('cache-control') === 'no-cache' && Boolean(tag), first.headers.get('cache-control'));
    const again = await fetch(base + '/lib/people-map.js', { headers: { 'if-none-match': tag } });
    t('which costs a 304 when it has not changed', again.status === 304, again.status);
    const vendor = await fetch(base + '/vendor/leaflet/leaflet.js');
    t('Leaflet may still be kept for a week', /max-age=604800/.test(vendor.headers.get('cache-control')));
  }

  // --- who can get in at all
  t('a session for somebody the bot never met is refused', (await hit('stranger', '/api/positions')).status === 401);
  t('the shared token still works, as an admin', (await ids('token')) === '2,3');

  // --- the lists
  t('an admin sees everyone', (await ids('admin')) === '2,3');
  t('Ada sees herself and Grace, who granted it', (await ids('ada')) === '2,3');
  t('Grace sees only herself', (await ids('grace')) === '3', await ids('grace'));

  // --- one person at a time
  for (const route of ['/api/history/', '/api/person/', '/api/photo/']) {
    t(`${route} — Grace cannot reach Ada`, (await hit('grace', route + '2')).status === 404);
    const unknown = await hit('grace', route + '999');
    const hidden = await hit('grace', route + '2');
    // The same status and the same body: a hidden person and a missing one
    // must be indistinguishable, or the 404 confirms who exists.
    t(`${route} — and hidden reads exactly like missing`,
      unknown.status === hidden.status && (await unknown.text()) === (await hidden.text()));
  }
  t('Ada can read Grace’s history', (await hit('ada', '/api/history/3')).status === 200);

  // --- acting for somebody
  t('Ada, who can see Grace, cannot publish Grace’s path', (await hit('ada', '/api/share/3', 'POST')).status === 404);
  const mine = await hit('grace', '/api/share/3', 'POST');
  t('Grace can publish her own', mine.status === 200, mine.status);
  const token = (await mine.json()).token;
  t('Ada cannot take Grace’s share down', (await hit('ada', `/api/share/${token}`, 'DELETE')).status === 404);
  t('Grace can', (await hit('grace', `/api/share/${token}`, 'DELETE')).status === 200);
  t('Grace cannot erase Ada', (await hit('grace', '/api/forget/2', 'POST')).status === 404);
  t('Ada, who can see Grace, cannot take a GPX of her', (await hit('ada', '/api/gpx/3')).status === 404);
  const gpx = await hit('grace', '/api/gpx/3');
  t('Grace can take her own', gpx.status === 200 && /application\/gpx\+xml/.test(gpx.headers.get('content-type'))
    && /^attachment; filename="grace-/.test(gpx.headers.get('content-disposition')), gpx.headers.get('content-disposition'));
  t('and it is GPX', /<gpx version="1.1"[\s\S]*<trkpt lat="1.0000000" lon="1.0000000">/.test(await gpx.text()));
  t('an admin can take anybody’s', (await hit('token', '/api/gpx/3')).status === 200);
  t('a window longer than a week is refused', (await hit('grace', '/api/gpx/3?from=1&to=900000')).status === 400);
  t('and nothing was erased', db.forgotten.length === 0, db.forgotten);

  // --- fences are somebody's
  const made = await (await hit('ada', '/api/fences?name=home&lat=36.3&lon=59.6&radius=100', 'POST')).json();
  const graceFences = (await (await hit('grace', '/api/fences')).json()).fences;
  t('Grace does not see Ada’s fence', graceFences.length === 0, graceFences);
  t('Ada does', (await (await hit('ada', '/api/fences')).json()).fences.length === 1);
  t('an admin does', (await (await hit('admin', '/api/fences')).json()).fences.length === 1);
  t('Grace cannot delete it', (await hit('grace', `/api/fences/${made.id}`, 'DELETE')).status === 404);
  t('Ada can', (await hit('ada', `/api/fences/${made.id}`, 'DELETE')).status === 200);

  // --- circles
  const graceCircle = await (await hit('grace', '/api/circle')).json();
  t('Grace sees that Ada can see her', graceCircle.canSeeMe.map((u) => u.id).join() === '2');
  t('the shared token has no circle to show', (await hit('token', '/api/circle')).status === 404);
  const me = await (await hit('grace', '/api/me')).json();
  t('Grace is told who she is, and that she is not an admin', me.id === '3' && me.admin === false);

  // --- the admin key is not handed out
  const page = await hit('grace', '/');
  t('Grace gets the page', page.status === 200);
  t('without the shared token in a cookie', !/tll_token=/.test(page.headers.get('set-cookie') || ''),
    page.headers.get('set-cookie'));

  // --- a watch: paired by its owner, then its owner for reading only
  const code = (await (await hit('grace', '/api/devices/code', 'POST')).json()).code;
  t('Grace gets a six-digit pairing code', /^\d{6}$/.test(code), code);
  t('the shared token cannot ask for one — it is nobody', (await hit('token', '/api/devices/code', 'POST')).status === 404);
  const pair = (body) => fetch(`${base}/api/devices/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  t('a wrong code pairs nothing', (await pair({ code: '000000' === code ? '000001' : '000000' })).status === 404);
  const paired = await (await pair({ code, name: 'Grace’s watch', platform: 'wearos' })).json();
  t('the right code pairs a watch, and names its owner', Boolean(paired.token) && paired.owner.id === '3', paired);
  t('only a hash of the token is stored', geo.devices[0].token_hash === hashToken(paired.token)
    && !JSON.stringify(geo.devices).includes(paired.token));
  t('a code works once', (await pair({ code })).status === 404);

  const watch = (path, method = 'GET', body) => fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${paired.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const watchSees = (await (await watch('/api/positions')).json()).people.map((p) => p.id).join();
  t('the watch sees what Grace sees, no more', watchSees === '3', watchSees);
  t('a made-up bearer token is nobody',
    (await fetch(`${base}/api/positions`, { headers: { authorization: 'Bearer not-a-device' } })).status === 401);

  for (const [what, path, method] of [
    ['erase its owner', '/api/forget/3', 'POST'],
    ['publish its owner’s path', '/api/share/3', 'POST'],
    ['read the circle', '/api/circle', 'GET'],
    ['make an invite', '/api/circle/invite', 'POST'],
    ['create a fence', '/api/fences?name=x&lat=1&lon=1&radius=100', 'POST'],
    ['mint pairing codes', '/api/devices/code', 'POST'],
    ['list or remove devices', '/api/devices', 'GET'],
    ['hide a place', '/api/zones?lat=1&lon=1&radius=500', 'POST'],
    ['take a GPX of its owner', '/api/gpx/3', 'GET'],
    ['hand out a live link to its owner', '/api/live?minutes=60', 'POST'],
    ['list its owner’s live links', '/api/live', 'GET'],
  ]) {
    t(`a watch cannot ${what}`, (await watch(path, method)).status === 404, path);
  }

  const report = await (await watch('/api/ingest', 'POST', {
    fixes: [
      { lat: 36.31, lon: 59.58, accuracy: 8 },
      { lat: 99, lon: 0 },
      { lat: 36.311, lon: 59.581, at: Math.floor(Date.now() / 1000) + 3600 },
    ],
  })).json();
  t('a watch reports, and a good fix is taken', report.accepted === 1, report);
  t('with each refusal said, by index',
    report.rejected.map((r) => `${r.index}:${r.error}`).join() === '1:position out of range,2:from the future', report.rejected);
  t('as its owner, and nobody else', ingested.length === 1 && ingested[0].id === '3', ingested);
  t('a browser cannot post as a watch', (await hit('grace', '/api/ingest', 'POST')).status === 404);

  // Guessing: a few per address, then refused; a burst from everywhere burns
  // every live code, including one nobody was guessing at.
  const spare = (await (await hit('ada', '/api/devices/code', 'POST')).json()).code;
  const wrong = (n) => String((Number(spare) + n) % 1_000_000).padStart(6, '0');
  for (let i = 1; i <= 3; i++) await pair({ code: wrong(i) });
  t('a fourth wrong guess from one address is refused outright', (await pair({ code: wrong(4) })).status === 429);
  for (let i = 5; i <= 8; i++) await pair({ code: wrong(i) });
  t('and a sweep burns the live codes, so even the right one fails', (await pair({ code: spare })).status !== 200);

  const removed = await hit('grace', `/api/devices/${paired.id}`, 'DELETE');
  t('Grace can remove her watch', removed.status === 200);
  t('and its token stops working at once', (await watch('/api/positions')).status === 401);

  // --- the stream, which is where a leak would be quietest
  const open = async (who) => {
    const res = await fetch(`${base}/api/stream`, { method: 'POST', headers: as[who] });
    const seen = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      for (;;) {
        const step = await reader.read().catch(() => ({ done: true }));
        if (step.done) return;
        buf += dec.decode(step.value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const c of parts) {
          const ev = /event: (\w+)/.exec(c)?.[1];
          const data = JSON.parse(/data: (.*)/.exec(c)?.[1] || '{}');
          seen.push({ ev, data });
        }
      }
    })();
    return { seen, close: () => reader.cancel().catch(() => {}) };
  };
  const streams = { admin: await open('admin'), ada: await open('ada'), grace: await open('grace') };
  await new Promise((r) => setTimeout(r, 150));
  const hello = (who) => streams[who].seen.find((e) => e.ev === 'hello')?.data.people.map((p) => p.id).sort().join();
  t('Grace’s stream opens with only herself', hello('grace') === '3', hello('grace'));
  t('Ada’s with both', hello('ada') === '2,3');

  publish(store.update({ id: '2', name: 'Ada', latitude: 36.5, longitude: 59.6, accuracy: 5, at: now + 5, liveUntil: now + 600 }));
  publish(store.update({ id: '3', name: 'Grace', latitude: 36.6, longitude: 59.6, accuracy: 5, at: now + 5, liveUntil: now + 600 }));
  await new Promise((r) => setTimeout(r, 150));
  const moved = (who) => streams[who].seen.filter((e) => e.ev === 'position').map((e) => e.data.id).sort().join();
  t('Ada moving reaches the admin and Ada', moved('admin') === '2,3' && moved('ada') === '2,3', [moved('admin'), moved('ada')]);
  t('and never reaches Grace, who only hears herself', moved('grace') === '3', moved('grace'));

  // Grace takes the grant back while Ada is watching; the next move must stop.
  await hit('grace', '/api/circle/viewer/2', 'DELETE');
  publish(store.update({ id: '3', name: 'Grace', latitude: 36.7, longitude: 59.6, accuracy: 5, at: now + 9, liveUntil: now + 600 }));
  await new Promise((r) => setTimeout(r, 150));
  t('revoking is immediate, on an already-open stream', moved('ada') === '2,3', moved('ada'));
  t('and on the next list', (await ids('ada')) === '2');
  // Not only does nothing new arrive: the marker already on Ada's map is
  // taken off it, rather than sitting there until she reloads.
  t('and Grace is taken off the map Ada already has open',
    streams.ada.seen.some((e) => e.ev === 'forget' && e.data.id === '3'));
  t('Grace’s own map is not told to forget her',
    !streams.grace.seen.some((e) => e.ev === 'forget'));

  Object.values(streams).forEach((st) => st.close());
  server.close();
}


head('paths with holes in them');
{
  const history = [{ at: 30, latitude: 3, longitude: 3, gap: true }, { at: 10, latitude: 1, longitude: 1 }];
  const trail = [{ at: 30, latitude: 3, longitude: 3 }, { at: 40, latitude: 4, longitude: 4 }];
  const merged = PathTime.merge(history, trail);
  t('a gap known to either list survives the merge', merged.map((q) => `${q.at}${q.gap ? '*' : ''}`).join() === '10,30*,40');
  t('a gap before the first fix is none', !PathTime.merge([{ at: 5, latitude: 1, longitude: 1, gap: true }])[0].gap);
  t('the path splits into the stretches drawn', JSON.stringify(PathTime.runs(merged).map((r) => r.map((q) => q.at))) === '[[10],[30,40]]');
  t('no stretches in nothing', PathTime.runs([]).length === 0);
  const px = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0, gap: true }, { x: 30, y: 0 }];
  const over = PathTime.nearestSegment(px, { x: 15, y: 0 });
  t('hovering over a hidden stretch finds no segment across it', over.index === 0 && over.t === 1, over);
  t('either side of it is still a path', PathTime.nearestSegment(px, { x: 25, y: 1 }).index === 2);
}

head('a dot that travels, and a beam for the way it is going');
{
  const here = { latitude: 36.3, longitude: 59.6 };
  const near = { latitude: 36.3009, longitude: 59.6 };    // 100 m north
  t('a short step glides, at most a second and a bit', PathTime.glideFor(here, near, 30) === 1200);
  t('and never slower than the fixes came', PathTime.glideFor(here, near, 1) === 800);
  t('a jump across town does not glide', PathTime.glideFor(here, { latitude: 36.33, longitude: 59.6 }, 60) === 0);
  t('nor one after a long silence', PathTime.glideFor(here, near, 601) === 0);
  t('nor a fix that went back in time', PathTime.glideFor(here, near, -5) === 0);
  t('nor with no time at all', PathTime.glideFor(here, near, null) === 0);
  t('nor across the antimeridian', PathTime.glideFor({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 }, 10) === 0);

  const north = PathTime.bearing(here, near);
  const east = PathTime.bearing(here, { latitude: 36.3, longitude: 59.61 });
  t('north is 0°', Math.abs(north) < 0.01 || Math.abs(north - 360) < 0.01, north);
  t('east is about 90°', Math.abs(east - 90) < 0.1, east);

  const now = 10_000;
  const walked = [{ ...here, at: now - 60 }, { ...near, at: now - 20 }];   // 100 m in 40 s: 2.5 m/s
  t('moving, the phone\'s own heading wins', PathTime.headingOf(270, walked, now) === 270);
  t('Telegram\'s 360 is north', PathTime.headingOf(360, walked, now) === 0);
  t('without one, the last step stands in', Math.abs(PathTime.headingOf(null, walked, now)) < 0.01);
  t('standing still has no heading',
    PathTime.headingOf(90, [{ ...here, at: now - 600 }, { ...near, at: now - 20 }], now) === null);
  t('nor does somebody who last moved minutes ago', PathTime.headingOf(90, walked, now + 400) === null);
  t('nor a step out of a hidden stretch', PathTime.headingOf(90, [walked[0], { ...walked[1], gap: true }], now) === null);
  t('nor a single fix', PathTime.headingOf(90, walked.slice(1), now) === null);
}

head('private places: where the circle is centred, and what is left of a path');
{
  const spot = { latitude: 36.3, longitude: 59.6, radius: 500 };
  let far = 0;
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const d = metresBetween(spot, offsetCentre(spot));
    far = Math.max(far, d);
    sum += d;
  }
  t('the centre is never more than half the radius from the spot', far <= 250.01, far);
  // Uniform over a disc of radius a, the mean distance is 2a/3 — a third of
  // the place's radius. Bunched at the middle it would be less, and the
  // offset would give the spot away.
  t('and is spread evenly over that disc', Math.abs(sum / 1000 - 500 / 3) < 15, sum / 1000);
  t('with no chance in it, it is the spot', metresBetween(spot, offsetCentre(spot, () => 0)) < 1e-6);
  t('at its furthest, half the radius', Math.abs(metresBetween(spot, offsetCentre(spot, () => 0.999999)) - 250) < 1);

  const zone = { id: 1, latitude: 36.3, longitude: 59.6, radius: 300 };
  t('a point 220 m from the centre is inside', zoneAt([zone], 36.302, 59.6) === zone);
  t('one 330 m away is not', zoneAt([zone], 36.303, 59.6) === null);
  t('nor is no point at all', zoneAt([zone], null, null) === null);

  const track = [
    { at: 100, latitude: 36.310, longitude: 59.6 },
    { at: 200, latitude: 36.301, longitude: 59.6 },
    { at: 300, latitude: 36.300, longitude: 59.6 },
    { at: 400, latitude: 36.305, longitude: 59.6 },
    { at: 500, latitude: 36.306, longitude: 59.6 },
  ];
  const v = veilPoints(track, [zone]);
  t('fixes inside a private place are gone', v.map((q) => q.at).join() === '100,400,500', v);
  t('and the fix after them says a stretch is missing', v[1].gap === true && !v[0].gap && !v[2].gap, v);
  t('history arriving newest first comes out the same',
    JSON.stringify(veilPoints([...track].reverse(), [zone])) === JSON.stringify(v));
  t('veiling twice changes nothing', JSON.stringify(veilPoints(v, [zone])) === JSON.stringify(v));
  const late = veilPoints([track[1], track[3]], [zone]);
  t('a gap before the first fix shown is no gap', late.length === 1 && !('gap' in late[0]), late);

  t('fixes without times keep the order they came in',
    veilPoints([track[4], track[1], track[0]].map((q) => ({ ...q, at: null })), [zone]).map((q) => q.latitude).join() === '36.306,36.31');

  const grace = { id: '3', name: 'Grace', latitude: 36.3005, longitude: 59.6, accuracy: 8, heading: 90, at: 600, trail: track };
  const hidden = veilPerson(grace, [zone]);
  t('inside a place, the position is its centre', hidden.latitude === zone.latitude && hidden.longitude === zone.longitude);
  t('the accuracy is its radius', hidden.accuracy === 300);
  t('the heading is gone', hidden.heading === null);
  t('and it says it is hidden', hidden.hidden === true);
  t('the trail is veiled with it', hidden.trail.map((q) => q.at).join() === '100,400,500');
  t('the exact point is nowhere in it', !JSON.stringify(hidden).includes('36.3005') && !JSON.stringify(hidden).includes('36.301,'));
  const out = veilPerson({ ...grace, latitude: 36.31 }, [zone]);
  t('outside every place the position is exact', out.latitude === 36.31 && out.heading === 90 && !out.hidden);
  t('though the trail is still veiled', out.trail.length === 3);
  t('somebody with no position is left as they are', veilPerson({ id: '9', latitude: null, longitude: null, trail: [] }, [zone]).latitude === null);

  // A straight line north, a fix every 50 m, two kilometres long.
  const line = Array.from({ length: 41 }, (_, i) => ({ at: i, latitude: 36.3 + i * 0.00045, longitude: 59.6 }));
  const cut = trimEnds(line, { start: 300, end: 450 });
  const lost = metresBetween(line[0], cut[0]);
  const lostEnd = metresBetween(line[40], cut[cut.length - 1]);
  t('the first few hundred metres of a share are gone', lost >= 300 && lost < 351, lost);
  t('and the last', lostEnd >= 450 && lostEnd < 501, lostEnd);
  t('whole fixes only, and the middle kept', cut.length === 26 && cut[0].at === 6 && cut[25].at === 31, cut.length);
  t('too short to lose both ends, nothing is shared', trimEnds(line.slice(0, 10), { start: 300, end: 300 }).length === 0);
  const lengths = Array.from({ length: 200 }, () => trimLengths());
  t('each end loses between 200 and 500 m, differently each time',
    lengths.every((l) => l.start >= 200 && l.start <= 500 && l.end >= 200 && l.end <= 500)
    && new Set(lengths.map((l) => Math.round(l.start))).size > 50);
  const gappy = [line[0], line[1], { ...line[2], gap: true }, line[3]];
  t('a share keeps its gaps as indexes', breaksOf(gappy).join() === '2');
  t('and gets them back', withBreaks(line.slice(0, 4), [2])[2].gap === true && !withBreaks(line.slice(0, 4), [2])[1].gap);
}

head('private places, kept');
{
  const rows = { zones: [], next: 1 };
  const geo = {
    enabled: () => true,
    listZones: async () => rows.zones.map((z) => ({ ...z })),
    createZone: async (z) => { const id = rows.next++; rows.zones.push({ id, ...z }); return id; },
    deleteZone: async (id) => { rows.zones = rows.zones.filter((z) => z.id !== id); return 1; },
  };
  // Half-way out, due south, every time: 250 · √½ ≈ 177 m.
  const store = makeZones({ geo, random: () => 0.5 });
  await store.load();
  const spot = { latitude: 36.3, longitude: 59.6 };
  const made = await store.create({ owner: '3', name: 'Home', ...spot, radius: 500 });
  t('a place is kept with its centre moved', Math.abs(metresBetween(spot, made) - 176.8) < 1, metresBetween(spot, made));
  t('and the spot that was clicked is not stored anywhere',
    !JSON.stringify(rows).includes('36.3,') && !JSON.stringify(rows).includes('"latitude":36.3}'), rows.zones);
  t('its owner sees it', store.of('3').length === 1 && store.of('2').length === 0);
  t('everything within half the radius of the spot is hidden',
    [0, 90, 180, 270].every((deg) => {
      const b = (deg * Math.PI) / 180;
      const p = { latitude: spot.latitude + (249 / 111195) * Math.cos(b), longitude: spot.longitude + (249 / (111195 * Math.cos(36.3 * Math.PI / 180))) * Math.sin(b) };
      return Boolean(store.at('3', p.latitude, p.longitude));
    }));
  t('nobody else can remove it', (await store.remove('2', made.id)) === false && store.of('3').length === 1);
  const inside = store.veil({ id: '3', latitude: 36.2995, longitude: 59.6, accuracy: 5, heading: 10, trail: [] });
  t('inside it, the person is the place', inside.hidden && inside.accuracy === 500 && inside.latitude === made.latitude);
  t('a fence reading inside it counts as hidden', Boolean(store.at('3', 36.2995, 59.6)) && !store.at('3', 36.4, 59.6));

  const again = makeZones({ geo });
  await again.load();
  t('a restart finds the same places', again.of('3').length === 1 && Boolean(again.at('3', 36.2995, 59.6)));
  store.forget('3');
  t('/stop takes them with it', store.of('3').length === 0 && !store.at('3', 36.2995, 59.6));
  t('its owner can remove a place', (await again.remove('3', made.id)) === true && again.of('3').length === 0);
  t('a person without places is passed through untouched', (() => {
    const p = { id: '8', latitude: 1, longitude: 1, trail: [] };
    return again.veil(p) === p;
  })());
}

head('GPX: a path as a file other software reads');
{
  const t0 = 1_790_000_000;
  const walk = Array.from({ length: 3 }, (_, i) => ({ latitude: 36.3 + i * 0.001, longitude: 59.6, at: t0 + i * 30 }));
  const later = walk.map((q) => ({ ...q, latitude: q.latitude + 0.01, at: q.at + 3600 }));
  const file = toGpx({ name: 'Ada', points: splitAtPauses([...walk, ...later]), time: t0 });
  t('it declares GPX 1.1', file.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"')
    && file.includes('xmlns="http://www.topografix.com/GPX/1/1"'));
  t('an hour’s pause starts a new segment, so nothing joins the two with a line',
    file.split('<trkseg>').length - 1 === 2);
  t('a hidden stretch does too', toGpx({ points: [walk[0], walk[1], { ...walk[2], gap: true }] }).split('<trkseg>').length - 1 === 2);
  t('times are UTC, to the second', file.includes('<time>2026-09-21T14:13:20Z</time>'));
  t('coordinates to seven places', file.includes('<trkpt lat="36.3000000" lon="59.6000000">'));
  t('a fix without a time has none, rather than 1970', !toGpx({ points: [{ latitude: 1, longitude: 1, at: null }] }).includes('<time>'));
  t('nonsense coordinates are left out', !toGpx({ points: [{ latitude: 91, longitude: 0 }, { latitude: 'x', longitude: 1 }] }).includes('<trkpt'));
  const odd = xmlText('Ada <b> & "Grace" \u0001\u000B');
  t('a name is escaped, and characters XML forbids are dropped', odd === 'Ada &lt;b&gt; &amp; &quot;Grace&quot; ', odd);
  t('the day is the one the page picked, not Greenwich’s', dayOf(1_790_022_600, -210) === '2026-09-22' && dayOf(1_790_022_600, 0) === '2026-09-21');
  const persian = contentDisposition('آرش', '2026-09-22');
  t('a Persian name survives as the file name', persian.includes("filename*=UTF-8''%D8%A2%D8%B1%D8%B4%202026-09-22.gpx"), persian);
  t('with a plain fallback for anything old', persian.startsWith('attachment; filename="2026-09-22.gpx"'));
  t('and a name that is only punctuation is a path', contentDisposition('', '').includes('filename="path.gpx"'));
  const quoted = /filename\*=UTF-8''([^;]*)$/.exec(contentDisposition("O'Neil (x)", '2026-01-01'))[1];
  t('quotes and brackets are encoded, not trusted', quoted === 'O%27Neil%20%28x%29%202026-01-01.gpx', quoted);
}

head('private places, on the wire');
{
  const db = {
    users: [{ id: '1', name: 'Admin', username: '' }, { id: '2', name: 'Ada', username: '' }, { id: '3', name: 'Grace', username: '' }],
    grants: [{ owner: '3', viewer: '2' }],   // Grace lets Ada see her
    zones: [], next: 1, history: [],
  };
  const geo = {
    enabled: () => true,
    listUsers: async () => db.users,
    listGrants: async () => db.grants,
    upsertUser: async () => true,
    addGrant: async () => true,
    removeGrant: async () => 1,
    historyOf: async (id) => (id === '3' ? [...db.history].sort((a, b) => b.at - a.at) : []),
    listFences: async () => [],
    placeOf: async () => '',
    forget: async () => 1,
    listZones: async () => db.zones,
    createZone: async (z) => { const id = db.next++; db.zones.push({ id, ...z }); return id; },
    deleteZone: async (id) => { db.zones = db.zones.filter((z) => z.id !== id); return 1; },
    shares: [],
    createShare: async ({ token, person, name, points, breaks }) => { geo.shares.push({ token, person, name, points, breaks }); return true; },
    readShare: async (token) => {
      const sh = geo.shares.find((x) => x.token === token);
      return sh ? { name: sh.name, at: now, points: sh.points.map((q) => [q.latitude, q.longitude]),
        times: sh.points.map((q) => q.at), breaks: sh.breaks, person: sh.person } : null;
    },
    shareOwner: async (token) => geo.shares.find((x) => x.token === token)?.person ?? null,
  };
  const botToken = '123:zones';
  const circles = makeCircles({ geo, admins: ['1'] });
  await circles.load();
  // Half the offset, due south: the place's centre lands 177 m south of the
  // spot Grace clicks, and everything within 500 m of it is hidden.
  const zones = makeZones({ geo, random: () => 0.5 });
  await zones.load();
  const store = new Positions({ minMove: 1 });
  const now = Math.floor(Date.now() / 1000);
  // Grace walks home from the north, a fix every 55 m for two kilometres. The
  // last three fixes are inside the place she is about to hide.
  const walk = [...Array.from({ length: 40 }, (_, i) => +(36.3225 - i * 0.0005).toFixed(4)), 36.3025, 36.3020, 36.3004];
  walk.forEach((lat, i) => {
    const fix = { id: '3', name: 'Grace', latitude: lat, longitude: 59.6, accuracy: 5, heading: 180, at: now - 600 + i * 100, liveUntil: now + 3600 };
    store.update(fix);
    db.history.push({ at: fix.at, latitude: lat, longitude: 59.6 });
  });
  store.update({ id: '2', name: 'Ada', latitude: 36.40, longitude: 59.6, accuracy: 5, at: now, liveUntil: now + 3600 });

  const { server, publish, publishFence } = serve(store, {
    dashboardToken: 'tok', botToken, viewers: ['1'], port: 0, host: '127.0.0.1', shareTtl: 60,
  }, { geo, circles, zones, links: makeLinks(), log: { info() {}, error() {} } });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = {
    token: { cookie: 'tll_token=tok' },
    admin: { cookie: `tll_session=${encodeURIComponent(mint('1', { botToken }))}` },
    ada: { cookie: `tll_session=${encodeURIComponent(mint('2', { botToken }))}` },
    grace: { cookie: `tll_session=${encodeURIComponent(mint('3', { botToken }))}` },
  };
  const hit = (who, path, method = 'GET') => fetch(base + path, { method, headers: as[who] });
  const open = async (who) => {
    const res = await fetch(`${base}/api/stream`, { method: 'POST', headers: as[who] });
    const seen = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      for (;;) {
        const step = await reader.read().catch(() => ({ done: true }));
        if (step.done) return;
        buf += dec.decode(step.value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const c of parts) {
          const ev = /event: (\w+)/.exec(c)?.[1];
          const raw = /data: (.*)/.exec(c)?.[1] || '{}';
          seen.push({ ev, data: JSON.parse(raw), raw });
        }
      }
    })();
    return { seen, close: () => reader.cancel().catch(() => {}) };
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const graceIn = (people) => people.find((p) => p.id === '3');

  // Before any place exists, Ada sees Grace exactly — that is the baseline.
  const early = await open('ada');
  const adminStream = await open('admin');
  await settle();
  t('before a place exists, Ada sees Grace where she is',
    graceIn(early.seen.find((e) => e.ev === 'hello').data.people).latitude === 36.3004);

  const madeRes = await hit('grace', '/api/zones?name=Home&lat=36.3&lon=59.6&radius=500', 'POST');
  const made = await madeRes.json();
  const centre = made.zone;
  t('Grace hides her home', madeRes.status === 200 && centre.radius === 500, made);
  t('and the circle it is shown as is not centred on the spot she chose',
    Math.abs(metresBetween({ latitude: 36.3, longitude: 59.6 }, centre) - 176.8) < 1);
  await settle();
  const after = early.seen.length;
  const told = early.seen.slice(early.seen.findIndex((e) => e.ev === 'forget'));
  t('Ada’s open map is told to forget what it had', told[0]?.ev === 'forget' && told[0].data.id === '3', early.seen.map((e) => e.ev));
  t('and is sent Grace again, as a blur', told[1]?.ev === 'position' && told[1].data.hidden === true
    && told[1].data.latitude === centre.latitude && told[1].data.accuracy === 500, told[1]?.data);
  t('the admin’s map is not disturbed', !adminStream.seen.some((e) => e.ev === 'forget'));
  t('Grace’s own map is told to redraw her places', await (async () => {
    const own = await open('grace');
    await hit('grace', '/api/zones?name=Work&lat=36.5&lon=59.6&radius=300', 'POST');
    await settle();
    own.close();
    return own.seen.some((e) => e.ev === 'zones') && !own.seen.some((e) => e.ev === 'forget');
  })());

  // Everything Ada can receive from here on is collected and swept.
  const bodies = [];
  const take = async (who, path) => { const r = await hit(who, path); const text = await r.text(); bodies.push({ path, text }); return JSON.parse(text); };
  const late = await open('ada');
  await settle();
  const adaList = await take('ada', '/api/positions');
  const g = graceIn(adaList.people);
  t('Ada’s list has Grace as the place, not the point', g.hidden && g.latitude === centre.latitude && g.heading === null);
  t('with the part of her path that was outside it', g.trail.length === 40
    && g.trail.every((q) => metresBetween(q, centre) > centre.radius) && g.trail[39].latitude === 36.303, g.trail.length);
  const adaHistory = await take('ada', '/api/history/3');
  t('Ada’s history of Grace stops where the place begins',
    adaHistory.points.length === 40 && adaHistory.points[0].latitude === 36.303, adaHistory.points.slice(0, 3));
  await take('ada', '/api/person/3');
  await take('ada', '/api/me');
  await take('ada', '/api/zones');

  t('the admin still sees exactly', graceIn((await (await hit('admin', '/api/positions')).json()).people).latitude === 36.3004);
  t('and so does the shared token', graceIn((await (await hit('token', '/api/positions')).json()).people).latitude === 36.3004);
  t('and Grace herself', graceIn((await (await hit('grace', '/api/positions')).json()).people).latitude === 36.3004);
  t('the admin’s history is whole', (await (await hit('admin', '/api/history/3')).json()).points.length === 43);

  // Sharing, with the place in force: what the world gets is the circle's
  // view, less a few hundred metres at each end.
  const shareRes = await hit('grace', '/api/share/3', 'POST');
  const shared = geo.shares[0];
  t('Grace can share her walk home', shareRes.status === 200 && Boolean(shared), shareRes.status);
  t('and nothing inside her place is in it', shared.points.every((q) => metresBetween(q, centre) > centre.radius));
  const alongStart = metresBetween({ latitude: 36.3225, longitude: 59.6 }, shared.points[0]);
  const alongEnd = metresBetween({ latitude: 36.3030, longitude: 59.6 }, shared.points[shared.points.length - 1]);
  t('its first few hundred metres are gone', alongStart >= 200 && alongStart < 560, alongStart);
  t('and the last few hundred before the place', alongEnd >= 200 && alongEnd < 560, alongEnd);
  const token = (await shareRes.json()).token;
  const opened = await (await fetch(`${base}/api/shared/${token}`)).json();
  t('the link opens on that path', opened.points.length === shared.points.length);
  t('without saying whose it is', !('person' in opened));
  // The share page's tiles come with the token and nobody signed in. They
  // used to reach a check that read `viewer.via` on nobody, and the first one
  // took the whole server down.
  const tileRes = await fetch(`${base}/tiles/15/21809/12850.png?s=${token}`);
  t('a share page can ask for tiles by its token', tileRes.status === 200 || tileRes.status === 502, tileRes.status);
  t('and the server is still there afterwards', (await fetch(`${base}/healthz`)).status === 200);
  t('a tile with a made-up token is refused', (await fetch(`${base}/tiles/15/21809/12850.png?s=notarealtoken123`)).status === 401);
  const asGpx = await fetch(`${base}/api/shared/${token}?format=gpx`);
  t('and gives it as GPX too', asGpx.status === 200 && /application\/gpx\+xml/.test(asGpx.headers.get('content-type'))
    && (await asGpx.text()).split('<trkpt ').length - 1 === shared.points.length);
  // A place hidden after the link was sent covers it too.
  await hit('grace', '/api/zones?name=Cafe&lat=36.316&lon=59.6&radius=200', 'POST');
  const cafe = zones.of('3').find((z) => z.name === 'Cafe');
  const reopened = await (await fetch(`${base}/api/shared/${token}`)).json();
  t('a place hidden later is taken out of a link already sent',
    reopened.points.length < opened.points.length
    && reopened.points.every(([latitude, longitude]) => metresBetween({ latitude, longitude }, cafe) > cafe.radius));
  t('and the path says where it jumps', reopened.breaks.length === 1, reopened.breaks);
  await hit('grace', `/api/zones/${cafe.id}`, 'DELETE');

  // She moves about at home. Ada's maps hear only that she is still there.
  publish(store.update({ id: '3', name: 'Grace', latitude: 36.3001, longitude: 59.6, accuracy: 5, heading: 90, at: now + 5, liveUntil: now + 3600 }));
  await settle();
  const exactToAdmin = adminStream.seen.filter((e) => e.ev === 'position' && e.data.id === '3').pop();
  t('a move inside the place reaches the admin exactly', exactToAdmin?.data.latitude === 36.3001);

  const blurredMove = late.seen.filter((e) => e.ev === 'position' && e.data.id === '3').pop();
  t('while Ada’s map hears only that she is still in the place', blurredMove?.data.hidden === true
    && blurredMove.data.latitude === centre.latitude && blurredMove.data.heading === null);
  await take('ada', '/api/positions');
  await take('ada', '/api/history/3');

  // A fence of Ada's that Grace crossed while hidden is not Ada's to hear of.
  publishFence({ person: '3', owner: '2', fence: 7, name: 'The park', entered: true, at: now, exactOnly: true });
  await settle();
  t('a crossing made while hidden is not told to Ada', !late.seen.some((e) => e.ev === 'fence'));
  t('but it is told to the admin', adminStream.seen.some((e) => e.ev === 'fence' && e.data.fence === 7));
  publishFence({ person: '3', owner: '2', fence: 8, name: 'The park', entered: true, at: now });
  await settle();
  t('while one made in the open still is', late.seen.some((e) => e.ev === 'fence' && e.data.fence === 8));

  // The sweep: every coordinate Ada was sent from the moment the place
  // existed, in every body and every event, is the place's centre or a point
  // outside the place — and never one of the points Grace was hidden at.
  const events = [...early.seen.slice(after), ...late.seen].filter((e) => e.ev !== 'fence');
  const texts = [...bodies.map((b) => b.text), ...events.map((e) => e.raw)];
  const coords = (value, out = []) => {
    if (Array.isArray(value)) {
      if (value.length === 2 && value.every((n) => typeof n === 'number')) out.push({ latitude: value[0], longitude: value[1] });
      else value.forEach((x) => coords(x, out));
    } else if (value && typeof value === 'object') {
      if (typeof value.latitude === 'number' && typeof value.longitude === 'number') out.push({ latitude: value.latitude, longitude: value.longitude });
      Object.values(value).forEach((x) => coords(x, out));
    }
    return out;
  };
  const seenByAda = texts.flatMap((x) => coords(JSON.parse(x)));
  const hiddenPoints = [36.3025, 36.3020, 36.3004, 36.3001].map((lat) => ({ latitude: lat, longitude: 59.6 }));
  const blurs = events.filter((e) => e.data?.hidden).map((e) => e.data);
  const badly = seenByAda.filter((c) => {
    const isBlur = blurs.some((b) => b.latitude === c.latitude && b.longitude === c.longitude);
    const outsidePlace = metresBetween(c, centre) > centre.radius;
    return !isBlur && !outsidePlace;
  });
  t('every coordinate Ada received is a blur’s centre or outside the place', seenByAda.length > 5 && badly.length === 0, badly);
  t('and none is anywhere Grace was while hidden',
    !seenByAda.some((c) => hiddenPoints.some((h) => metresBetween(c, h) < 1)));
  t('nor does any of those numbers appear in anything Ada was sent',
    !texts.some((x) => /36\.3025|36\.3004|36\.3001|36\.302[^\d]/.test(x)));

  // Places are the owner's alone.
  const adaZones = JSON.parse(bodies.find((b) => b.path === '/api/zones').text);
  t('Ada’s list of places does not include Grace’s', adaZones.zones.length === 0);
  t('Ada cannot remove Grace’s place', (await hit('ada', `/api/zones/${centre.id}`, 'DELETE')).status === 404);
  t('the shared token has no places', (await hit('token', '/api/zones')).status === 404);
  t('a place needs a sensible radius', (await hit('grace', '/api/zones?lat=36&lon=59&radius=50', 'POST')).status === 400);

  // Out of the door again: shown exactly, from the moment she is outside.
  publish(store.update({ id: '3', name: 'Grace', latitude: 36.3100, longitude: 59.6, accuracy: 5, heading: 0, at: now + 60, liveUntil: now + 3600 }));
  await settle();
  const back = late.seen.filter((e) => e.ev === 'position' && e.data.id === '3').pop();
  t('stepping out of the place shows her exactly again', back.data.latitude === 36.31 && !back.data.hidden && back.data.heading === 0);
  t('Grace can remove her own place', (await hit('grace', `/api/zones/${centre.id}`, 'DELETE')).status === 200);

  [early, late, adminStream].forEach((s) => s.close());
  server.close();
}

head('live links: one person, from now, for a while');
{
  const db = {
    users: [{ id: '1', name: 'Admin', username: '' }, { id: '2', name: 'Ada', username: '' }, { id: '3', name: 'Grace', username: '' }],
    grants: [{ owner: '3', viewer: '2' }],   // Grace lets Ada see her
    zones: [], next: 1, links: [],
  };
  const geo = {
    enabled: () => true,
    listUsers: async () => db.users,
    listGrants: async () => db.grants,
    upsertUser: async () => true,
    addGrant: async () => true,
    removeGrant: async () => 1,
    historyOf: async () => [],
    listFences: async () => [],
    placeOf: async () => '',
    forget: async (id) => { db.links = db.links.filter((l) => l.person !== id); return 1; },
    listZones: async () => db.zones,
    createZone: async (z) => { const id = db.next++; db.zones.push({ id, ...z }); return id; },
    deleteZone: async (id) => { db.zones = db.zones.filter((z) => z.id !== id); return 1; },
    readShare: async () => null,
    listLiveLinks: async () => db.links,
    createLiveLink: async (l) => { db.links.push({ ...l }); return true; },
    revokeLiveLink: async (token) => { const n = db.links.length; db.links = db.links.filter((l) => l.token !== token); return n - db.links.length; },
  };
  const botToken = '123:live';
  const circles = makeCircles({ geo, admins: ['1'] });
  await circles.load();
  const zones = makeZones({ geo, random: () => 0 });   // centred on the very spot, to keep the arithmetic plain
  await zones.load();
  const live = makeLive({ geo });
  await live.load();
  const store = new Positions({ minMove: 1 });
  const now = Math.floor(Date.now() / 1000);
  // Grace walked out of her door and up the road before sending anybody
  // anything. None of that is what she is about to share.
  for (let i = 0; i < 10; i++) {
    store.update({ id: '3', name: 'Grace', latitude: +(36.3 + i * 0.0005).toFixed(4), longitude: 59.6, accuracy: 5, at: now - 300 + i * 10, liveUntil: now + 3600 });
  }
  store.update({ id: '2', name: 'Ada', latitude: 36.4, longitude: 59.6, accuracy: 5, at: now - 5, liveUntil: now + 3600 });

  const { server, publish, forget } = serve(store, {
    dashboardToken: 'tok', botToken, viewers: ['1'], port: 0, host: '127.0.0.1', shareTtl: 60,
  }, { geo, circles, zones, live, links: makeLinks(), log: { info() {}, error() {} } });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = {
    none: {},
    token: { cookie: 'tll_token=tok' },
    ada: { cookie: `tll_session=${encodeURIComponent(mint('2', { botToken }))}` },
    grace: { cookie: `tll_session=${encodeURIComponent(mint('3', { botToken }))}` },
  };
  const hit = (who, path, method = 'GET') => fetch(base + path, { method, headers: as[who] });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const follow = async (token) => {
    const res = await fetch(`${base}/api/live-stream/${token}`, { method: 'POST' });
    const seen = [];
    const raw = [];
    if (res.status === 200) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      (async () => {
        for (;;) {
          const step = await reader.read().catch(() => ({ done: true }));
          if (step.done) { seen.push({ ev: '(closed)' }); return; }
          buf += dec.decode(step.value, { stream: true });
          const parts = buf.split('\n\n'); buf = parts.pop();
          for (const c of parts) {
            raw.push(c);
            seen.push({ ev: /event: (\w+)/.exec(c)?.[1], data: JSON.parse(/data: (.*)/.exec(c)?.[1] || '{}') });
          }
        }
      })();
    }
    return { status: res.status, seen, raw };
  };

  t('a live link lasts one of a few set lengths', (await hit('grace', '/api/live?minutes=7', 'POST')).status === 400);
  const madeRes = await hit('grace', '/api/live?minutes=15', 'POST');
  const made = await madeRes.json();
  t('Grace makes one for a quarter of an hour', madeRes.status === 200 && made.path === `/live/${made.token}`
    && made.expiresAt - made.createdAt === 900, made);
  t('the shared token cannot make one — it is nobody', (await hit('token', '/api/live?minutes=15', 'POST')).status === 404);
  t('Grace’s list has it', (await (await hit('grace', '/api/live')).json()).links.length === 1);
  t('Ada’s has nothing of Grace’s', (await (await hit('ada', '/api/live')).json()).links.length === 0);

  const pageRes = await hit('none', `/live/${made.token}`);
  t('the page opens for anybody holding the link', pageRes.status === 200 && (await pageRes.text()).includes('/api/live-stream/'));
  t('a made-up link is a page saying it has ended', (await hit('none', '/live/notarealtoken123')).status === 404);

  const watching = await follow(made.token);
  await settle();
  const hello = watching.seen.find((e) => e.ev === 'hello')?.data;
  t('the follower is told whose link it is, and until when', hello?.name === 'Grace' && hello.until === made.expiresAt, hello);
  t('and is shown Grace, where she is', hello?.people.length === 1 && hello.people[0].id === '3' && hello.people[0].latitude === 36.3045);
  t('but none of the path from before the link', hello?.people[0].trail.length === 0, hello?.people[0].trail);

  publish(store.update({ id: '3', name: 'Grace', latitude: 36.306, longitude: 59.6, accuracy: 5, heading: 0, at: now + 5, liveUntil: now + 3600 }));
  publish(store.update({ id: '2', name: 'Ada', latitude: 36.41, longitude: 59.6, accuracy: 5, at: now + 5, liveUntil: now + 3600 }));
  await settle();
  const moved = watching.seen.filter((e) => e.ev === 'position');
  t('Grace moving reaches the follower', moved.length === 1 && moved[0].data.latitude === 36.306, moved.map((e) => e.data.id));
  t('with the path from the link on, and nothing earlier', moved[0]?.data.trail.every((q) => q.at >= made.createdAt) && moved[0]?.data.trail.length >= 1);
  t('and nobody else ever does', !watching.raw.some((c) => c.includes('"id":"2"') || c.includes('36.41')));
  // Where she stood when she made it is where she is, and is shown; the nine
  // fixes before it are the way from her door, and are not.
  const sentLatitudes = watching.raw.flatMap((c) => [...c.matchAll(/"latitude":(-?[\d.]+)/g)].map((m) => Number(m[1])));
  const before = Array.from({ length: 9 }, (_, i) => +(36.3 + i * 0.0005).toFixed(4));
  t('no fix from before the link is anywhere in what was sent',
    sentLatitudes.length >= 3 && !sentLatitudes.some((lat) => before.includes(lat)), sentLatitudes);

  // A private place applies to a follower as to the circle.
  await hit('grace', '/api/zones?name=Cafe&lat=36.306&lon=59.6&radius=300', 'POST');
  await settle();
  const veiled = watching.seen.filter((e) => e.ev === 'position').pop()?.data;
  t('a place Grace hides now shows as a blur on the link too', veiled?.hidden === true && veiled.accuracy === 300 && veiled.heading === null, veiled);

  // The link is a key to its tiles and its stream, and to nothing else.
  const tile = await fetch(`${base}/tiles/15/21809/12850.png?s=${made.token}`);
  t('the page may ask for tiles by its link', tile.status === 200 || tile.status === 502, tile.status);
  t('the link opens nothing else', (await fetch(`${base}/api/positions?s=${made.token}`)).status === 401
    && (await fetch(`${base}/api/history/3?s=${made.token}`)).status === 401
    && (await fetch(`${base}/api/stream?s=${made.token}`, { method: 'POST' })).status === 401);

  // Only its owner stops it — and the follower is told at once.
  t('Ada, who can see Grace, cannot stop Grace’s link', (await hit('ada', `/api/live/${made.token}`, 'DELETE')).status === 404);
  const stopped = await hit('grace', `/api/live/${made.token}`, 'DELETE');
  await settle();
  t('Grace can', stopped.status === 200 && (await stopped.json()).links.length === 0);
  const ended = watching.seen.find((e) => e.ev === 'ended');
  t('the follower hears that she stopped it, and the stream closes',
    ended?.data.why === 'stopped' && watching.seen.at(-1).ev === '(closed)', watching.seen.map((e) => e.ev));
  t('after which the page says so', (await hit('none', `/live/${made.token}`)).status === 404);
  t('the stream is refused', (await follow(made.token)).status === 404);
  t('and so are the tiles', (await fetch(`${base}/tiles/15/21809/12850.png?s=${made.token}`)).status === 401);

  // A link runs out by itself.
  const brief = await live.create({ person: '3', minutes: 1 / 60 });
  const briefly = await follow(brief.token);
  await settle(1600);
  t('a link that runs out ends its stream', briefly.seen.some((e) => e.ev === 'ended' && e.data.why === 'ended'),
    briefly.seen.map((e) => e.ev));
  t('and is gone', live.get(brief.token) === null && (await hit('none', `/live/${brief.token}`)).status === 404);

  // /stop ends every link its person had, and whoever was following.
  const last = await (await hit('grace', '/api/live?minutes=60', 'POST')).json();
  const lastly = await follow(last.token);
  await settle();
  await forget('3');
  await settle();
  t('asking to be forgotten ends the links, and tells the follower',
    lastly.seen.some((e) => e.ev === 'forget') && lastly.seen.some((e) => e.ev === 'ended') && live.get(last.token) === null,
    lastly.seen.map((e) => e.ev));

  server.close();
}

head('what /live takes');
{
  t('nothing is an hour', liveMinutes('') === 60);
  t('fifteen minutes, written either way', liveMinutes('15') === 15 && liveMinutes('15m') === 15 && liveMinutes('15 min') === 15);
  t('four hours, written either way', liveMinutes('4h') === 240 && liveMinutes('240') === 240 && liveMinutes('4 hours') === 240);
  t('an hour as 1h', liveMinutes('1h') === 60);
  t('anything else is refused, not rounded', liveMinutes('20') === null && liveMinutes('2h') === null && liveMinutes('soon') === null);
  t('and said back plainly', liveFor(15) === '15 minutes' && liveFor(60) === '1 hour' && liveFor(240) === '4 hours');
}

head('what a watch may report');
{
  const now = 1_800_000_000;
  const ok = (fix) => fromDevice(fix, { owner: '42', name: 'Ada', now });
  const good = ok({ lat: 36.3, lon: 59.6, accuracy: 7 });
  t('a plain fix is a position', good.position && good.position.id === '42' && good.position.at === now, good);
  t('live for a while by default', good.position.liveUntil === now + 900);
  t('milliseconds are understood as the mistake they usually are',
    ok({ lat: 1, lon: 1, at: (now - 10) * 1000 }).position.at === now - 10);
  t('an hour from now is refused', ok({ lat: 1, lon: 1, at: now + 3600 }).error === 'from the future');
  t('a minute of clock drift is not', Boolean(ok({ lat: 1, lon: 1, at: now + 30 }).position));
  t('yesterday-and-then-some is too old', ok({ lat: 1, lon: 1, at: now - 90_000 }).error === 'too old');
  t('0,0 is a GPS without a fix', ok({ lat: 0, lon: 0 }).error === 'no fix yet');
  t('an absurd accuracy is refused', ok({ lat: 1, lon: 1, accuracy: 99999 }).error === 'accuracy out of range');
  t('a session end is capped at a day', ok({ lat: 1, lon: 1, until: now + 10 * 86400 }).position.liveUntil === now + 86400);
  t('a stop keeps the place and ends live',
    ok({ lat: 1, lon: 1, stopped: true }).position.liveUntil === null && ok({ lat: 1, lon: 1, stopped: true }).position.stopped === true);
  t('one fix, a list, or {fixes} are all understood',
    readFixes({ lat: 1 }).length === 1 && readFixes([{}, {}]).length === 2 && readFixes({ fixes: [{}] }).length === 1);
}

head('pairing codes');
{
  let clock = 0;
  const codes = makeCodes({ life: 1000, perAddress: 2, globalFailures: 100, now: () => clock });
  const c = codes.issue('7');
  t('six digits', /^\d{6}$/.test(c), c);
  t('asking again replaces the old one', (() => { const d = codes.issue('7'); return codes.size === 1 && d !== undefined; })());
  const d = codes.issue('7');
  clock = 1001;
  t('and a code expires', codes.redeem(d, 'a') === null);
  const limiter = makeLimiter({ limit: 2, windowMs: 100, now: () => clock });
  t('a limiter lets the first few through', !limiter.over('x') && !limiter.over('x'));
  t('then refuses', limiter.over('x'));
  clock += 101;
  t('and forgives after the window', !limiter.over('x'));
}


// ------------------------------------------------ Sign in with Telegram

// A signing key and a JWKS, made here, standing in for Telegram's.
async function oidcKeys(kid = 'k1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, use: 'sig', alg: 'RS256' };
  const enc = (o) => bytesToB64u(new TextEncoder().encode(JSON.stringify(o)));
  const sign = async (claims, header = { alg: 'RS256', kid }) => {
    const head = `${enc(header)}.${enc(claims)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head));
    return `${head}.${bytesToB64u(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}

head('checking what Telegram signed');
{
  resetCaches();
  const { jwk, sign } = await oidcKeys();
  const other = await oidcKeys();
  const jwksUri = 'https://issuer.test/jwks';
  const fetchImpl = async (u) => new Response(JSON.stringify({ keys: [jwk] }));
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://issuer.test', aud: '123', sub: 'site-scoped-9', exp: now + 300, iat: now, nonce: 'n1' };
  const check = (token, opts = {}) => verifyIdToken(token, {
    jwksUri, issuer: 'https://issuer.test', clientId: '123', nonce: 'n1', fetchImpl, ...opts,
  }).then((c) => c, (e) => e);

  const good = await check(await sign(base));
  t('a token Telegram signed for us verifies', good.sub === 'site-scoped-9', good && good.message);
  t('one meant for another client does not', /audience/.test((await check(await sign({ ...base, aud: '999' }))).message));
  t('nor an expired one', /expired/.test((await check(await sign({ ...base, exp: now - 3600 }))).message));
  t('nor one answering somebody else’s request', /nonce/.test((await check(await sign({ ...base, nonce: 'n2' }))).message));
  t('nor one from another issuer', /issuer/.test((await check(await sign({ ...base, iss: 'https://evil.test' }))).message));
  t('nor one signed with a key that is not Telegram’s',
    /signature/.test((await check(await other.sign(base))).message));
  const unknownKid = await check(await sign(base, { alg: 'RS256', kid: 'nope' }));
  t('an unknown key id is refused, after asking for fresh keys once', /No matching JWKS key/.test(unknownKid.message));
  t('and "none" is not an algorithm', /Unsupported/.test((await check(await sign(base, { alg: 'none', kid: 'k1' }))).message));
}

head('purpose-separated seals');
{
  const tx = seal('oidc-tx', { state: 's' }, 60, 'secret');
  t('a sealed value opens for its own purpose', unseal('oidc-tx', tx, 'secret')?.state === 's');
  t('and not as a session', unseal('session', tx, 'secret') === null);
  t('nor under another secret', unseal('oidc-tx', tx, 'other') === null);
  t('nor once expired', unseal('oidc-tx', seal('oidc-tx', {}, -1, 'secret'), 'secret') === null);
}

head('Sign in with Telegram, end to end against a stand-in provider');
{
  resetCaches();
  const { jwk, sign } = await oidcKeys();
  // The stand-in: discovery, a token endpoint, and the keys.
  let nextNonce = '';
  let signWith = sign;
  const provider = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const base = `http://127.0.0.1:${provider.address().port}`;
    const out = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      return out({ issuer: base, authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
    }
    if (u.pathname === '/jwks') return out({ keys: [jwk] });
    if (u.pathname === '/token') {
      const now = Math.floor(Date.now() / 1000);
      return out({ id_token: await signWith({ iss: base, aud: '777', sub: 'site-scoped-ada', exp: now + 300, iat: now, nonce: nextNonce, given_name: 'Ada' }) });
    }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => provider.once('listening', r));
  const issuer = `http://127.0.0.1:${provider.address().port}`;

  const linkedSubs = [];
  const geo = {
    enabled: () => true,
    listUsers: async () => [{ id: '3', name: 'Ada', username: '' }],
    listGrants: async () => [],
    upsertUser: async () => true,
    userBySub: async (sub) => linkedSubs.find((l) => l.sub === sub)?.id ?? null,
    linkSub: async (id, sub) => { linkedSubs.push({ id, sub }); return true; },
  };
  const circles = makeCircles({ geo, admins: [] });
  await circles.load();
  const links = makeLinks();
  const { server } = serve(new Positions(), {
    dashboardToken: '', botToken: '777:oidc', viewers: [], port: 0, host: '127.0.0.1',
    oidcSecret: 'client-secret', oidcClientId: '777', oidcIssuer: issuer, oidcScope: 'openid profile',
    publicUrl: 'http://app.test',
  }, { geo, circles, links, log: { info() {}, error() {} } });
  await new Promise((r) => server.once('listening', r));
  const app = `http://127.0.0.1:${server.address().port}`;
  const cookieFrom = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')) || '';

  // Round one: signed in by Telegram, not yet linked.
  const start = await fetch(`${app}/auth/telegram/start`, { redirect: 'manual' });
  const to = new URL(start.headers.get('location'));
  t('start sends the browser to Telegram with PKCE', start.status === 302 && to.searchParams.get('code_challenge_method') === 'S256'
    && to.searchParams.get('client_id') === '777');
  t('asking only for what is used', to.searchParams.get('scope') === 'openid profile');
  const tx = cookieFrom(start, 'tll_oidc_tx');
  nextNonce = to.searchParams.get('nonce');
  const state = to.searchParams.get('state');

  const forged = await fetch(`${app}/auth/telegram/callback?code=c&state=someone-elses`, { headers: { cookie: tx }, redirect: 'manual' });
  t('a callback with the wrong state is refused', forged.status === 400);
  const noTx = await fetch(`${app}/auth/telegram/callback?code=c&state=${state}`, { redirect: 'manual' });
  t('and one without the transaction cookie', noTx.status === 400);

  const first = await fetch(`${app}/auth/telegram/callback?code=c&state=${state}`, { headers: { cookie: tx }, redirect: 'manual' });
  const pending = cookieFrom(first, 'tll_oidc');
  t('the first time, it asks for one more step instead of guessing who this is',
    first.status === 200 && /One more step/.test(await first.text()) && Boolean(pending));
  t('and grants no session yet', !cookieFrom(first, 'tll_session'));

  // The bot's /login link, opened in the same browser, proves the account.
  const token = links.issue('3');
  const opened = await fetch(`${app}/auth/${token}`, { headers: { cookie: pending }, redirect: 'manual' });
  t('opening /login’s link in that browser signs in', opened.status === 302 && Boolean(cookieFrom(opened, 'tll_session')));
  t('and links the Telegram sign-in to the account the bot knows',
    linkedSubs.length === 1 && linkedSubs[0].id === '3' && linkedSubs[0].sub === 'site-scoped-ada', linkedSubs);

  // Round two: straight in.
  const start2 = await fetch(`${app}/auth/telegram/start`, { redirect: 'manual' });
  const to2 = new URL(start2.headers.get('location'));
  nextNonce = to2.searchParams.get('nonce');
  const second = await fetch(`${app}/auth/telegram/callback?code=c&state=${to2.searchParams.get('state')}`,
    { headers: { cookie: cookieFrom(start2, 'tll_oidc_tx') }, redirect: 'manual' });
  t('after that, Telegram sign-in goes straight in', second.status === 302 && Boolean(cookieFrom(second, 'tll_session')));

  // A token not signed by the provider's key.
  const impostor = await oidcKeys();
  signWith = impostor.sign;
  const start3 = await fetch(`${app}/auth/telegram/start`, { redirect: 'manual' });
  const to3 = new URL(start3.headers.get('location'));
  nextNonce = to3.searchParams.get('nonce');
  const bad = await fetch(`${app}/auth/telegram/callback?code=c&state=${to3.searchParams.get('state')}`,
    { headers: { cookie: cookieFrom(start3, 'tll_oidc_tx') }, redirect: 'manual' });
  t('a token signed by anyone else signs nobody in', bad.status === 400 && !cookieFrom(bad, 'tll_session'));

  server.close();
  provider.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
