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

const MAX_ZOOM = 19;

// The only thing standing between a URL and a filesystem path, so it is
// strict, it is pure, and it is tested: three integers in range, or nothing.
// Digits only means no traversal survives it, encoded or otherwise.
export function parseTilePath(pathname) {
  const m = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(pathname || '');
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (z < 0 || z > MAX_ZOOM) return null;
  // Beyond the edge of the world at this zoom there is no such tile.
  const span = 2 ** z;
  if (x < 0 || x >= span || y < 0 || y >= span) return null;
  return { z, x, y };
}

export function tileUrl(template, { z, x, y }) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

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
        const file = fileFor(tile);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes);
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
