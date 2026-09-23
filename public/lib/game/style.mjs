// style.mjs — what the 3D map looks like: a subtropical coast city seen
// through a game's camera, in three lights.
//
//   night   deep indigo ground, roads glowing hot pink and amber, windows lit
//   golden  the hour either side of sunset: warm light, a pink-orange sky
//   day     sun-bleached pastels and turquoise water
//
// Colours with a meaning are kept out of the ground: no red (red is an SOS)
// and no violet or purple (purple is a place: fences, private places). The
// people drawn on top keep their own colours; these are only the stage.

export const GLYPHS = '/vendor/glyphs/{fontstack}/{range}.pbf';
export const FONT = ['Noto Sans Medium'];
export const FONT_REGULAR = ['Noto Sans Regular'];

const NIGHT = {
  land: '#0e1226', globeLand: '#1c2650', sea: '#050f22', grid: '#2a3a66',
  residential: '#141a35', commercial: '#1a1b3c', industrial: '#131b2c', cemetery: '#10262a',
  grass: '#0f2a2c', wood: '#0b2623', sand: '#262532', rock: '#1b1d2b', park: '#0e3431',
  water: '#073a52', waterEdge: '#20c9dd', waterway: '#1aa6c4',
  casing: '#04050d',
  motorway: '#ff5fb7', trunk: '#ff7fc4', primary: '#ffa64d', secondary: '#ffc978', tertiary: '#d6e2ff',
  minor: '#5d6a9c', service: '#434d7a', path: '#5b6694', rail: '#8a95bd',
  glow: 0.55, glowMinor: 0.12,
  building: '#1f2548', buildingOpacity: 0.92, windows: 1,
  label: '#f4efe6', labelHalo: '#070914', roadLabel: '#b5bfe6',
  raster: { brightness: 0.28, saturation: -0.6, hue: 200, contrast: 0.1 },
  sky: '#070619', horizon: '#3b1f5e', fog: '#141032',
  light: '#9fb2ff', lightIntensity: 0.28,
};

const GOLDEN = {
  land: '#262a40', globeLand: '#39405e', sea: '#1b4d6b', grid: '#5e6488',
  residential: '#2e3048', commercial: '#36324c', industrial: '#2b2e3d', cemetery: '#26383a',
  grass: '#27443c', wood: '#1f3d36', sand: '#4a3a3e', rock: '#3a3240', park: '#1e4f47',
  water: '#1d6d8a', waterEdge: '#7ce7ef', waterway: '#3fb4cc',
  casing: '#1a1020',
  motorway: '#ff6aae', trunk: '#ff86bd', primary: '#ffb35c', secondary: '#ffd28a', tertiary: '#fff1dc',
  minor: '#a18fb0', service: '#7f6f93', path: '#8f7fa3', rail: '#b8a7c4',
  glow: 0.35, glowMinor: 0.06,
  building: '#c9ad92', buildingOpacity: 0.95, windows: 0,
  label: '#fff6ea', labelHalo: '#2a1426', roadLabel: '#ffe6cf',
  raster: { brightness: 0.55, saturation: -0.2, hue: 0, contrast: 0.05 },
  sky: '#f28f5c', horizon: '#ffc67f', fog: '#d97a8e',
  light: '#ffb27a', lightIntensity: 0.55,
};

const DAY = {
  land: '#eadfcd', globeLand: '#eadfcd', sea: '#39c3d4', grid: '#c7b8a2',
  residential: '#e6d6c3', commercial: '#efd2c8', industrial: '#d9d3cd', cemetery: '#cfe0cf',
  grass: '#bfe3b8', wood: '#98cfa6', sand: '#f3e2b8', rock: '#d8d0c4', park: '#a4dcb3',
  water: '#3cc6d6', waterEdge: '#bff4f6', waterway: '#43bfd2',
  casing: '#b9a792',
  motorway: '#ff5d9e', trunk: '#ff7fb2', primary: '#ffac43', secondary: '#ffd27a', tertiary: '#ffffff',
  minor: '#ffffff', service: '#fbf6ee', path: '#b9a58f', rail: '#a3978a',
  glow: 0.12, glowMinor: 0,
  building: '#f4ece1', buildingOpacity: 0.96, windows: 0,
  label: '#2b2436', labelHalo: '#fffaf2', roadLabel: '#5a4e62',
  raster: { brightness: 1, saturation: 0, hue: 0, contrast: 0 },
  sky: '#71cdfa', horizon: '#ffe7c8', fog: '#f4e8da',
  light: '#fff3df', lightIntensity: 0.4,
};

const LIGHTS = [NIGHT, GOLDEN, DAY];

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

function mix(a, b, t) {
  if (typeof a === 'number') return a + (b - a) * t;
  if (typeof a === 'string') return t < 1e-6 ? a : mixHex(a, b, t);
  const out = {};
  for (const k of Object.keys(a)) out[k] = mix(a[k], b[k], t);
  return out;
}

// phase 0 night … 1 golden … 2 day, as sun.mjs gives it.
export function paletteAt(phase) {
  const p = Math.max(0, Math.min(2, phase));
  const i = Math.min(1, Math.floor(p));
  return mix(LIGHTS[i], LIGHTS[i + 1], p - i);
}

// Road classes from lowest to highest: the order they are drawn in.
const RANK = ['path', 'service', 'track', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];

function roadColour(p) {
  return ['match', ['get', 'class'],
    'motorway', p.motorway, 'trunk', p.trunk, 'primary', p.primary, 'secondary', p.secondary,
    'tertiary', p.tertiary, 'service', p.service, 'track', p.service, p.minor];
}

// Line widths by class, at zoom 6 and 18; a ramp is a size down from its
// road. MapLibre allows one zoom curve per expression, so the class is chosen
// inside each end of it rather than around it.
const WIDTHS = {
  motorway: [1.1, 22], trunk: [1, 19], primary: [0.8, 17], secondary: [0.6, 14],
  tertiary: [0.5, 12], minor: [0.3, 9], service: [0.2, 5], track: [0.2, 4],
};
function roadWidth(scale = 1, extra = [0, 0]) {
  const at = (i) => ['*', ['case', ['==', ['get', 'ramp'], 1], 0.6, 1],
    ['match', ['get', 'class'],
      ...Object.entries(WIDTHS).flatMap(([k, v]) => [k, v[i] * scale + extra[i]]),
      0.3 * scale + extra[i]]];
  return ['interpolate', ['exponential', 1.5], ['zoom'], 6, at(0), 18, at(1)];
}

const MAIN = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track'];

// Every paint and layout value that depends on the light, per layer id: used
// to build the style, and again whenever the light changes.
export function paints(p) {
  return {
    background: { 'background-color': p.land },
    'ne-land': { 'fill-color': p.globeLand },
    grid: { 'line-color': p.grid },
    'osm-raster': {
      'raster-brightness-max': p.raster.brightness, 'raster-saturation': p.raster.saturation,
      'raster-hue-rotate': p.raster.hue, 'raster-contrast': p.raster.contrast,
    },
    landcover: {
      'fill-color': ['match', ['get', 'class'], 'wood', p.wood, 'sand', p.sand, 'rock', p.rock, 'ice', p.rock, p.grass],
    },
    landuse: {
      'fill-color': ['match', ['get', 'class'],
        'commercial', p.commercial, 'retail', p.commercial, 'industrial', p.industrial, 'railway', p.industrial,
        'cemetery', p.cemetery, p.residential],
    },
    park: { 'fill-color': p.park },
    water: { 'fill-color': p.water },
    'water-edge': { 'line-color': p.waterEdge },
    waterway: { 'line-color': p.waterway },
    'road-tunnel': { 'line-color': roadColour(p) },
    'road-path': { 'line-color': p.path },
    'road-casing': { 'line-color': p.casing },
    'road-glow': {
      'line-color': roadColour(p),
      'line-opacity': ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], p.glow, p.glowMinor],
    },
    'road-core': { 'line-color': roadColour(p) },
    rail: { 'line-color': p.rail },
    'building-3d': { 'fill-extrusion-color': p.building, 'fill-extrusion-opacity': p.buildingOpacity },
    'road-label': { 'text-color': p.roadLabel, 'text-halo-color': p.labelHalo },
    'place-label': { 'text-color': p.label, 'text-halo-color': p.labelHalo },
  };
}

export function sky(p) {
  return {
    'sky-color': p.sky, 'horizon-color': p.horizon, 'fog-color': p.fog,
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.75, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.6, 9, 0],
  };
}

export function light(p, sun) {
  // From the sun by day; from high and to the south-west at night, like a
  // moon, so buildings still have a lit side.
  const up = sun && sun.altitude > 0;
  return {
    anchor: 'map',
    color: p.light,
    intensity: p.lightIntensity,
    position: up ? [1.3, sun.azimuth, Math.max(12, 90 - sun.altitude)] : [1.3, 210, 35],
  };
}

// A graticule every 15°: the map's grid, faint, gone by city zoom.
export function graticule() {
  const lines = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    const c = [];
    for (let lat = -80; lat <= 80; lat += 5) c.push([lng, lat]);
    lines.push(c);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const c = [];
    for (let lng = -180; lng <= 180; lng += 5) c.push([lng, lat]);
    lines.push(c);
  }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }] };
}

// The whole style. `radar` is the minimap's: flat, no names, no buildings,
// nothing but the streets around you.
export function buildStyle({ palette, sun, radar = false, attribution = '' }) {
  const P = paints(palette);
  const layer = (spec) => ({ ...spec, paint: { ...(spec.paint || {}), ...(P[spec.id] || {}) } });
  const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];
  const sources = {
    vector: {
      type: 'vector',
      tiles: [location.origin + '/vector/{z}/{x}/{y}.pbf'],
      minzoom: 0,
      maxzoom: 14,
      attribution,
    },
  };
  const layers = [
    layer({ id: 'background', type: 'background' }),
  ];
  if (!radar) {
    // Natural Earth is public domain; it is credited in the README.
    sources.world = { type: 'geojson', data: '/vendor/world/land-110m.json' };
    sources.grid = { type: 'geojson', data: graticule() };
    sources.osm = {
      type: 'raster', tiles: [location.origin + '/tiles/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    };
    layers.push(
      layer({ id: 'ne-land', type: 'fill', source: 'world', layout: { visibility: 'none' } }),
      layer({ id: 'osm-raster', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } }),
      layer({
        id: 'grid', type: 'line', source: 'grid', maxzoom: 9,
        paint: { 'line-width': 0.6, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.35, 8, 0] },
      }),
    );
  }
  layers.push(
    layer({ id: 'landcover', type: 'fill', source: 'vector', 'source-layer': 'landcover', paint: { 'fill-opacity': 0.9 } }),
    layer({ id: 'landuse', type: 'fill', source: 'vector', 'source-layer': 'landuse', paint: { 'fill-opacity': 0.8 } }),
    layer({ id: 'park', type: 'fill', source: 'vector', 'source-layer': 'park', paint: { 'fill-opacity': 0.9 } }),
    layer({ id: 'water', type: 'fill', source: 'vector', 'source-layer': 'water', filter: notTunnel }),
    layer({
      id: 'water-edge', type: 'line', source: 'vector', 'source-layer': 'water', minzoom: 9, filter: notTunnel,
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 16, 2.5], 'line-blur': 1.5, 'line-opacity': 0.55 },
    }),
    layer({
      id: 'waterway', type: 'line', source: 'vector', 'source-layer': 'waterway', filter: notTunnel,
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 16, ['match', ['get', 'class'], 'river', 6, 2]] },
    }),
    layer({
      id: 'road-tunnel', type: 'line', source: 'vector', 'source-layer': 'transportation',
      filter: ['all', ['==', ['get', 'brunnel'], 'tunnel'], ['in', ['get', 'class'], ['literal', MAIN]]],
      paint: { 'line-width': roadWidth(0.8), 'line-opacity': 0.35, 'line-dasharray': [1, 1] },
    }),
    layer({
      id: 'road-path', type: 'line', source: 'vector', 'source-layer': 'transportation', minzoom: 14,
      filter: ['all', notTunnel, ['==', ['get', 'class'], 'path']],
      layout: { 'line-cap': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 18, 2], 'line-dasharray': [0.3, 2.2], 'line-opacity': 0.8 },
    }),
    layer({
      id: 'road-casing', type: 'line', source: 'vector', 'source-layer': 'transportation',
      filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', MAIN]]],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['index-of', ['get', 'class'], ['literal', RANK]] },
      paint: { 'line-width': roadWidth(1, [1, 4]), 'line-opacity': 0.9 },
    }),
  );
  if (!radar) {
    layers.push(layer({
      id: 'road-glow', type: 'line', source: 'vector', 'source-layer': 'transportation',
      filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', MAIN]]],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['index-of', ['get', 'class'], ['literal', RANK]] },
      paint: { 'line-width': roadWidth(3.2), 'line-blur': roadWidth(2.4) },
    }));
  }
  layers.push(
    layer({
      id: 'road-core', type: 'line', source: 'vector', 'source-layer': 'transportation',
      filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', MAIN]]],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['index-of', ['get', 'class'], ['literal', RANK]] },
      paint: { 'line-width': roadWidth() },
    }),
    layer({
      id: 'rail', type: 'line', source: 'vector', 'source-layer': 'transportation', minzoom: 10,
      filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', ['rail', 'transit']]]],
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 18, 3], 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
    }),
  );
  if (radar) return { version: 8, sources, layers, glyphs: GLYPHS };

  layers.push(
    layer({
      id: 'building-3d', type: 'fill-extrusion', source: 'vector', 'source-layer': 'building', minzoom: 13,
      paint: {
        // Buildings rise out of the ground as you zoom in, as a game streams them.
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, ['coalesce', ['get', 'render_height'], 6]],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, ['coalesce', ['get', 'render_min_height'], 0]],
        'fill-extrusion-vertical-gradient': true,
      },
    }),
    layer({
      id: 'road-label', type: 'symbol', source: 'vector', 'source-layer': 'transportation_name', minzoom: 14,
      layout: {
        'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
        'text-font': FONT_REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13],
        'text-max-angle': 30, 'text-padding': 8,
      },
      paint: { 'text-halo-width': 1.4, 'text-halo-blur': 0.5 },
    }),
    layer({
      id: 'place-label', type: 'symbol', source: 'vector', 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood', 'country', 'state']]],
      layout: {
        // Local script first, as the place is signposted; then the Latin name
        // in capitals, letter-spaced — which is never done to Persian or
        // Arabic, whose letters join.
        'text-field': ['case',
          ['has', 'name:nonlatin'],
          ['format', ['get', 'name:nonlatin'], {}, '\n', {}, ['upcase', ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], '']], { 'font-scale': 0.72 }],
          ['upcase', ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']]]],
        'text-font': FONT,
        'text-letter-spacing': ['case', ['has', 'name:nonlatin'], 0, 0.14],
        'text-size': ['interpolate', ['linear'], ['zoom'],
          3, ['match', ['get', 'class'], 'country', 12, 'city', 12, 9],
          12, ['match', ['get', 'class'], 'city', 22, 'town', 17, 'village', 14, 'suburb', 14, 'country', 14, 12],
          16, ['match', ['get', 'class'], 'city', 26, 'town', 21, 'suburb', 17, 'quarter', 15, 'neighbourhood', 14, 14]],
        'text-max-width': 9,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 10],
        'text-padding': 6,
      },
      paint: { 'text-halo-width': 1.8, 'text-halo-blur': 0.6 },
    }),
  );
  return {
    version: 8,
    // A globe when zoomed out, flattening into the city as you come in.
    projection: { type: 'globe' },
    sky: sky(palette),
    light: light(palette, sun),
    glyphs: GLYPHS,
    sources,
    layers,
  };
}

// The layers each Layers-panel switch turns on and off.
export const FEATURE_LAYERS = {
  roads: ['road-tunnel', 'road-path', 'road-casing', 'road-glow', 'road-core', 'road-label'],
  rail: ['rail'],
  landuse: ['landuse', 'landcover'],
  parks: ['park'],
  water: ['water', 'water-edge', 'waterway'],
  buildings: ['building-3d'],
};
