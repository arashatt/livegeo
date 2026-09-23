// vector-tiles.js — vector tiles in the OpenMapTiles layout, from somebody
// else's server, proxied and cached on disk the way raster tiles are
// (tiles.js). OpenFreeMap by default, which is free, keyless and covers the
// planet; VECTOR_UPSTREAM=off turns it off.
//
// Two things read them: the district name (district.js), from their `place`
// layer, and the styled map layers (cartography-vector.js), from the rest.
// Either way the browser only ever talks to this service, which is the rule
// for everything the pages load, on networks that filter third parties.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tileUrl } from './tile-path.js';

// The deepest tile an upstream makes; closer zooms are drawn from these.
export const VECTOR_MAX_ZOOM = 14;

// Vector tiles from somebody else's server, cached on disk. `upstream` is
// either a URL template with {z}/{x}/{y}, or a TileJSON address whose "tiles"
// gives the template (OpenFreeMap's changes with every weekly build, so it is
// asked for once a day rather than written down here). 'off' or empty: none.
export function makeVectorUpstream({
  upstream,
  cacheDir,
  userAgent,
  maxAge = 7 * 24 * 3600,
  log = console,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const enabled = Boolean(upstream) && upstream !== 'off';
  let template = enabled && upstream.includes('{z}') ? upstream : null;
  let asked = 0;              // when the TileJSON was last fetched, or tried
  let tries = 0;
  let reading = null;         // the fetch in progress, which every tile waits on

  const fileFor = ({ z, x, y }) => join(cacheDir, String(z), String(x), `${y}.pbf`);

  async function read() {
    try {
      const res = await fetchImpl(upstream, { headers: { 'user-agent': userAgent } });
      if (!res.ok) throw new Error(`tilejson ${res.status}`);
      const json = await res.json();
      const found = Array.isArray(json.tiles) && typeof json.tiles[0] === 'string' ? json.tiles[0] : null;
      if (!found || !found.includes('{z}')) throw new Error('tilejson has no tile template');
      // Only tiles from the host that was configured: a TileJSON that sent
      // this server off to fetch from anywhere else — its own network, say —
      // is not followed.
      const at = new URL(found.replace(/\{[zxy]\}/g, '0'));
      if (!/^https?:$/.test(at.protocol) || at.host !== new URL(upstream).host) {
        throw new Error('tilejson points somewhere other than its own host');
      }
      template = found;
    } catch (e) {
      log.error('tiles: cannot read the vector TileJSON —', e && e.message ? e.message : e);
    }
    return template;
  }

  function resolve() {
    if (upstream.includes('{z}')) return Promise.resolve(template);
    // A day between asks while it answers; a minute while it does not.
    if (template && now() - asked < 86_400_000) return Promise.resolve(template);
    // The tiles of one look arrive together, and all of them wait for the one
    // fetch: none is told there is no template just because it came second.
    if (reading) return reading;
    if (!template && tries && now() - asked < 60_000) return Promise.resolve(null);
    asked = now();
    tries++;
    reading = read().finally(() => { reading = null; });
    return reading;
  }

  async function cached(tile) {
    try {
      const file = fileFor(tile);
      const s = await stat(file);
      return { bytes: await readFile(file), age: (now() - s.mtimeMs) / 1000 };
    } catch {
      return null;
    }
  }

  return {
    enabled,
    async tile(tile) {
      if (!enabled || tile.z > VECTOR_MAX_ZOOM) return null;
      const hit = await cached(tile);
      if (hit && hit.age < maxAge) return { bytes: hit.bytes, from: 'cache' };
      try {
        const url = await resolve();
        if (!url) throw new Error('no tile template');
        // fetch undoes the gzip the upstream sends; plain MVT is stored.
        const res = await fetchImpl(tileUrl(url, tile), { headers: { 'user-agent': userAgent } });
        let bytes;
        if (res.status === 204 || res.status === 404) bytes = Buffer.alloc(0);
        else if (!res.ok) throw new Error(`upstream ${res.status}`);
        else bytes = Buffer.from(await res.arrayBuffer());
        try {
          const file = fileFor(tile);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes);
        } catch (e) {
          log.error('tiles: fetched a vector tile but could not cache it —', e && e.message ? e.message : e);
        }
        return { bytes, from: 'upstream' };
      } catch (e) {
        if (hit) return { bytes: hit.bytes, from: 'stale' };
        log.error('tiles: cannot fetch a vector tile —', e && e.message ? e.message : e);
        return null;
      }
    },
  };
}
