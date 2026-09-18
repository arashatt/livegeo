// test.mjs — `npm test`. Plain node, no framework.
//
// Everything here runs without a network or a Telegram account. The geo
// objects are built with the real library constructors, so a change in
// teleproto that renamed a field would fail here rather than in production.
//
// What is NOT covered: src/mtproto.js, which is connection and event wiring.
// It can only be exercised against Telegram itself — see README «Verifying».

import { Api } from 'teleproto';
import { fromMessage, senderOf, Positions } from '../src/positions.js';
import { personOf, makeDirectory } from '../src/directory.js';
import { placeName, makeGeo } from '../src/geo.js';
import { parseTilePath, tileUrl, makeTiles } from '../src/tiles.js';
import { serve, staticFile } from '../src/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
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

  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
