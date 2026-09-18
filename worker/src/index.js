// index.js — the dashboard's front door on Cloudflare.
//
// The Worker is the browser's only origin. That is not a preference: once the
// page is served over HTTPS from workers.dev, the browser refuses to call an
// HTTP API, and the VPS cannot serve HTTPS without a certificate it has no
// domain to get. So everything the page asks for arrives here, and what this
// file cannot answer itself it passes to the origin.
//
// It holds no state. Positions live in the origin's memory and its PostGIS;
// this only carries them. No Durable Objects, and so no paid plan.
//
//   /vendor/*   Leaflet, from the assets binding
//   /tiles/*    OpenStreetMap, cached at the edge
//   everything  proxied to ORIGIN
//
// With ORIGIN unset the Worker still serves tiles and assets but cannot proxy,
// and says so rather than pretending — the origin is always reachable directly
// and is what this falls back to.

import { parseTilePath, tileUrl } from '../../src/tile-path.js';
import { sameToken, tokenOf } from '../../src/token.js';

const TILE_UPSTREAM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const USER_AGENT = 'livegeo/1.0 (+https://github.com/arashatt/livegeo)';
const TILE_TTL = 30 * 24 * 3600;

const text = (status, body) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// Tiles are gated exactly as they are on the origin, with the same comparison,
// so this does not quietly become an open tile proxy for anyone who finds the
// hostname — which would be both an OpenStreetMap policy problem and a way to
// spend the free tier's daily requests.
function allowed(request, url, env) {
  if (!env.DASHBOARD_TOKEN) return true;   // unset: the origin is the only gate
  return sameToken(tokenOf(request.headers.get('cookie'), url), env.DASHBOARD_TOKEN);
}

async function tile(request, url, tileXYZ, ctx) {
  const cache = caches.default;
  // Keyed on the path alone. The token rides in the query string, and keying
  // on that would give every viewer a private copy of the same public tile —
  // and put a credential into the cache index.
  const key = new Request(new URL(url.pathname, url.origin).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const upstream = await fetch(tileUrl(TILE_UPSTREAM, tileXYZ), {
    headers: { 'user-agent': USER_AGENT },
    cf: { cacheEverything: true, cacheTtl: TILE_TTL },
  });
  if (!upstream.ok) return text(502, 'no tile');

  const res = new Response(upstream.body, upstream);
  res.headers.set('cache-control', `private, max-age=${TILE_TTL}`);
  res.headers.set('x-tile-source', 'upstream');

  // Caching is an optimisation and may fail; the tile has already been
  // fetched and throwing it away over a cache write is the mistake this
  // service made once already on disk.
  try {
    ctx.waitUntil(cache.put(key, res.clone()));
  } catch {
    /* serve it anyway */
  }
  return res;
}

async function proxy(request, url, env) {
  if (!env.ORIGIN) return text(503, 'no origin configured');

  const target = new URL(url.pathname + url.search, env.ORIGIN);
  const headers = new Headers(request.headers);
  // Set by us, never by the caller — otherwise the gate is no gate.
  headers.delete('x-edge-key');
  if (env.EDGE_KEY) headers.set('x-edge-key', env.EDGE_KEY);
  // The origin should see the hostname it is actually serving.
  headers.delete('host');

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });

  // Returned with the body untouched, so /api/stream stays a stream rather
  // than something that arrives all at once when the person stops moving.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/vendor/')) {
      if (!env.ASSETS) return text(404, 'not found');
      // The assets are uploaded from public/vendor, so the prefix is ours to
      // strip; nothing outside that directory is uploaded at all.
      const asset = new URL(url.pathname.slice('/vendor'.length) + url.search, url.origin);
      return env.ASSETS.fetch(new Request(asset, request));
    }

    const xyz = parseTilePath(url.pathname);
    if (xyz) {
      if (!allowed(request, url, env)) return text(401, '401');
      return tile(request, url, xyz, ctx);
    }
    // A path under /tiles/ that is not three integers is not a tile, and is
    // certainly not something to forward to the origin.
    if (url.pathname.startsWith('/tiles/')) return text(404, 'not found');

    return proxy(request, url, env);
  },
};
