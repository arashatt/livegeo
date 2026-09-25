# Reference-map correction

The first reference was a flat cartographic poster. The preceding dashboard
emphasised steep 3D buildings and lost that composition. This revision starts
in daylight with the flat, north-up Map camera. Pink roads, teal ground,
green parks, cyan water, quieter building footprints, a left title/key and a
right compass restore its map hierarchy. 3D and Chase remain available.

The user clarified that colors, mountains and detail must follow the reference.
The revision now includes stepped green-to-tan elevation tint and hillshade,
lighter blue/periwinkle urban fills, stronger pink road hierarchy and more
original landmark symbols. Purple ground still identifies private places/fences
and red identifies SOS. UI fonts are the existing OFL fonts.

**Mountain relief now uses real elevation.** Global Mapzen Terrarium tiles are
proxied through `/relief/`, authenticated, validated, cached and bounded. The
flat shading preserves the projection of people, trails and privacy areas;
there is no terrain mesh. Layers can switch relief off, and Lite suppresses it.
Hospitals, universities, stations, places of worship, parks and peaks have
original neutral symbols where OSM supplies the corresponding feature.

JPEG previews are omitted from this change at the user’s request. Local visual
verification and its reproduction commands are recorded below.

All captures use **invented fixture geography and people**, not the live site
or production locations. They show styling and layout, not actual OSM coverage.
The regional fixture extends the prior generated grid with rings, connecting
roads, land-cover polygons, landmark symbols and analytical test elevations. No generated fixture data is
loaded by production. Reproduce with `npm ci` then
`CHROMIUM_PATH=/path/to/chrome node bin/demo-reference.mjs`.

The new `world-vector` adapter fills empty local tiles using the already
configured and cached worldwide OpenMapTiles source. It preserves holes and
clipped road geometry, carries heights/names/selected POIs, and respects
independent feature budgets. Requests coalesce, parsed parents are reused,
output variants are bounded and unavailable/corrupt parents back off. Source
zoom 14 supports overzoom to 19. Attribution includes OSM and OpenMapTiles.
Local PostGIS still wins; coverage depends on the source's available features.

MapLibre and its assets now load through `/lib/map-assets/`, an origin alias
confined to `public/vendor/`. This fixes delivery through the existing Worker,
whose separate `/vendor/` asset deployment may contain only the old Leaflet
bundle. No Worker or workflow change is needed.

## Verification

- `npm test`: 648 existing application assertions, 44 Node test cases and the
  real Chromium interaction smoke suite passed locally.
- Browser checks cover the flat default, optional 3D, layers, RTL, privacy,
  SOS confirmation, cards/GPX, placement/Esc, idle repaint, phone legend and
  remembered/failed-GPU Classic fallback. A route fixture makes every old
  `/vendor/` asset except Leaflet unavailable, proving the new alias loads.
- Binary MVT tests decode actual adapter output: parent/child placement,
  holes, bridges, labels, POIs, height limits, budgets, caching, recovery,
  authenticated HTTP fallback and local-data preference.
- Screenshots were inspected at 1440 × 900 and 390 × 844. The capture reported
  no console errors or outside requests; every JPEG is under 250 KB. See
  [checks.json](checks.json).
- Local PostGIS is unavailable; the existing branch CI runs the disposable
  PostGIS suite before merging. Existing live/share drawing files, auth,
  bot/watch code and CI/Deploy definitions are unchanged.

The [earlier screenshots](../game-map/README.md) remain as historical evidence
of the 3D-focused version, not the default appearance of this revision.

## Real elevation check

A separate local check near Mashhad rendered **real Mapzen/USGS elevation**, without live people or invented streets. The road map
provider was unavailable from this workspace, so this capture checks terrain
rather than claiming a complete real-city OSM screenshot. See
[relief-checks.json](relief-checks.json) for coordinates and request counts.
Reproduce with `TERRAIN_DEMO_CACHE=/path/to/cache node bin/demo-relief.mjs`.
The local fixture atlas tests the complete UI offline; production uses OSM
geometry and the actual elevation for the viewed location, worldwide.

Sources: [AWS Terrain Tiles registry](https://registry.opendata.aws/terrain-tiles/),
[Terrarium format](https://github.com/tilezen/joerd/blob/master/docs/formats.md),
and [provider credits](https://github.com/tilezen/joerd/blob/master/docs/attribution.md),
checked 25 September 2026. Credits are also available from the map itself.
