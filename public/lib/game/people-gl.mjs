// people-gl.mjs — how somebody is drawn on the 3D map. The same API as
// /lib/people-map.js, which draws them on the classic map; the dashboard
// calls one or the other and cannot tell which.
//
// What to draw was decided before it got here: the server sends a viewer who
// may not see exactly the blur instead of the point. The blur lies flat on
// the ground at every tilt, as the area it is. It is not centred on anything
// (the server moved its centre), and nothing marks its middle.

export function peopleOnGL({ gl, ml, L, reduced = false }) {
  const { stores, Layer, Marker, circleRing } = gl;
  let lids = 1e6;

  function rgba(hex, a) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // The blur: a soft disc on the ground, drawn by the map itself rather than
  // with a blur filter — which would mean redrawing the page every frame.
  class Veil extends Layer {
    constructor(bounds, className) {
      super();
      this.lid = ++lids;
      this.bounds = L.latLngBounds(bounds);
      this.colour = '#7a6ff0';
      this.mine = /\bmine\b/.test(className || '');
      this.fade = (/\bin\b/.test(className || '') && !reduced) ? 0 : 1;
      this.dim = false;
      // The page toggles classes on the element Leaflet's veil has; here
      // they are read back as the veil's state.
      const veil = this;
      this.element = {
        classList: {
          toggle(name, on) {
            if (name === 'dim') { veil.dim = on === undefined ? !veil.dim : Boolean(on); veil.redraw(); }
          },
          add() {}, remove() {}, contains: () => false,
        },
      };
    }
    onAdd() {
      stores.veils.put(this);
      if (this.fade < 1) this.animate(0, 1, 900);
    }
    onRemove() { stores.veils.drop(this); }
    redraw() { if (this._map) stores.veils.dirty(); return this; }
    animate(from, to, ms, done) {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / ms);
        this.fade = from + (to - from) * (1 - Math.pow(1 - k, 2));
        this.redraw();
        if (k < 1) requestAnimationFrame(step); else if (done) done();
      };
      requestAnimationFrame(step);
    }
    getElement() { return this.element; }
    getBounds() { return this.bounds; }
    setBounds(b) { this.bounds = L.latLngBounds(b); return this.redraw(); }
    features() {
      const c = this.bounds.getCenter();
      const radius = c.distanceTo(L.latLng(this.bounds.getNorth(), c.lng));
      const alpha = (this.mine ? 0.55 : 1) * (this.dim ? 0.3 : 1) * this.fade;
      // A soft disc lying on the ground: a circle layer blurred all the way
      // in, sized in metres. r0 is its radius in pixels at zoom 0; the style
      // doubles it for every zoom level. No rings, nothing marking a middle.
      const r0 = radius / (40075016.686 * Math.cos(c.lat * Math.PI / 180) / 512);
      const out = [{
        type: 'Feature',
        properties: { lid: this.lid, colour: this.colour, alpha: 0.5 * alpha, r0, edge: false },
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      }];
      if (this.mine) {
        out.push({
          type: 'Feature',
          properties: { lid: this.lid, colour: '#9d94ff', alpha: 0.85 * this.fade, edge: true },
          geometry: { type: 'LineString', coordinates: circleRing(c, radius, 96) },
        });
      }
      return out;
    }
  }

  // Somebody moved: their blip, its halo and its heading travel together, as
  // on the classic map (people-map.js).
  function glide(entry, to, ms) {
    halt(entry);
    const from = entry.marker.getLatLng();
    const place = (here) => {
      entry.marker.setLatLng(here);
      if (entry.halo) entry.halo.setLatLng(here);
      if (entry.beam) entry.beam.setLatLng(here);
    };
    if (!ms || reduced) { place(to); return; }
    let start = null;
    const step = (now) => {
      if (start === null) start = now;
      const k = Math.min(1, (now - start) / ms);
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      place(L.latLng(from.lat + (to.lat - from.lat) * eased, from.lng + (to.lng - from.lng) * eased));
      entry.gliding = k < 1 ? requestAnimationFrame(step) : 0;
    };
    entry.gliding = requestAnimationFrame(step);
  }

  function halt(entry) {
    if (entry.gliding) cancelAnimationFrame(entry.gliding);
    entry.gliding = 0;
  }

  // Which way somebody is going: an arrow at their blip, turned by the angle
  // the heading makes on screen — which tilting and turning the map change.
  const beams = new Set();
  function screenAngle(latlng, deg) {
    const here = ml.project([latlng.lng, latlng.lat]);
    const r = deg * Math.PI / 180;
    const ahead = ml.project([latlng.lng + Math.sin(r) * 0.0005 / Math.max(0.2, Math.cos(latlng.lat * Math.PI / 180)),
      latlng.lat + Math.cos(r) * 0.0005]);
    return Math.atan2(ahead.x - here.x, here.y - ahead.y) * 180 / Math.PI;
  }
  function turn(beam) {
    const arrow = beam.getElement() && beam.getElement().firstChild;
    if (!arrow || beam.deg === undefined) return;
    arrow.style.transform = `rotate(${screenAngle(beam.getLatLng(), beam.deg)}deg)`;
  }
  ml.on('rotate', () => beams.forEach(turn));
  ml.on('pitch', () => beams.forEach(turn));

  const api = {
    // Which way you are heading, for the Chase camera and the radar; null
    // when you are not going anywhere.
    meHeading: null,
    veil: (bounds, className) => new Veil(bounds, className),
    tint(veil, colour) { if (veil) { veil.colour = colour; veil.redraw(); } },
    size() {},
    glide,
    halt,

    puff(latlng, colour, kind) {
      if (reduced) return;
      const m = new Marker(latlng, {
        icon: L.divIcon({ className: '', html: `<div class="puff ${kind}" style="background:${colour}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
        interactive: false, keyboard: false,
      }).addTo(gl.map);
      setTimeout(() => m.remove(), kind === 'dissolve' ? 750 : 550);
    },

    fadeOut(veil) {
      if (reduced || !veil._map) { if (veil._map) veil.remove(); return; }
      veil.animate(veil.fade, 0, 600, () => veil.remove());
    },

    aim(entry, deg, colour) {
      if (entry.marker && entry.marker.blip === 'me') api.meHeading = deg === null || deg === undefined ? null : deg;
      if (deg === null || deg === undefined || !entry.marker) {
        if (entry.beam) { beams.delete(entry.beam); entry.beam.remove(); entry.beam = null; }
        return;
      }
      if (!entry.beam) {
        entry.beam = new Marker(entry.marker.getLatLng(), {
          icon: L.divIcon({ className: 'gl-heading', html: '<div></div>', iconSize: [44, 44], iconAnchor: [22, 22] }),
          interactive: false, keyboard: false,
        }).addTo(gl.map);
        entry.beam.on('move', () => turn(entry.beam));
        beams.add(entry.beam);
      }
      entry.beam.deg = deg;
      entry.beam.getElement().style.setProperty('--c', colour);
      entry.beam.getElement().dataset.me = entry.marker.blip === 'me' ? '1' : '';
      turn(entry.beam);
    },

    rgba,
  };
  return api;
}
