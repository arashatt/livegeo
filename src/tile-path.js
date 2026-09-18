// tile-path.js — turning a URL into three integers, and nothing else.
//
// Split out from tiles.js so the Cloudflare Worker can import it: that file
// reaches for node:fs, which a Worker cannot load. This one imports nothing,
// deliberately, and both the origin and the edge use it.
//
// Sharing it rather than copying it is the whole point. It is what stands
// between a request path and a filesystem path, and two implementations of a
// security boundary are one implementation and one liability.

const MAX_ZOOM = 19;

// Three integers in range, or nothing. Digits only, so no traversal survives
// it — encoded or otherwise.
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
