// leaflet-gl.mjs — the slice of Leaflet the dashboard uses, drawn by MapLibre.
//
// The dashboard's own code (public/index.html) was written against Leaflet
// and stays that way: it runs unchanged on real Leaflet for the classic map,
// and on this for the 3D one. Everything it draws keeps its meaning because
// it is the same code deciding what to draw — only how is different here.
//
//   dots, names, chips, labels, the time tip   → HTML markers, above the 3D
//                                                buildings, so nothing about a
//                                                person is ever hidden behind one
//   paths, halos, fences                        → GeoJSON on the ground
//
// Geometry (L.latLng, bounds, points) and DomEvent are real Leaflet's, which
// is loaded for the fallback anyway. Zoom numbers are Leaflet's too: MapLibre
// tiles are 512 px, so its zoom is one less for the same scale.

const Z = 1;

export function leafletOnGL({ maplibregl, ml, L: RealL, reduced = false, onBlips = null }) {
  const lngLat = (ll) => { const p = RealL.latLng(ll); return [p.lng, p.lat]; };
  let lids = 0;
  let zTop = 0;
  let zBottom = 0;

  // ------------------------------------------------------------ events
  class Evented {
    on(types, fn) {
      this._h = this._h || {};
      String(types).split(/\s+/).forEach((t) => { (this._h[t] = this._h[t] || []).push(fn); });
      return this;
    }
    off(types, fn) {
      String(types).split(/\s+/).forEach((t) => {
        if (this._h && this._h[t]) this._h[t] = fn ? this._h[t].filter((f) => f !== fn) : [];
      });
      return this;
    }
    fire(type, e) {
      const list = this._h && this._h[type];
      if (list) list.slice().forEach((fn) => fn.call(this, e));
      return this;
    }
    listens(type) { return Boolean(this._h && this._h[type] && this._h[type].length); }
  }

  class Layer extends Evented {
    addTo(map) { map.addLayer(this); return this; }
    remove() { if (this._map) this._map.removeLayer(this); return this; }
    onAdd() {}
    onRemove() {}
  }

  // ------------------------------------------------------------ vector stores
  // One GeoJSON source per kind of thing on the ground, redrawn at most once
  // a frame however many layers changed in it.
  class Store {
    constructor(source) {
      this.source = source;
      this.layers = new Map();
      this.frame = 0;
    }
    put(layer) { this.layers.set(layer.lid, layer); this.dirty(); }
    drop(layer) { this.layers.delete(layer.lid); this.dirty(); }
    dirty() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const features = [];
        for (const layer of this.layers.values()) features.push(...layer.features());
        const src = ml.getSource(this.source);
        if (src) src.setData({ type: 'FeatureCollection', features });
      });
    }
    get(lid) { return this.layers.get(lid); }
  }
  const stores = { areas: new Store('lg-areas'), lines: new Store('lg-lines'), veils: new Store('lg-veils') };

  // ------------------------------------------------------------ the map
  class GLMap extends Evented {
    constructor() {
      super();
      this.ml = ml;
      this._layers = new Set();
      this._moved = false;
      // Given by the game map: adds the camera's tilt and heading to a move.
      this.decorate = (opts) => opts;
      const wrap = (e) => ({
        latlng: e.lngLat ? RealL.latLng(e.lngLat.lat, e.lngLat.lng) : null,
        containerPoint: e.point ? RealL.point(e.point.x, e.point.y) : null,
        originalEvent: e.originalEvent,
        target: this,
      });
      ml.on('click', (e) => {
        const ev = wrap(e);
        if (ev.originalEvent && ev.originalEvent._stopped) return;
        // A shape on the ground hears it first, as in Leaflet; a handler there
        // can keep it from the map.
        const ids = ['lg-area-fill'].filter((id) => ml.getLayer(id));
        const hits = ids.length ? ml.queryRenderedFeatures(e.point, { layers: ids }) : [];
        for (const f of hits) {
          const layer = stores.areas.get(f.properties.lid);
          if (!layer || layer.options.interactive === false || !layer.listens('click')) continue;
          layer.fire('click', { ...ev, target: layer });
          break;
        }
        if (ev.originalEvent && ev.originalEvent._stopped) return;
        this.fire('click', ev);
      });
      ml.on('mousemove', (e) => this.fire('mousemove', wrap(e)));
      ml.on('mouseout', (e) => {
        // Onto a dot or a name is still over the map.
        const to = e.originalEvent && e.originalEvent.relatedTarget;
        if (to && ml.getContainer().contains(to)) return;
        this.fire('mouseout', wrap(e));
      });
      ml.on('zoomend', () => this.fire('zoomend'));
      ml.on('moveend', () => this.fire('moveend'));
      ml.on('resize', () => this.fire('resize'));
    }

    addLayer(layer) {
      if (!layer || layer._map === this) return this;
      layer._map = this;
      this._layers.add(layer);
      layer.onAdd(this);
      return this;
    }
    removeLayer(layer) {
      if (!layer || layer._map !== this) return this;
      layer.onRemove(this);
      this._layers.delete(layer);
      layer._map = null;
      return this;
    }
    hasLayer(layer) { return Boolean(layer) && layer._map === this; }
    eachLayer(fn) { [...this._layers].forEach(fn); return this; }

    setView(center, zoom, opts) {
      const target = this.decorate({
        center: lngLat(center),
        zoom: zoom === undefined || zoom === null ? ml.getZoom() : zoom - Z,
      });
      if (!this._moved || reduced || (opts && opts.animate === false)) ml.jumpTo(target);
      else ml.flyTo({ ...target, duration: 1400, essential: false });
      this._moved = true;
      return this;
    }
    fitBounds(bounds, opts) {
      const b = RealL.latLngBounds(bounds);
      if (!b.isValid()) return this;
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const box = [[sw.lng, sw.lat], [ne.lng, ne.lat]];
      const pad = Math.round(Math.min(ml.getContainer().clientWidth, ml.getContainer().clientHeight) * 0.08) + 24;
      const camera = ml.cameraForBounds(box, { padding: pad, maxZoom: ((opts && opts.maxZoom) || 17) - Z, bearing: ml.getBearing() });
      if (!camera) return this;
      const target = this.decorate({ center: camera.center, zoom: camera.zoom });
      if (!this._moved || reduced) ml.jumpTo(target);
      else ml.flyTo({ ...target, duration: 1400, essential: false });
      this._moved = true;
      return this;
    }
    getZoom() { return ml.getZoom() + Z; }
    getCenter() { const c = ml.getCenter(); return RealL.latLng(c.lat, c.lng); }
    getSize() { const c = ml.getContainer(); return RealL.point(c.clientWidth, c.clientHeight); }
    latLngToContainerPoint(ll) { const p = ml.project(lngLat(ll)); return RealL.point(p.x, p.y); }
    containerPointToLatLng(pt) { const p = RealL.point(pt); const ll = ml.unproject([p.x, p.y]); return RealL.latLng(ll.lat, ll.lng); }
    invalidateSize() { ml.resize(); return this; }
    createPane(name) { return this.getPane(name); }
    getPane(name) { this._panes = this._panes || {}; return (this._panes[name] = this._panes[name] || document.createElement('div')); }
  }

  // ------------------------------------------------------------ HTML markers
  // What Leaflet puts in its marker pane. The wrapper is MapLibre's to move;
  // the element inside is what Leaflet would call getElement().
  class Marker extends Layer {
    constructor(latlng, options = {}) {
      super();
      this.options = { interactive: true, keyboard: true, ...options };
      this._latlng = RealL.latLng(latlng);
      this._wrap = document.createElement('div');
      this._wrap.className = 'gl-marker';
      this._build();
      if (this.options.interactive === false) this._wrap.style.pointerEvents = 'none';
      const fire = (type) => (domEvent) => {
        this.fire(type, { originalEvent: domEvent, latlng: this._latlng, target: this });
        if (type === 'click' && domEvent._stopped) domEvent.stopPropagation();
      };
      this._wrap.addEventListener('mouseenter', fire('mouseover'));
      this._wrap.addEventListener('mouseleave', fire('mouseout'));
      this._wrap.addEventListener('click', fire('click'));
    }
    _build() {
      const icon = (this.options.icon && this.options.icon.options) || {};
      const el = document.createElement('div');
      el.className = ('gl-icon ' + (icon.className || '')).trim();
      if (icon.html) el.innerHTML = icon.html;
      const size = RealL.point(icon.iconSize || [0, 0]);
      const anchor = icon.iconAnchor ? RealL.point(icon.iconAnchor) : size.divideBy(2);
      el.style.width = size.x + 'px';
      el.style.height = size.y + 'px';
      this._wrap.replaceChildren(el);
      this._el = el;
      this._offset = [-anchor.x, -anchor.y];
    }
    onAdd() {
      this._mk = new maplibregl.Marker({ element: this._wrap, anchor: 'top-left', offset: this._offset, subpixelPositioning: true })
        .setLngLat(lngLat(this._latlng)).addTo(ml);
    }
    onRemove() { if (this._mk) this._mk.remove(); this._mk = null; }
    setLatLng(ll) { this._latlng = RealL.latLng(ll); if (this._mk) this._mk.setLngLat(lngLat(this._latlng)); this.fire('move'); return this; }
    getLatLng() { return this._latlng; }
    getElement() { return this._el; }
    setOpacity(o) { this._wrap.style.opacity = String(o); return this; }
    setIcon(icon) { this.options.icon = icon; this._build(); return this; }
    setZIndexOffset(z) { this._wrap.style.zIndex = String(z); return this; }
  }

  // A dot is a blip: a button, so it can be reached from the keyboard, with
  // its name as a tag that shows on hover and focus. What kind of blip (you,
  // live, not live, SOS) comes from the page as `blip`; Leaflet ignores it.
  const blips = new Set();
  let blipFrame = 0;
  const blipsChanged = () => {
    if (!onBlips || blipFrame) return;
    blipFrame = requestAnimationFrame(() => { blipFrame = 0; onBlips(blips); });
  };
  class CircleMarker extends Layer {
    constructor(latlng, options = {}) {
      super();
      this.options = { radius: 10, fillOpacity: 1, opacity: 1, ...options };
      this._latlng = RealL.latLng(latlng);
      const b = this._wrap = document.createElement('button');
      b.type = 'button';
      b.className = 'gl-blip';
      b.innerHTML = '<span class="gl-blip-dot"></span><span class="gl-blip-tag" dir="auto"></span>';
      this._tag = b.lastChild;
      const fire = (type) => (domEvent) => {
        this.fire(type, { originalEvent: domEvent, latlng: this._latlng, target: this });
        if (type === 'click' && domEvent._stopped) domEvent.stopPropagation();
      };
      b.addEventListener('mouseenter', fire('mouseover'));
      b.addEventListener('mouseleave', fire('mouseout'));
      b.addEventListener('focus', fire('mouseover'));
      b.addEventListener('blur', fire('mouseout'));
      b.addEventListener('click', fire('click'));
      this._paint();
    }
    _paint() {
      const o = this.options;
      const b = this._wrap;
      b.style.setProperty('--c', o.fillColor || o.color || '#40e38f');
      b.style.setProperty('--r', (o.radius || 7) + 'px');
      b.style.opacity = String(Math.min(o.opacity === undefined ? 1 : o.opacity, o.fillOpacity === undefined ? 1 : o.fillOpacity));
      b.dataset.blip = o.blip || 'live';
    }
    onAdd() {
      this._mk = new maplibregl.Marker({ element: this._wrap, anchor: 'center', subpixelPositioning: true })
        .setLngLat(lngLat(this._latlng)).addTo(ml);
      blips.add(this);
      blipsChanged();
    }
    onRemove() { if (this._mk) this._mk.remove(); this._mk = null; blips.delete(this); blipsChanged(); }
    setStyle(s) { Object.assign(this.options, s); this._paint(); blipsChanged(); return this; }
    setRadius(r) { this.options.radius = r; this._paint(); return this; }
    setLatLng(ll) { this._latlng = RealL.latLng(ll); if (this._mk) this._mk.setLngLat(lngLat(this._latlng)); blipsChanged(); this.fire('move'); return this; }
    getLatLng() { return this._latlng; }
    bindTooltip(html) { return this.setTooltipContent(html); }
    setTooltipContent(html) {
      // HTML, as Leaflet takes it: the page escapes what people typed.
      this._tag.innerHTML = html;
      this._wrap.setAttribute('aria-label', this._tag.textContent);
      return this;
    }
    bringToFront() { this._wrap.style.zIndex = '30'; return this; }
    bringToBack() { this._wrap.style.zIndex = ''; return this; }
    getElement() { return this._wrap; }
    get blip() { return this.options.blip || 'live'; }
  }

  // A label pinned to a point: the time under the pointer, a fence's name.
  class Tooltip extends Layer {
    constructor(options = {}) {
      super();
      this.options = { direction: 'top', offset: [0, 0], ...options };
      this._latlng = null;
      this._wrap = document.createElement('div');
      this._wrap.className = 'gl-marker gl-tooltip-wrap';
      this._wrap.style.pointerEvents = 'none';
      this._el = document.createElement('div');
      this._el.className = ('leaflet-tooltip gl-tooltip gl-tooltip-' + this.options.direction + ' ' + (this.options.className || '')).trim();
      this._wrap.appendChild(this._el);
    }
    setLatLng(ll) { this._latlng = RealL.latLng(ll); if (this._mk) this._mk.setLngLat(lngLat(this._latlng)); return this; }
    getLatLng() { return this._latlng; }
    setContent(html) { this._el.innerHTML = html; return this; }
    getElement() { return this._el; }
    onAdd() {
      const off = RealL.point(this.options.offset || [0, 0]);
      this._mk = new maplibregl.Marker({
        element: this._wrap,
        anchor: this.options.direction === 'top' ? 'bottom' : 'center',
        offset: [off.x, off.y - (this.options.direction === 'top' ? 6 : 0)],
      }).setLngLat(lngLat(this._latlng || [0, 0])).addTo(ml);
    }
    onRemove() { if (this._mk) this._mk.remove(); this._mk = null; }
  }

  // ------------------------------------------------------------ ground shapes
  const flat = (latlngs) => {
    // Leaflet takes a line, or a list of lines; either way, lines of LatLngs.
    if (!latlngs || !latlngs.length) return [];
    const first = latlngs[0];
    const isPoint = (v) => v && (typeof v.lat === 'number' || (Array.isArray(v) && typeof v[0] === 'number'));
    const lines = isPoint(first) ? [latlngs] : latlngs;
    return lines.map((line) => line.map((p) => RealL.latLng(p)));
  };

  class Path extends Layer {
    constructor(options) {
      super();
      this.lid = ++lids;
      this.z = 0;
      this.options = { color: '#3388ff', weight: 3, opacity: 1, fill: false, fillOpacity: 0.2, interactive: true, ...options };
    }
    get store() { return stores.lines; }
    onAdd() { this.store.put(this); if (this._label) this._label.addTo(this._map); }
    onRemove() { this.store.drop(this); if (this._label) this._label.remove(); }
    setStyle(s) { Object.assign(this.options, s); if (this._map) this.store.dirty(); return this; }
    bringToFront() { this.z = ++zTop; if (this._map) this.store.dirty(); return this; }
    bringToBack() { this.z = --zBottom; if (this._map) this.store.dirty(); return this; }
    redraw() { if (this._map) this.store.dirty(); return this; }
  }

  class Polyline extends Path {
    constructor(latlngs, options) { super(options); this._lines = flat(latlngs); }
    setLatLngs(latlngs) { this._lines = flat(latlngs); return this.redraw(); }
    getLatLngs() { return this._lines.length === 1 ? this._lines[0] : this._lines; }
    getBounds() { return RealL.latLngBounds([].concat(...this._lines)); }
    features() {
      const o = this.options;
      const lines = this._lines.filter((l) => l.length > 1).map((l) => l.map((p) => [p.lng, p.lat]));
      if (!lines.length) return [];
      const glow = o.weight >= 10;
      return [{
        type: 'Feature',
        properties: {
          lid: this.lid, z: this.z, color: o.color, opacity: o.opacity, width: o.weight,
          blur: glow ? o.weight * 0.7 : 0, dashed: Boolean(o.dashArray) && !glow,
        },
        geometry: { type: 'MultiLineString', coordinates: lines },
      }];
    }
  }

  class Polygon extends Path {
    constructor(latlngs, options) { super({ fill: true, ...options }); this._rings = flat(latlngs); }
    get store() { return stores.areas; }
    getLatLngs() { return this._rings; }
    getBounds() { return RealL.latLngBounds([].concat(...this._rings)); }
    bindTooltip(html, options = {}) {
      // A permanent label, above the shape rather than over its middle.
      let top = null;
      for (const p of [].concat(...this._rings)) if (!top || p.lat > top.lat) top = p;
      this._label = new Tooltip({ direction: 'top', ...options }).setLatLng(top).setContent(html);
      if (this._map) this._label.addTo(this._map);
      return this;
    }
    ring() { return this._rings.map((r) => { const c = r.map((p) => [p.lng, p.lat]); c.push(c[0]); return c; }); }
    features() {
      const o = this.options;
      if (!this._rings.length || this._rings[0].length < 3) return [];
      return [{
        type: 'Feature',
        properties: {
          lid: this.lid, z: this.z, color: o.color, opacity: o.opacity, width: o.weight,
          fill: o.fillColor || o.color, fillOpacity: o.fill === false ? 0 : o.fillOpacity,
        },
        geometry: { type: 'Polygon', coordinates: this.ring() },
      }];
    }
  }

  // A circle in metres on the ground, drawn as the polygon it is.
  function circleRing(center, metres, steps = 64) {
    const c = RealL.latLng(center);
    const dLat = metres / 111320;
    const dLng = metres / (111320 * Math.max(0.01, Math.cos(c.lat * Math.PI / 180)));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      out.push([c.lng + dLng * Math.cos(a), c.lat + dLat * Math.sin(a)]);
    }
    return out;
  }

  class Circle extends Path {
    constructor(latlng, options) { super({ fill: true, radius: 10, ...options }); this._latlng = RealL.latLng(latlng); }
    get store() { return stores.areas; }
    setLatLng(ll) { this._latlng = RealL.latLng(ll); return this.redraw(); }
    getLatLng() { return this._latlng; }
    setRadius(r) { this.options.radius = r; return this.redraw(); }
    getBounds() { return this._latlng.toBounds(this.options.radius * 2); }
    features() {
      const o = this.options;
      return [{
        type: 'Feature',
        properties: {
          lid: this.lid, z: this.z, color: o.color, opacity: o.opacity, width: o.weight,
          fill: o.fillColor || o.color, fillOpacity: o.fill === false ? 0 : o.fillOpacity,
        },
        geometry: { type: 'Polygon', coordinates: [circleRing(this._latlng, o.radius)] },
      }];
    }
  }

  class LayerGroup extends Layer {
    constructor(layers) { super(); this._members = new Set(layers || []); }
    addLayer(layer) { this._members.add(layer); if (this._map) this._map.addLayer(layer); return this; }
    removeLayer(layer) { this._members.delete(layer); if (this._map) this._map.removeLayer(layer); return this; }
    clearLayers() { [...this._members].forEach((l) => this.removeLayer(l)); return this; }
    eachLayer(fn) { [...this._members].forEach(fn); return this; }
    hasLayer(layer) { return this._members.has(layer); }
    onAdd(map) { this._members.forEach((l) => map.addLayer(l)); }
    onRemove(map) { this._members.forEach((l) => map.removeLayer(l)); }
  }

  // The street map, as a layer of the style that is shown or not.
  class TileLayer extends Layer {
    constructor(url, options) { super(); this.options = options || {}; }
    onAdd() { if (ml.getLayer('osm-raster')) ml.setLayoutProperty('osm-raster', 'visibility', 'visible'); }
    onRemove() { if (ml.getLayer('osm-raster')) ml.setLayoutProperty('osm-raster', 'visibility', 'none'); }
  }

  const glmap = new GLMap();
  const L = Object.create(RealL);
  Object.assign(L, {
    map: () => glmap,
    marker: (ll, o) => new Marker(ll, o),
    circleMarker: (ll, o) => new CircleMarker(ll, o),
    circle: (ll, o) => new Circle(ll, o),
    polyline: (ll, o) => new Polyline(ll, o),
    polygon: (ll, o) => new Polygon(ll, o),
    tooltip: (o) => new Tooltip(o),
    layerGroup: (layers) => new LayerGroup(layers),
    tileLayer: (url, o) => new TileLayer(url, o),
    control: Object.assign(Object.create(RealL.control), {
      scale: (o = {}) => ({
        addTo(map) {
          map.ml.addControl(new maplibregl.ScaleControl({ maxWidth: o.maxWidth || 120, unit: 'metric' }), 'bottom-left');
          return this;
        },
      }),
    }),
  });

  return { L, map: glmap, stores, Layer, Marker, circleRing, blips };
}
