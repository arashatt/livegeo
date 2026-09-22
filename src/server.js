// server.js — the dashboard: a map page, the positions behind it, and a
// stream that pushes every change to whoever is watching.
//
// This page shows where people are, so it is never served without the token.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { parseTilePath, makeTiles } from './tiles.js';
import { COOKIE, sameToken, tokenOf } from './token.js';
import { SESSION_COOKIE, mint, readSession, checkWidget } from './login.js';
import { makeCircles, canActFor } from './circles.js';
import { randomBytes } from 'node:crypto';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PAGE = resolve(PUBLIC, 'index.html');
const SHARE_PAGE = resolve(PUBLIC, 'share.html');
const LOGIN_PAGE = resolve(PUBLIC, 'login.html');

const STATIC_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Resolves a request path inside public/, or returns null. The prefix check is
// the point: URL parsing collapses a literal "..", but a percent-encoded one
// survives to decodeURIComponent, and only comparing the resolved path catches
// that.
// The bot username and domain are interpolated into the login page, and both
// come from outside this file. Neither can contain a quote once escaped.
function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function staticFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  const file = resolve(PUBLIC, '.' + (rel.startsWith('/') ? rel : `/${rel}`));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return null;
  const type = STATIC_TYPES[extname(file).toLowerCase()];
  return type ? { file, type } : null;
}

export function serve(positions, config, {
  log = console, directory = null, geo = null, links = null,
  // Who may see whom. Without one, a circle-less stand-in: admins and the
  // shared token, which is exactly what the service did before circles.
  circles = makeCircles({ admins: config.viewers }),
  // Mints a one-time invite for a person and returns a link to it, or null.
  // Given by index.js because only the bot knows its own username.
  makeInvite = null,
  // Told when a fence is deleted, so whatever is watching them can drop the
  // state it holds about it.
  onFenceDeleted = null,
} = {}) {
  // Open streams, and who is at the other end of each. Every event is checked
  // against the viewer before it is written, so a stream only ever carries
  // people its viewer may see.
  const watchers = new Map();   // res -> viewer
  const hasAdmins = (config.viewers || []).length > 0;
  // Sign-in is available when there is anybody it could admit: admins, or —
  // with a database to keep circles in — everyone the bot has met. A login
  // page that can admit nobody is worse than no login page.
  const signInOn = () => Boolean(config.botToken && links && (hasAdmins || circles.enabled));
  // Known only after the bot connects, which happens after this is listening.
  let botName = '';

  // Share tokens seen to be good, and when that answer goes stale. A share page
  // asks for dozens of tiles; one database round trip covers all of them.
  const shareCache = new Map();
  const SHARE_CACHE_MS = 60_000;

  async function validShare(token) {
    if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token) || !geo) return false;
    const seen = shareCache.get(token);
    if (seen && seen > Date.now()) return true;
    const found = await geo.readShare(token).catch(() => null);
    if (!found) { shareCache.delete(token); return false; }
    shareCache.set(token, Date.now() + SHARE_CACHE_MS);
    return true;
  }

  async function serveStatic(url, res) {
    const hit = staticFile(url.pathname);
    const bytes = hit ? await readFile(hit.file).catch(() => null) : null;
    if (!bytes) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'private, max-age=604800' });
    res.end(bytes);
  }

  const tiles = makeTiles({
    cacheDir: config.tileCache,
    upstream: config.tileUpstream,
    userAgent: config.tileUserAgent,
    maxAge: config.tileMaxAge,
    log,
  });

  const send = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Removing somebody, from wherever the request came from: the button on the
  // page, or /stop sent to the bot. One implementation, because these must not
  // be able to disagree about what forgetting means.
  async function forget(id) {
    // Who could see them has to be worked out before the erasure, which takes
    // the grants with it — afterwards nobody could, and nobody would be told.
    const told = [...watchers].filter(([, viewer]) => circles.canSee(viewer, id)).map(([res]) => res);
    positions.forget(id);
    // Forgetting has to mean forgetting. History is kept indefinitely, so the
    // one action that removes a person must clear the record too, not just
    // take them off the map until the next update arrives.
    const erased = geo ? await geo.forget(id).catch((e) => {
      log.error('geo: erasure failed —', e && e.message ? e.message : e);
      return null;
    }) : 0;
    circles.forget(id);
    for (const res of told) { try { send(res, 'forget', { id }); } catch { watchers.delete(res); } }
    return erased;
  }

  // `about` is the person the event concerns, when there is one. An event
  // about nobody in particular goes to everyone; an event about somebody goes
  // only to the streams whose viewer may see them.
  const broadcast = (event, data, { about = undefined, to = null } = {}) => {
    for (const [res, viewer] of watchers) {
      if (about !== undefined && !circles.canSee(viewer, about)) continue;
      if (to && !to(viewer)) continue;
      try { send(res, event, data); } catch { watchers.delete(res); }
    }
  };

  // Called whenever a position changes; every open map hears about it at once,
  // which is the whole point of doing this over MTProto rather than polling.
  const publish = (person) => {
    broadcast('position',
      { ...person, live: Boolean(person.liveUntil && person.liveUntil > Date.now() / 1000) },
      { about: person.id });
  };

  // Changing a circle changes what open maps may show, and they should not
  // have to be reloaded to find out. Revoking takes the person off the other
  // viewer's map at once; granting puts them on it.
  async function revoke(owner, viewer) {
    await circles.revoke(owner, viewer);
    for (const [res, v] of watchers) {
      if (v.id === String(viewer) && !circles.canSee(v, owner)) {
        try { send(res, 'forget', { id: String(owner) }); } catch { watchers.delete(res); }
      }
    }
  }

  async function grant(owner, viewer) {
    const done = await circles.grant(owner, viewer);
    const p = done ? positions.get(owner) : null;
    if (p) {
      const payload = { ...p, live: Boolean(p.liveUntil && p.liveUntil > Date.now() / 1000) };
      for (const [res, v] of watchers) {
        if (v.id === String(viewer)) { try { send(res, 'position', payload); } catch { watchers.delete(res); } }
      }
    }
    return done;
  }

  // A fence crossed, or somebody's fences changed. Only the fence's owner and
  // admins are told, and a crossing only if they may also see who crossed: a
  // fence is a named place in somebody's life, and "Ada arrived at home" is
  // two private facts, not one.
  const publishFence = (data) => broadcast('fence', data, {
    about: data.person === undefined ? undefined : data.person,
    to: (viewer) => viewer.admin || (data.owner !== null && data.owner !== undefined && viewer.id === String(data.owner)),
  });

  // Who this request is: { id, admin, via }, or null.
  //
  // Checked on every request rather than once at sign-in, so removing somebody
  // from DASHBOARD_USERS, or /stop, takes effect on their next request rather
  // than whenever their cookie happens to expire.
  const viewerOf = (req, url) => {
    // The `config.dashboardToken &&` is load-bearing: sameToken('', '') is
    // true, so without it an unset token would admit everybody rather than
    // nobody.
    if (config.dashboardToken && sameToken(tokenOf(req.headers.cookie, url), config.dashboardToken)) {
      return { id: null, admin: true, via: 'token' };
    }
    if (!signInOn()) return null;
    const raw = String(req.headers.cookie || '')
      .split(';').map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!raw) return null;
    const id = readSession(decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1)),
      { botToken: config.botToken });
    const viewer = circles.viewerFor(id);
    return viewer ? { ...viewer, via: 'session' } : null;
  };

  const setSession = (res, id, to = '/') => {
    res.writeHead(302, {
      location: to,
      'cache-control': 'no-store',
      'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(mint(id, { botToken: config.botToken }))}`
        + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
    });
    res.end();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const viewer = viewerOf(req, url);
    const ok = Boolean(viewer);

    // Not "forbidden": that would confirm the person exists. Somebody you may
    // not see answers exactly as somebody who was never there.
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"not found"}');
    };
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    // A browser gets a page explaining how to get in; anything else gets the
    // one line it can act on. Being turned away should not be a dead end.
    const deny = async () => {
      const wantsPage = signInOn() && /text\/html/.test(req.headers.accept || '');
      const page = wantsPage ? await readFile(LOGIN_PAGE, 'utf8').catch(() => null) : null;
      if (page) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page.replace('<body>',
          `<body data-bot="${escapeAttr(botName)}" data-domain="${escapeAttr(config.botDomain || '')}">`));
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(signInOn()
        ? '401 — send /login to the bot for a link that opens this'
        : '401 — append ?token=… to the URL');
    };

    // /healthz is deliberately before this: the rollout's health check runs on
    // the server itself, over loopback, and has no key to present. It reports
    // counts and nothing else.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, watching: watchers.size, people: positions.list().length }));
      return;
    }

    // Answer only the edge, when an edge has been configured. This is what
    // makes binding to a public interface safe enough to do: a scanner that
    // finds the port gets nothing, without having to guess the dashboard
    // token to find that out.
    if (config.edgeKey && !sameToken(req.headers['x-edge-key'] || '', config.edgeKey)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('403');
      return;
    }

    // Signing in necessarily happens before there is anything to sign in
    // with, so these sit ahead of the gate rather than behind it.
    // Signing out needs no sign-in to reach, and clears only this browser.
    if (url.pathname === '/auth/logout') {
      res.writeHead(302, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': [
          `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        ],
      });
      res.end();
      return;
    }

    if (signInOn() && url.pathname.startsWith('/auth/')) {
      const refuse = (why) => {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(why);
      };

      // The widget's reply, which Telegram signs. Off unless a domain has
      // been registered for the bot, because without one the button cannot
      // appear in the first place.
      if (url.pathname === '/auth/widget') {
        if (!config.botDomain) return refuse('the login widget is not configured');
        const fields = Object.fromEntries(url.searchParams.entries());
        const id = checkWidget(fields, { botToken: config.botToken });
        if (!id) return refuse('that sign-in did not verify');
        // The widget's id is the real Telegram id, so somebody the bot has not
        // met yet can be recorded here and see themselves from the start.
        await circles.seen({
          id,
          name: [fields.first_name, fields.last_name].filter(Boolean).join(' '),
          username: fields.username || '',
        });
        if (!circles.viewerFor(id)) return refuse('that account cannot sign in here');
        log.info('login: somebody signed in with the widget');
        return setSession(res, id);
      }

      // A one-time link from the bot. Single use and short-lived, because a
      // link sits in a chat history where somebody else may read it.
      const id = links.redeem(url.pathname.slice('/auth/'.length));
      if (!id) return refuse('that link has been used already, or has expired — send /login again');
      if (!circles.viewerFor(id)) return refuse('that account cannot sign in here');
      log.info('login: somebody signed in through the bot');
      return setSession(res, id);
    }

    // Leaflet is a public library and a share page needs it, so it is not
    // behind the dashboard token. It carries no data. /lib/ is the same for
    // code of our own that both pages load — arithmetic, not information.
    if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/lib/')) return serveStatic(url, res);

    // A share link is a second key, and a far narrower one: it opens the
    // viewer, the one path behind it, and the tiles that page draws on.
    // Nothing else, and only until it expires.
    const shareToken = url.pathname.startsWith('/share/')
      ? url.pathname.slice('/share/'.length)
      : (url.pathname.startsWith('/api/shared/')
        ? url.pathname.slice('/api/shared/'.length)
        : url.searchParams.get('s') || '');

    if (url.pathname.startsWith('/share/')) {
      if (!(await validShare(shareToken))) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such share'); return; }
      const html = await readFile(SHARE_PAGE, 'utf8').catch(() => null);
      if (!html) { res.writeHead(500); res.end('missing page'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname.startsWith('/api/shared/')) {
      const shared = (await validShare(shareToken)) && geo ? await geo.readShare(shareToken) : null;
      if (!shared) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"gone"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(shared));
      return;
    }

    // Tiles for a share page. Checked against the database once and then
    // remembered, because a map draws dozens of tiles and none of them should
    // cost a query.
    const tileForShare = parseTilePath(url.pathname) && shareToken && await validShare(shareToken);

    if (!ok && !tileForShare) return deny();

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(PAGE, 'utf8').catch(() => null);
      if (!html) { res.writeHead(500); res.end('missing page'); return; }
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      // Remembered so the token is not needed in every later request, and so
      // it stops being visible in the address bar after the first load — but
      // only for somebody who came in *with* the token. Handed to everyone who
      // reached this page, it would give a person signed in as themselves the
      // admin key on their very next request.
      if (viewer.via === 'token') {
        headers['set-cookie'] = `${COOKIE}=${encodeURIComponent(config.dashboardToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
      }
      res.writeHead(200, headers);
      res.end(html);
      return;
    }

    const visible = () => positions.list().filter((p) => circles.canSee(viewer, p.id));

    // Who this is, for the page: whether to offer a circle, a share button.
    if (url.pathname === '/api/me') {
      const me = viewer.id ? circles.user(viewer.id) : null;
      return json(200, {
        id: viewer.id,
        admin: viewer.admin,
        name: me?.name || '',
        circles: circles.enabled && Boolean(viewer.id),
      });
    }

    if (url.pathname === '/api/positions') {
      return json(200, { people: visible() });
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // no-transform asks the middle of the internet not to recompress this.
        // Compression implies buffering, and a buffered stream is not one.
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',   // nginx would otherwise hold the stream
      });
      // No `connection: keep-alive` here: it is the HTTP/1.1 default and Node
      // sends it regardless, so setting it said nothing. It is forbidden in
      // HTTP/2, but a gateway is required to strip it on the way, so this is
      // tidying rather than a fix for anything.
      watchers.set(res, viewer);
      send(res, 'hello', { people: visible() });
      // A named event rather than a bare `: comment`, which costs a few bytes
      // and buys the page the ability to tell a quiet stream from a stalled
      // one: EventSource never surfaces comments to JavaScript, so a stream
      // that silently stopped delivering looked exactly like nobody moving.
      const beat = setInterval(() => { try { send(res, 'beat', {}); } catch { /* gone */ } }, 25000);
      req.on('close', () => { clearInterval(beat); watchers.delete(res); });
      return;
    }

    // The basemap. Guarded like everything else, so this cannot be used as
    // somebody else's free tile proxy.
    const tile = parseTilePath(url.pathname);
    if (tile) {
      const got = await tiles.get(tile);
      if (!got) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('no tile'); return; }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=604800',
        'x-tile-source': got.from,
      });
      res.end(got.bytes);
      return;
    }

    // What is at a point. Asked per person by the page, which rounds the
    // coordinates before asking, so someone standing still asks once.
    if (url.pathname === '/api/place') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      const place = geo ? await geo.placeOf(lat, lon) : '';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ place }));
      return;
    }

    // Where someone has been. Empty rather than an error when nothing is
    // recorded, so the page does not need to know whether PostGIS is there.
    if (url.pathname.startsWith('/api/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
      if (!circles.canSee(viewer, id)) return notFound();
      // A window, because a path drawn across a week is a tangle nobody reads.
      const since = Number(url.searchParams.get('since'));
      const points = geo
        ? await geo.historyOf(id, { limit: 1000, since: Number.isFinite(since) && since > 0 ? since : null })
        : [];
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ id, points }));
      return;
    }

    // Hand one person's path to somebody who does not have the dashboard.
    if (url.pathname.startsWith('/api/share/') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/share/'.length));
      // Your own path, or an admin's call. Being allowed to see somebody is
      // not their consent to have their movements published to the world.
      if (!canActFor(viewer, id)) return notFound();
      const person = positions.get(id);
      const points = (person?.trail || []).filter((t) => t.latitude !== null);
      if (!geo || !geo.enabled()) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"no database"}'); return; }
      if (points.length < 2) { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"no path yet"}'); return; }

      const token = randomBytes(18).toString('base64url');
      const made = await geo.createShare({
        token, person: id, name: person.name || '', points, ttlSeconds: config.shareTtl,
      }).catch((e) => { log.error('share:', e && e.message ? e.message : e); return false; });
      if (!made) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"could not share"}'); return; }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ token, path: `/share/${token}`, expiresIn: config.shareTtl }));
      return;
    }

    if (url.pathname.startsWith('/api/share/') && req.method === 'DELETE') {
      const token = decodeURIComponent(url.pathname.slice('/api/share/'.length));
      const whose = geo ? await geo.shareOwner(token) : null;
      if (!whose || !canActFor(viewer, whose)) return notFound();
      const gone = await geo.revokeShare(token);
      shareCache.delete(token);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked: gone }));
      return;
    }

    // Who a numeric id belongs to. Asked on hover, so it must be cheap: the
    // directory caches, and answers "unknown" rather than blocking when
    // Telegram cannot say.
    if (url.pathname.startsWith('/api/person/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/person/'.length));
      if (!circles.canSee(viewer, id)) return notFound();
      const person = directory
        ? await directory.lookup(id)
        : { id, name: '', username: '', photo: false };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(person));
      return;
    }

    // The profile photo, fetched only when someone opens a card — there is no
    // reason to pull every face just to draw dots on a map.
    if (url.pathname.startsWith('/api/photo/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/photo/'.length));
      if (!circles.canSee(viewer, id)) return notFound();
      const bytes = directory ? await directory.photo(id) : null;
      if (!bytes || !bytes.length) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no photo');
        return;
      }
      // Private and short: this is a picture of a person, behind the token.
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300' });
      res.end(bytes);
      return;
    }

    // Fences. Parameters ride in the query string rather than a JSON body,
    // which is how every other write here works — adding a body reader would
    // mean size limits and content types for the sake of four values.
    if (url.pathname === '/api/fences') {
      if (!geo || !geo.enabled()) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"no database"}');
        return;
      }
      if (req.method === 'POST') {
        const name = (url.searchParams.get('name') || '').trim().slice(0, 80);
        const latitude = Number(url.searchParams.get('lat'));
        const longitude = Number(url.searchParams.get('lon'));
        const radius = Number(url.searchParams.get('radius'));
        // A fence with no name cannot be announced usefully, and one of no
        // size or of absurd size is a mistake rather than an intention.
        const sane = name
          && Number.isFinite(latitude) && Math.abs(latitude) <= 90
          && Number.isFinite(longitude) && Math.abs(longitude) <= 180
          && Number.isFinite(radius) && radius >= 25 && radius <= 50_000;
        if (!sane) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"need a name, a point, and a radius between 25m and 50km"}');
          return;
        }
        // A person's fences are theirs; the shared token's are nobody's, which
        // only admins see. Capped, because every fence is tested against every
        // position and nobody needs fifty.
        const owner = viewer.id;
        if (owner && !viewer.admin && (await geo.countFences(owner)) >= 50) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end('{"error":"fifty fences is the limit"}');
          return;
        }
        const id = await geo.createFence({ name, latitude, longitude, radius, owner })
          .catch((e) => { log.error('fence:', e && e.message ? e.message : e); return null; });
        if (id === null) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"could not create"}');
          return;
        }
        publishFence({ changed: true, owner });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }
      const fences = await geo.listFences(viewer.admin ? {} : { owner: viewer.id }).catch(() => []);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ fences }));
      return;
    }

    if (url.pathname.startsWith('/api/fences/') && req.method === 'DELETE') {
      const id = Number(url.pathname.slice('/api/fences/'.length));
      if (!geo || !geo.enabled() || !Number.isFinite(id)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"no such fence"}');
        return;
      }
      const owner = await geo.fenceOwner(id).catch(() => undefined);
      // Yours, or an admin's call; anybody else's reads as no such fence.
      if (owner === undefined || !(viewer.admin || (owner !== null && owner === viewer.id))) return notFound();
      const gone = await geo.deleteFence(id).catch(() => 0);
      // The watcher holds state per person and fence; leaving it behind would
      // mean a recreated fence inherited somebody's old position.
      onFenceDeleted?.(id);
      publishFence({ changed: true, owner });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: gone }));
      return;
    }

    // ------------------------------------------------------------ circles
    //
    // Only for a person signed in as themselves: the shared token has nobody
    // behind it to be seen, or to see.
    if (url.pathname === '/api/circle' || url.pathname.startsWith('/api/circle/')) {
      if (!circles.enabled || !viewer.id) return notFound();
      const me = viewer.id;

      if (url.pathname === '/api/circle' && req.method === 'GET') {
        return json(200, circles.circleOf(me));
      }
      // A link that lets whoever opens it see you. Made here or with /invite.
      if (url.pathname === '/api/circle/invite' && req.method === 'POST') {
        const link = makeInvite ? await makeInvite(me) : null;
        return link ? json(200, { link }) : json(503, { error: 'invites need the bot' });
      }
      // Taking back what you gave: somebody may no longer see you.
      if (url.pathname.startsWith('/api/circle/viewer/') && req.method === 'DELETE') {
        await revoke(me, decodeURIComponent(url.pathname.slice('/api/circle/viewer/'.length)));
        return json(200, circles.circleOf(me));
      }
      // Giving back what you were given: you stop seeing somebody.
      if (url.pathname.startsWith('/api/circle/owner/') && req.method === 'DELETE') {
        await revoke(decodeURIComponent(url.pathname.slice('/api/circle/owner/'.length)), me);
        return json(200, circles.circleOf(me));
      }
      return notFound();
    }

    if (url.pathname.startsWith('/api/forget/') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/forget/'.length));
      // Erasing is the most final thing here, and until circles it was open
      // to anyone who could load the page. Yourself, or an admin.
      if (!canActFor(viewer, id)) return notFound();
      const erased = await forget(id);
      res.writeHead(erased === null ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(erased === null ? { ok: false, error: 'history not erased' } : { ok: true, erased }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(config.port, config.host, () => {
    log.info(`dashboard on http://${config.host}:${config.port}/?token=…`);
  });

  return {
    server, publish, publishFence, forget, watchers, grant, revoke,
    // Told once the bot has connected, so the login page can name it.
    setBot: (username) => { botName = username || ''; },
  };
}
