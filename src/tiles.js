// tiles.js — the basemap, served from here rather than from someone else.
//
// The page used to fetch map tiles straight from tile.openstreetmap.org and
// Leaflet itself from a CDN, which means the dashboard only works if the
// browser can reach both. On a network that filters things, that is a map
// that silently stops being a map. Now the browser talks to this service and
// nothing else: Leaflet is vendored under public/vendor, and tiles come
// through here, cached on disk.
//
// That the *server* can reach OpenStreetMap while the *browser* cannot is the
// common case rather than an edge one, and it is the whole point of proxying.
//
// On OSM's tile policy: this is a private dashboard behind a token, tiles are
// cached for a month, and the upstream is configurable — point TILE_UPSTREAM
// at your own renderer if this ever serves more than a handful of people.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tileUrl } from './tile-path.js';

// Re-exported so existing callers keep importing tiles.js, while the Worker
// imports tile-path.js directly.
export { parseTilePath, parseCartoPath, tileUrl } from './tile-path.js';

export function makeTiles({
  cacheDir,
  upstream,
  userAgent,
  maxAge = 30 * 24 * 3600,   // seconds; a basemap changes slowly
  log = console,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const fileFor = ({ z, x, y }) => join(cacheDir, String(z), String(x), `${y}.png`);

  const cached = async (tile) => {
    try {
      const file = fileFor(tile);
      const s = await stat(file);
      return { bytes: await readFile(file), age: (now() - s.mtimeMs) / 1000 };
    } catch {
      return null;
    }
  };

  return {
    // Returns { bytes, from } or null. `from` is only for the response header,
    // but it makes a misbehaving cache obvious from the browser's devtools.
    async get(tile) {
      const hit = await cached(tile);
      if (hit && hit.age < maxAge) return { bytes: hit.bytes, from: 'cache' };

      try {
        const res = await fetchImpl(tileUrl(upstream, tile), {
          // OSM's policy asks that clients identify themselves, and an
          // unidentified proxy is the kind that gets blocked.
          headers: { 'user-agent': userAgent },
        });
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());

        // Caching is an optimisation, and it is allowed to fail. A fresh
        // Docker named volume is owned by root while this runs as `node`, so
        // the first write can be EACCES — and throwing here would discard a
        // tile that had already been fetched, turning slow into blank.
        try {
          const file = fileFor(tile);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes);
        } catch (e) {
          log.error('tiles: fetched but could not cache —', e && e.message ? e.message : e);
        }

        return { bytes, from: 'upstream' };
      } catch (e) {
        // A stale tile is a better map than a grey square, and on the network
        // this service was built for the upstream being unreachable is the
        // expected failure rather than the surprising one.
        if (hit) {
          log.error('tiles: upstream unreachable, serving stale —', e && e.message ? e.message : e);
          return { bytes: hit.bytes, from: 'stale' };
        }
        log.error('tiles: cannot fetch —', e && e.message ? e.message : e);
        return null;
      }
    },
  };
}
