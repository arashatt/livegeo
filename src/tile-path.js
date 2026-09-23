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

function parse(pathname, re) {
  const m = re.exec(pathname || '');
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

// Three integers in range, or nothing. Digits only, so no traversal survives
// it — encoded or otherwise.
export function parseTilePath(pathname) {
  return parse(pathname, /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
}

// The styled cartography overlay is an SVG tile made from the local OSM
// extract in PostGIS. It shares the same range checks as raster tiles.
export function parseCartoPath(pathname) {
  return parse(pathname, /^\/carto\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.svg$/);
}

export function tileUrl(template, { z, x, y }) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
