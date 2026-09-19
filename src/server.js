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
import { randomBytes } from 'node:crypto';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PAGE = resolve(PUBLIC, 'index.html');
const SHARE_PAGE = resolve(PUBLIC, 'share.html');

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
export function staticFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  const file = resolve(PUBLIC, '.' + (rel.startsWith('/') ? rel : `/${rel}`));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return null;
  const type = STATIC_TYPES[extname(file).toLowerCase()];
  return type ? { file, type } : null;
}

export function serve(positions, config, { log = console, directory = null, geo = null } = {}) {
  const watchers = new Set();

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

  // Called whenever a position changes; every open map hears about it at once,
  // which is the whole point of doing this over MTProto rather than polling.
  const publish = (person) => {
    const payload = { ...person, live: Boolean(person.liveUntil && person.liveUntil > Date.now() / 1000) };
    for (const res of watchers) {
      try { send(res, 'position', payload); } catch { watchers.delete(res); }
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ok = sameToken(tokenOf(req.headers.cookie, url), config.dashboardToken);

    const deny = () => {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('401 — append ?token=… to the URL');
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

    // Leaflet is a public library and a share page needs it, so it is not
    // behind the dashboard token. It carries no data.
    if (url.pathname.startsWith('/vendor/')) return serveStatic(url, res);

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
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Remembered so the token is not needed in every later request, and
        // so it stops being visible in the address bar after the first load.
        'set-cookie': `${COOKIE}=${encodeURIComponent(config.dashboardToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/positions') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ people: positions.list() }));
      return;
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
      watchers.add(res);
      send(res, 'hello', { people: positions.list() });
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
      const points = geo ? await geo.historyOf(id, { limit: 1000 }) : [];
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ id, points }));
      return;
    }

    // Hand one person's path to somebody who does not have the dashboard.
    if (url.pathname.startsWith('/api/share/') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/share/'.length));
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
      const gone = geo ? await geo.revokeShare(token) : 0;
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

    if (url.pathname.startsWith('/api/forget/') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/forget/'.length));
      positions.forget(id);
      // Forgetting has to mean forgetting. History is kept indefinitely, so
      // the one button that removes a person must clear the record too, not
      // just take them off the map until the next update arrives.
      const erased = geo ? await geo.forget(id).catch((e) => {
        log.error('geo: erasure failed —', e && e.message ? e.message : e);
        return null;
      }) : 0;
      for (const w of watchers) { try { send(w, 'forget', { id }); } catch { watchers.delete(w); } }
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

  return { server, publish, watchers };
}
