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
    ORIGIN: 'http://10.0.0.1:8080',
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
    asked[0].url === 'http://10.0.0.1:8080/api/positions?token=tok', asked[0] && asked[0].url);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
