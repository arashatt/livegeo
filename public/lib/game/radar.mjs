// radar.mjs — the minimap: a small round map in the corner, centred on you
// and turned the way you are heading, with everyone else as blips.
//
// A second MapLibre map, flat and not interactive, with a plain style: roads
// and water and nothing to read. It only redraws when you move.
//
// Only people drawn as a point appear on it. Somebody inside a private place
// is an area on the big map and nothing at all here: an arrow pointing at
// them, or a dot on the rim, would say more than the area does.

export function makeRadar({ maplibregl, ml, container, people, buildStyle, palette, enabled, reduced }) {
  const shell = document.createElement('div');
  shell.className = 'gl-radar';
  shell.hidden = true;
  shell.setAttribute('aria-hidden', 'true');
  shell.innerHTML = '<div class="gl-radar-map"></div><div class="gl-radar-blips"></div><i class="gl-radar-me"></i><b class="gl-radar-north">N</b>';
  container.parentNode.appendChild(shell);
  const blipLayer = shell.querySelector('.gl-radar-blips');
  const north = shell.querySelector('.gl-radar-north');
  let map = null;
  let on = enabled;
  let latest = new Set();
  const RANGE_ZOOM = 14.6;

  function ensureMap() {
    if (map) return map;
    map = new maplibregl.Map({
      container: shell.querySelector('.gl-radar-map'),
      style: buildStyle({ palette: palette(), radar: true }),
      interactive: false,
      attributionControl: false,
      center: ml.getCenter(),
      zoom: RANGE_ZOOM,
      fadeDuration: 0,
    });
    map.on('move', draw);
    return map;
  }

  function me(set) {
    for (const b of set) if (b.blip === 'me' && b._map) return b;
    return null;
  }

  function draw() {
    if (!map) return;
    const size = shell.clientWidth;
    const r = size / 2;
    blipLayer.replaceChildren();
    for (const b of latest) {
      if (!b._map || b.blip === 'me') continue;
      const ll = b.getLatLng();
      const p = map.project([ll.lng, ll.lat]);
      let x = p.x - r;
      let y = p.y - r;
      const d = Math.hypot(x, y);
      const edge = d > r - 9;
      // Past the rim, stuck to it in their direction, as a game shows it.
      if (edge) { x = (x / d) * (r - 9); y = (y / d) * (r - 9); }
      const dot = document.createElement('i');
      dot.className = 'gl-radar-blip' + (edge ? ' edge' : '');
      dot.dataset.blip = b.blip;
      dot.style.setProperty('--c', b.options.fillColor || '#40e38f');
      dot.style.transform = `translate(${(x + r).toFixed(1)}px, ${(y + r).toFixed(1)}px)`;
      blipLayer.appendChild(dot);
    }
    north.style.transform = `rotate(${-map.getBearing()}deg) translateY(${-(r - 10)}px) rotate(${map.getBearing()}deg)`;
  }

  function update(set) {
    latest = set || latest;
    const you = me(latest);
    shell.hidden = !on || !you;
    if (shell.hidden) return;
    const m = ensureMap();
    const at = you.getLatLng();
    const heading = people.meHeading;
    m.jumpTo({ center: [at.lng, at.lat], bearing: heading === null || heading === undefined ? 0 : heading, zoom: RANGE_ZOOM });
    if (!reduced) shell.classList.toggle('moving', heading !== null && heading !== undefined);
    draw();
  }

  return {
    update,
    get enabled() { return on; },
    setEnabled(v) { on = v; update(latest); },
    // Called when the light changes, so the minimap keeps the big map's colours.
    restyle() { if (map) map.setStyle(buildStyle({ palette: palette(), radar: true })); },
  };
}
