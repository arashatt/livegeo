// game-map.mjs — the 3D map: MapLibre with a game's look and camera, and the
// dashboard's own drawing code running on it through leaflet-gl.mjs.
//
// Everything here is presentation. Who may see whom, and how exactly, was
// decided by the server; the page decides what each mark is; this decides
// only how it looks — and never shows anyone more exactly than they were sent.

import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { leafletOnGL } from './leaflet-gl.mjs';
import { peopleOnGL } from './people-gl.mjs';
import { buildStyle, paints, sky, light, paletteAt, FEATURE_LAYERS } from './style.mjs';
import { sunPosition, phaseOf } from './sun.mjs';
import { makeRadar } from './radar.mjs';

const Z = 1; // Leaflet zoom = MapLibre zoom + 1

function pref(key, fallback) {
  try { const v = localStorage.getItem('livegeo.' + key); return v === null ? fallback : v; } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem('livegeo.' + key, value); } catch { /* private mode: not remembered */ }
}

const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · '
  + '<a href="https://www.openmaptiles.org/">OpenMapTiles</a> · <a href="https://openfreemap.org/">OpenFreeMap</a>';

// Lit windows for the night: a small tile of dark wall with some windows on,
// repeated up every building.
function windowsImage() {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#161b38';
  g.fillRect(0, 0, size, size);
  const lit = ['#ffd27a', '#ffe7ad', '#9fe9ff', '#ffb86b'];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 3; y < size; y += 8) {
    for (let x = 3; x < size; x += 7) {
      const on = rnd() < 0.45;
      g.fillStyle = on ? lit[Math.floor(rnd() * lit.length)] : '#232a52';
      g.fillRect(x, y, 3, 4);
    }
  }
  return g.getImageData(0, 0, size, size);
}

function waitForLoad(ml, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the 3D map took too long to start')), ms);
    ml.once('load', () => { clearTimeout(timer); resolve(); });
  });
}

export async function startGame({ container, L: RealL }) {
  const reduced = Boolean(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const narrow = Boolean(window.matchMedia && matchMedia('(max-width: 760px)').matches);

  // ------------------------------------------------------------ light
  let timePref = pref('time', 'auto');
  let fallbackWorld = false;
  let sun = null;
  let lastLitAt = { lng: 999, t: 0 };
  function paletteFor(center) {
    if (timePref === 'auto') {
      sun = sunPosition(new Date(), center.lat, center.lng);
      return { palette: paletteAt(phaseOf(sun.altitude)), phase: phaseOf(sun.altitude) };
    }
    sun = null;
    const phase = { night: 0, golden: 1, day: 2 }[timePref] ?? 0;
    return { palette: paletteAt(phase), phase };
  }
  let { palette } = paletteFor({ lat: 20, lng: 0 });

  const ml = new maplibregl.Map({
    container,
    style: buildStyle({ palette, sun, attribution: ATTRIBUTION }),
    center: [0, 20],
    zoom: 2,
    minZoom: 1,
    maxZoom: 19.5,
    maxPitch: 70,
    // Always shown in full: the OpenStreetMap credit is a condition of the data.
    attributionControl: { compact: false },
    fadeDuration: reduced ? 0 : 200,
    canvasContextAttributes: { antialias: true },
  });
  await waitForLoad(ml, 25000);
  ml.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
  let radarRef = null;

  ml.addImage('windows', windowsImage(), { pixelRatio: 2 });

  // Where the people are drawn: under the names, above the city. Everything
  // here is on the ground and lies flat however the camera tilts.
  const empty = { type: 'FeatureCollection', features: [] };
  ml.addSource('lg-dim', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } },
  });
  for (const id of ['lg-areas', 'lg-lines', 'lg-veils']) ml.addSource(id, { type: 'geojson', data: empty, tolerance: 0.2 });
  ml.addLayer({ id: 'lg-dim', type: 'fill', source: 'lg-dim', paint: { 'fill-color': '#04050d', 'fill-opacity': 0, 'fill-opacity-transition': { duration: reduced ? 0 : 180 } } });
  ml.addLayer({
    id: 'lg-area-fill', type: 'fill', source: 'lg-areas',
    layout: { 'fill-sort-key': ['get', 'z'] },
    paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] },
  });
  ml.addLayer({
    id: 'lg-area-line', type: 'line', source: 'lg-areas',
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] },
  });
  ml.addLayer({
    id: 'lg-lines-dash', type: 'line', source: 'lg-lines', filter: ['==', ['get', 'dashed'], true],
    layout: { 'line-cap': 'butt', 'line-join': 'round', 'line-sort-key': ['get', 'z'] },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'], 'line-dasharray': [2.2, 2.8] },
  });
  ml.addLayer({
    id: 'lg-lines', type: 'line', source: 'lg-lines', filter: ['!=', ['get', 'dashed'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z'] },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'], 'line-blur': ['get', 'blur'] },
  });
  ml.addLayer({
    id: 'lg-veils', type: 'circle', source: 'lg-veils', filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'r0'], 24, ['*', ['get', 'r0'], 16777216]],
      'circle-color': ['get', 'colour'],
      'circle-opacity': ['get', 'alpha'],
      'circle-blur': 1,
      'circle-pitch-alignment': 'map',
      'circle-pitch-scale': 'map',
    },
  });
  ml.addLayer({
    id: 'lg-veil-edge', type: 'line', source: 'lg-veils', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': ['get', 'colour'], 'line-opacity': ['get', 'alpha'], 'line-width': 1.6, 'line-dasharray': [3, 2] },
  });

  function applyLight(force) {
    const c = ml.getCenter();
    const now = Date.now();
    if (!force && timePref === 'auto' && Math.abs(c.lng - lastLitAt.lng) < 8 && now - lastLitAt.t < 5 * 60 * 1000) return;
    lastLitAt = { lng: c.lng, t: now };
    const got = paletteFor(c);
    palette = got.palette;
    const P = paints(palette);
    for (const [id, props] of Object.entries(P)) {
      if (!ml.getLayer(id)) continue;
      for (const [k, v] of Object.entries(props)) ml.setPaintProperty(id, k, v);
    }
    if (fallbackWorld) ml.setPaintProperty('background', 'background-color', palette.sea);
    ml.setSky(sky(palette));
    ml.setLight(light(palette, sun));
    if (ml.getLayer('building-3d')) ml.setPaintProperty('building-3d', 'fill-extrusion-pattern', palette.windows > 0.5 ? 'windows' : undefined);
    const name = got.phase < 0.5 ? 'night' : got.phase < 1.5 ? 'golden' : 'day';
    document.body.dataset.light = name;
    if (radarRef) radarRef.restyle();
    ml.setPaintProperty('lg-dim', 'fill-color', name === 'day' ? '#2b2436' : '#04050d');
  }
  applyLight(true);
  setInterval(() => applyLight(true), 5 * 60 * 1000);
  ml.on('moveend', () => applyLight(false));

  // Without vector tiles at world scale (no upstream, and PostGIS is only
  // asked for cities) the world's land comes from Natural Earth instead.
  fetch('/vector/0/0/0.pbf', { credentials: 'same-origin' }).then((r) => {
    if (r.status === 200) return;
    fallbackWorld = true;
    ml.setLayoutProperty('ne-land', 'visibility', 'visible');
    ml.setPaintProperty('background', 'background-color', palette.sea);
  }).catch(() => {});

  // ------------------------------------------------------------ Leaflet's API
  let people = null;
  const gl = leafletOnGL({ maplibregl, ml, L: RealL, reduced, onBlips: (set) => { radar.update(set); chaseTo(set); } });
  people = peopleOnGL({ gl, ml, L: gl.L, reduced });

  // ------------------------------------------------------------ camera
  // Auto tilts into the city as you zoom in and flattens out to the globe;
  // Map is flat and north-up, like a pause map; Chase rides behind your own
  // blip, heading-up, like a game's driving camera.
  let mode = 'auto';
  let userPitched = false;
  const autoPitch = (z) => (z < 9 ? 0 : z < 13 ? ((z - 9) / 4) * 50 : 50);
  gl.map.decorate = (opts) => {
    if (mode === 'map') return { ...opts, pitch: 0, bearing: 0 };
    if (mode === 'auto' && !userPitched) return { ...opts, pitch: autoPitch(opts.zoom ?? ml.getZoom()) };
    return opts;
  };
  ml.on('pitchstart', (e) => { if (e.originalEvent) userPitched = true; });
  ml.on('zoomend', (e) => {
    if (!e.originalEvent || mode !== 'auto' || userPitched) return;
    const want = autoPitch(ml.getZoom());
    if (Math.abs(want - ml.getPitch()) > 6) ml.easeTo({ pitch: want, duration: reduced ? 0 : 600 });
  });
  ml.on('dragstart', (e) => { if (e.originalEvent && mode === 'chase') setMode('auto'); });

  function meBlip(set) {
    for (const b of set || gl.blips) if (b.blip === 'me' && b._map) return b;
    return null;
  }
  // Called whenever a blip changes, which while you glide is every frame;
  // the camera is re-aimed at most twice a second and eases in between.
  let chasedAt = 0;
  function chaseTo(set, force) {
    const me = meBlip(set);
    hud.canChase(Boolean(me));
    if (mode !== 'chase') return;
    if (!me) { setMode('auto'); return; }
    const now = performance.now();
    if (!force && now - chasedAt < 500) return;
    chasedAt = now;
    const at = me.getLatLng();
    const heading = people.meHeading;
    ml.easeTo({
      center: [at.lng, at.lat], zoom: Math.max(ml.getZoom(), 16.2), pitch: 62,
      bearing: heading === null || heading === undefined ? ml.getBearing() : heading,
      duration: reduced ? 0 : 900,
    });
  }

  function setMode(next) {
    mode = next;
    userPitched = false;
    hud.showMode(mode);
    const d = reduced ? 0 : 900;
    if (mode === 'map') ml.easeTo({ pitch: 0, bearing: 0, duration: d });
    else if (mode === 'auto') ml.easeTo({ pitch: autoPitch(ml.getZoom()), bearing: 0, duration: d });
    else chaseTo(gl.blips, true);
  }

  // ------------------------------------------------------------ spotlight
  // The page dims the map while one person is looked at. Here the ground and
  // the buildings recede; that person's path and blip stay as bright.
  new MutationObserver(() => {
    const on = document.body.classList.contains('spotlight');
    ml.setPaintProperty('lg-dim', 'fill-opacity', on ? (document.body.dataset.light === 'day' ? 0.3 : 0.5) : 0);
    if (ml.getLayer('building-3d')) ml.setPaintProperty('building-3d', 'fill-extrusion-opacity', on ? 0.45 : palette.buildingOpacity);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ------------------------------------------------------------ Layers panel
  const hidden = new Set();
  let detailOn = true;
  function syncFeatures() {
    for (const [name, ids] of Object.entries(FEATURE_LAYERS)) {
      const show = detailOn && !hidden.has(name) && !(name === 'buildings' && pref('buildings', 'on') === 'off');
      for (const id of ids) if (ml.getLayer(id)) ml.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    }
  }
  let statusFn = null;
  function report() {
    if (!statusFn) return;
    if (!detailOn) return statusFn('Map details are off.');
    const seen = ml.queryRenderedFeatures({ layers: ['road-core', 'building-3d', 'water', 'landuse'].filter((id) => ml.getLayer(id)) });
    if (seen.length) return statusFn(fallbackWorld ? 'Street detail in view, from the local map import.' : 'Streets and buildings in view.');
    statusFn(ml.getZoom() < 7 ? 'Zoom in for streets and buildings.' : 'No street detail here.');
  }
  ml.on('idle', report);
  const cartography = {
    setVisible(on) { detailOn = on; syncFeatures(); report(); },
    setFeature(name, on) { if (on) hidden.delete(name); else hidden.add(name); syncFeatures(); report(); },
  };
  syncFeatures();

  // ------------------------------------------------------------ district
  // Where the middle of the view is, the way a game names the district you
  // drive into: from the place names the map already has, no request needed.
  const district = document.createElement('div');
  district.className = 'gl-district';
  district.setAttribute('aria-live', 'polite');
  container.parentNode.appendChild(district);
  let districtTimer = 0;
  let districtName = '';
  const PRIORITY = { neighbourhood: 0, quarter: 0, suburb: 1, village: 2, town: 3, city: 4 };
  ml.on('moveend', () => {
    clearTimeout(districtTimer);
    districtTimer = setTimeout(() => {
      let name = '';
      if (ml.getZoom() >= 11 && ml.getLayer('place-label')) {
        const c = ml.project(ml.getCenter());
        const found = ml.queryRenderedFeatures([[c.x - 220, c.y - 160], [c.x + 220, c.y + 160]], { layers: ['place-label'] })
          .filter((f) => f.properties.class in PRIORITY)
          .map((f) => {
            const p = ml.project(f.geometry.coordinates);
            return { f, score: PRIORITY[f.properties.class] * 1000 + Math.hypot(p.x - c.x, p.y - c.y) };
          })
          .sort((a, b) => a.score - b.score);
        if (found.length) {
          const p = found[0].f.properties;
          name = [p['name:nonlatin'], p['name:latin'] || p.name_en || (p['name:nonlatin'] ? '' : p.name)].filter(Boolean).join('\n');
        }
      }
      if (name === districtName) return;
      districtName = name;
      district.classList.remove('show');
      if (!name) return;
      const [first, second] = name.split('\n');
      district.replaceChildren();
      const a = document.createElement('b');
      a.textContent = first;
      a.dir = 'auto';
      district.appendChild(a);
      if (second) { const b = document.createElement('span'); b.textContent = second; district.appendChild(b); }
      void district.offsetWidth;
      district.classList.add('show');
    }, 350);
  });

  // ------------------------------------------------------------ HUD
  const radar = makeRadar({ maplibregl, ml, container, people, buildStyle, palette: () => palette, enabled: pref('radar', narrow ? 'off' : 'on') === 'on', reduced });
  radarRef = radar;
  const hud = makeHud({ setMode, radar });

  return {
    L: gl.L,
    PeopleMap: { on: () => people, rgba: people.rgba, reduced },
    Cartography: { on: (map, status) => { statusFn = status; report(); return cartography; } },
    ml,
    setTime(value) { timePref = value; setPref('time', value); applyLight(true); },
    setBuildings(on) { setPref('buildings', on ? 'on' : 'off'); syncFeatures(); },
    setRadar(on) { setPref('radar', on ? 'on' : 'off'); radar.setEnabled(on); },
    prefs: () => ({ time: timePref, buildings: pref('buildings', 'on') === 'on', radar: radar.enabled }),
  };

  // The camera buttons and the legend, added to the toolbar the page has.
  function makeHud({ setMode: choose, radar: r }) {
    const bar = document.querySelector('.map-toolbar');
    const group = document.createElement('div');
    group.className = 'gl-camera';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Camera');
    const buttons = {};
    for (const [key, label, title] of [
      ['auto', '3D', 'Tilted city view that flattens out as you zoom out'],
      ['map', 'Map', 'Flat, north up'],
      ['chase', 'Chase', 'Follow yourself, heading up'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = label;
      b.title = title;
      b.dataset.camera = key;
      b.setAttribute('aria-pressed', String(key === 'auto'));
      b.onclick = () => choose(key);
      group.appendChild(b);
      buttons[key] = b;
    }
    buttons.chase.hidden = true;
    // In the toolbar on a wide screen; on a phone, a column of its own under
    // the zoom buttons, so the toolbar stays one row.
    const place = () => {
      if (window.matchMedia && matchMedia('(max-width: 760px)').matches) bar.parentNode.appendChild(group);
      else bar.insertBefore(group, bar.firstChild);
    };
    place();
    if (window.matchMedia) matchMedia('(max-width: 760px)').addEventListener('change', place);
    void r;
    return {
      showMode(m) { for (const [k, b] of Object.entries(buttons)) b.setAttribute('aria-pressed', String(k === m)); },
      canChase(yes) { buttons.chase.hidden = !yes; },
    };
  }
}

export { Z };
