// Feature styling for the local OSM extract. Raster tiles remain underneath
// for worldwide coverage and labels; no city coordinates belong in this file.
export const CARTOGRAPHY_LAYERS = Object.freeze(['landuse', 'parks', 'water', 'buildings', 'rail', 'roads']);
export const CARTOGRAPHY_MIN_ZOOM = 8;
export const EMPTY_CARTOGRAPHY = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"/>';

// null means the default; an empty string means the viewer turned every
// feature off. Unknown names are rejected, never interpolated into SQL/SVG.
export function parseCartographyLayers(value) {
  if (value === null || value === undefined) return [...CARTOGRAPHY_LAYERS];
  if (value === '') return [];
  if (typeof value !== 'string' || value.length > 100) return null;
  const names = value.split(',');
  if (names.some((name) => !CARTOGRAPHY_LAYERS.includes(name))) return null;
  return CARTOGRAPHY_LAYERS.filter((name) => names.includes(name));
}

// Separate budgets keep dense buildings from consuming the roads' allowance.
// Select using a buffered envelope as well as clipping with a buffer: a wide
// road just beyond an edge still needs to paint into this tile.
export const CARTOGRAPHY_SQL = `
WITH tile AS (SELECT ST_TileEnvelope($1, $2, $3) AS geom),
bounds AS (
  SELECT geom, ST_Expand(geom, (ST_XMax(geom) - ST_XMin(geom)) * 12 / 256) AS buffered,
         (ST_XMax(geom) - ST_XMin(geom)) / 256 AS pixel
  FROM tile
), features AS (
  (SELECT 'landuse' AS layer,
          CASE WHEN "natural" IN ('bare_rock','scree','shingle','sand') THEN 'terrain' ELSE 'urban' END AS subtype,
          way, 3 AS dimension
     FROM planet_osm_polygon, bounds
    WHERE $1 >= 10 AND way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 4
      AND (landuse IN ('residential','commercial','industrial','retail')
           OR "natural" IN ('bare_rock','scree','shingle','sand'))
    ORDER BY way_area DESC, osm_id LIMIT 350)
  UNION ALL
  (SELECT 'parks', '', way, 3
     FROM planet_osm_polygon, bounds
    WHERE way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 4
      AND (leisure IN ('park','garden','nature_reserve','golf_course')
           OR landuse IN ('forest','grass','meadow','recreation_ground','village_green')
           OR "natural" IN ('wood','scrub','heath'))
    ORDER BY way_area DESC, osm_id LIMIT 500)
  UNION ALL
  (SELECT 'water', 'area', way, 3
     FROM planet_osm_polygon, bounds
    WHERE way && bounds.buffered AND way_area > bounds.pixel * bounds.pixel * 2
      AND ("natural" = 'water' OR landuse IN ('reservoir','basin') OR waterway = 'riverbank')
    ORDER BY way_area DESC, osm_id LIMIT 400)
  UNION ALL
  (SELECT 'water', waterway, way, 2
     FROM planet_osm_line, bounds
    WHERE $1 >= 11 AND way && bounds.buffered
      AND (waterway IN ('river','canal') OR ($1 >= 14 AND waterway IN ('stream','drain')))
    ORDER BY osm_id LIMIT 500)
  UNION ALL
  (SELECT 'buildings', '', way, 3
     FROM planet_osm_polygon, bounds
    WHERE $1 >= 15 AND way && bounds.buffered AND building IS NOT NULL AND building <> 'no'
    ORDER BY way_area DESC, osm_id LIMIT 1800)
  UNION ALL
  (SELECT 'rail', railway, way, 2
     FROM planet_osm_line, bounds
    WHERE $1 >= 11 AND way && bounds.buffered AND railway IN ('rail','light_rail','tram')
    ORDER BY osm_id LIMIT 400)
  UNION ALL
  (SELECT 'roads', highway, way, 2
     FROM planet_osm_line, bounds
    WHERE way && bounds.buffered AND (
      highway IN ('motorway','motorway_link','trunk','trunk_link')
      OR ($1 >= 10 AND highway IN ('primary','primary_link','secondary','secondary_link'))
      OR ($1 >= 12 AND highway IN ('tertiary','tertiary_link','residential','unclassified','living_street'))
      OR ($1 >= 14 AND highway = 'service')
      OR ($1 >= 15 AND highway IN ('pedestrian','track','path','footway','cycleway','steps')))
    ORDER BY CASE WHEN highway IN ('motorway','motorway_link','trunk','trunk_link') THEN 0
                  WHEN highway IN ('primary','primary_link') THEN 1
                  WHEN highway IN ('secondary','secondary_link') THEN 2 ELSE 3 END, osm_id
    LIMIT 2400)
), clipped AS (
  SELECT layer, subtype,
         ST_CollectionExtract(ST_AsMVTGeom(way, bounds.geom, 256, 12, true), dimension) AS geom
  FROM features, bounds
)
SELECT layer, subtype, ST_AsSVG(geom, 0, 1) AS d
FROM clipped WHERE NOT ST_IsEmpty(geom)`;

const escape = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function roadStyle(kind, zoom) {
  const link = kind.endsWith('_link');
  const road = kind.replace(/_link$/, '');
  const scale = zoom < 11 ? .55 : zoom < 14 ? .8 : zoom >= 17 ? 1.35 : 1;
  const styles = {
    motorway: ['#ec64ac', 3.6, 5], trunk: ['#e879b4', 3.3, 5],
    primary: ['#f2b2ca', 2.8, 4], secondary: ['#dba6bd', 2.3, 3],
    tertiary: ['#aca1b8', 1.7, 2],
  };
  const [color, width, rank] = styles[road] || ['#8da3b2', 1, 1];
  return { color, width: width * scale * (link ? .65 : 1), rank,
    path: ['pedestrian','track','path','footway','cycleway','steps'].includes(road) };
}

export function renderCartography(rows, zoom, layers = CARTOGRAPHY_LAYERS) {
  const groups = Object.fromEntries(CARTOGRAPHY_LAYERS.map((name) => [name, []]));
  const roads = [];
  for (const row of rows) {
    if (!row.d || !groups[row.layer] || !layers.includes(row.layer)) continue;
    const d = escape(row.d);
    let style;
    switch (row.layer) {
      case 'landuse': style = row.subtype === 'terrain'
        ? 'fill="#b79b78" fill-opacity=".34"' : 'fill="#8778a9" fill-opacity=".28"'; break;
      case 'parks': style = 'fill="#4b967e" fill-opacity=".52" stroke="#6eac91" stroke-opacity=".35" stroke-width=".5"'; break;
      case 'water': style = row.subtype === 'area'
        ? 'fill="#1caaca" fill-opacity=".74" stroke="#71d4df" stroke-opacity=".65" stroke-width=".7"'
        : 'fill="none" stroke="#37b6ce" stroke-opacity=".85" stroke-width="1.3"'; break;
      case 'buildings': style = 'fill="#73758f" fill-opacity=".65" stroke="#a0a2b7" stroke-opacity=".4" stroke-width=".45"'; break;
      case 'rail': style = 'fill="none" stroke="#c4c2d4" stroke-opacity=".8" stroke-width="1.1" stroke-dasharray="3 3"'; break;
      case 'roads': roads.push({ d, ...roadStyle(row.subtype || '', zoom) }); continue;
    }
    groups[row.layer].push(`<path d="${d}" ${style} fill-rule="evenodd"/>`);
  }
  // Paint a class's casing before its centres, so joins remain continuous.
  // Minor streets go first; an arterial road never vanishes below them.
  for (const rank of [1, 2, 3, 4, 5]) {
    const same = roads.filter((road) => road.rank === rank);
    for (const road of same.filter((road) => !road.path)) {
      groups.roads.push(`<path d="${road.d}" fill="none" stroke="#233343" stroke-opacity=".85" stroke-width="${(road.width + .9).toFixed(2)}"/>`);
    }
    for (const road of same) {
      groups.roads.push(`<path d="${road.d}" fill="none" stroke="${road.color}" stroke-opacity="${road.path ? '.65' : '.95'}" stroke-width="${road.width.toFixed(2)}"${road.path ? ' stroke-dasharray="2 3"' : ''}/>`);
    }
  }
  const body = CARTOGRAPHY_LAYERS.filter((name) => groups[name].length)
    .map((name) => `<g data-layer="${name}">${groups[name].join('')}</g>`).join('');
  if (!body) return null;
  // MVT is already Y-down. ST_AsSVG negates Y again, so reflect it once to
  // restore its position. Without this, almost every feature is above the tile.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><g transform="scale(1,-1)" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
}

export function makeCartography({ query, log = console, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  let retryAfter = 0;
  return {
    async tile(z, x, y, layers = CARTOGRAPHY_LAYERS) {
      if (![z, x, y].every(Number.isInteger) || z < CARTOGRAPHY_MIN_ZOOM || z > 19
          || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z || !layers.length || now() < retryAfter) return null;
      const key = `${z}/${x}/${y}`;
      const hit = cache.get(key);
      let rows = hit && hit.until > now() ? hit.rows : null;
      try {
        if (!rows) {
          if (!pending.has(key)) {
            const request = Promise.resolve().then(() => query(CARTOGRAPHY_SQL, [z, x, y]))
              .then(({ rows: found }) => {
                // Cache geometry once, rather than every checkbox combination.
                if (cache.size >= 128) cache.delete(cache.keys().next().value);
                cache.set(key, { rows: found, until: now() + (found.length ? 300_000 : 30_000) });
                return found;
              }).finally(() => pending.delete(key));
            pending.set(key, request);
          }
          rows = await pending.get(key);
        }
        return renderCartography(rows, z, layers);
      } catch (error) {
        // Missing imports are normal, but retry so installing an extract does
        // not require an application restart. Transient failures are retried too.
        retryAfter = now() + (error?.code === '42P01' ? 60_000 : 5_000);
        log.error('geo: cannot render cartography —', error?.message || error);
        return null;
      }
    },
  };
}
