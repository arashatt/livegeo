// people-map.js — how somebody is drawn on a map, for every page that draws
// people: a dot that travels to where they are now instead of jumping, a soft
// beam for the way they are heading, and — inside a private place — a
// breathing blur, because what arrived there is a place and not a point.
//
// Drawing only. What to draw was decided before it got here: the server sends
// a viewer who may not see exactly the blur instead of the point, and
// path-time.js says which way somebody is heading and whether a move is worth
// gliding. Loaded after Leaflet by the dashboard and by the page a live link
// opens, so both draw a person the same way.

(function (root) {
  var L = root.L;
  var reduced = Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function rgba(hex, a) {
    var n = parseInt(String(hex).replace('#', ''), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // A patch of ground drawn as a <div>. Leaflet already knows how to place and
  // scale an image over a patch of ground, zoom animation included, so this is
  // an image overlay with a div where the image would be. It goes in its own
  // pane between the paths and the markers: a path that runs into it is
  // blurred with the map, and names and dots stay sharp above it.
  var Veil = L.ImageOverlay.extend({
    _initImage: function () {
      var el = this._image = L.DomUtil.create('div', 'veil leaflet-image-layer');
      if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
      if (this.options.className) this.options.className.split(' ').forEach(function (c) { if (c) L.DomUtil.addClass(el, c); });
      el.innerHTML = '<div class="fog"></div>';
      el.onselectstart = L.Util.falseFn;
      el.onmousemove = L.Util.falseFn;
    },
  });

  function tint(veil, colour) {
    var fog = veil.getElement() && veil.getElement().querySelector('.fog');
    if (fog) fog.style.background = 'radial-gradient(closest-side,' + rgba(colour, .28) + ',' + rgba(colour, .14) + ' 60%,transparent)';
  }

  // Somebody moved: their dot, its halo and its beam travel together to the
  // new point, easing in and out, so a stream of fixes reads as one movement
  // rather than a dot teleporting. A new fix mid-glide starts from wherever
  // the dot has got to. Zero milliseconds puts it there at once.
  function glide(entry, to, ms) {
    halt(entry);
    var from = entry.marker.getLatLng();
    var place = function (here) {
      entry.marker.setLatLng(here);
      if (entry.halo) entry.halo.setLatLng(here);
      if (entry.beam) entry.beam.setLatLng(here);
    };
    if (!ms || reduced) { place(to); return; }
    var start = null;
    var step = function (now) {
      if (start === null) start = now;
      var k = Math.min(1, (now - start) / ms);
      var eased = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      place(L.latLng(from.lat + (to.lat - from.lat) * eased, from.lng + (to.lng - from.lng) * eased));
      entry.gliding = k < 1 ? requestAnimationFrame(step) : 0;
    };
    entry.gliding = requestAnimationFrame(step);
  }

  function halt(entry) {
    if (entry.gliding) cancelAnimationFrame(entry.gliding);
    entry.gliding = 0;
  }

  function on(map) {
    map.createPane('veils');
    map.getPane('veils').style.zIndex = 450;
    map.getPane('veils').style.pointerEvents = 'none';
    // Under the paths and the dots: a beam says which way, and should never
    // cover the person it points away from.
    map.createPane('beams');
    map.getPane('beams').style.zIndex = 390;
    map.getPane('beams').style.pointerEvents = 'none';

    // Zoomed so far in that a blur is several screens across, the whole view
    // is inside it; see .veil.huge in people-map.css.
    function size() {
      var screen = map.getSize();
      var limit = 3 * Math.max(screen.x, screen.y);
      map.eachLayer(function (layer) {
        if (!(layer instanceof Veil) || !layer.getElement()) return;
        var b = layer.getBounds();
        var across = map.latLngToContainerPoint(b.getNorthEast()).x - map.latLngToContainerPoint(b.getSouthWest()).x;
        layer.getElement().classList.toggle('huge', across > limit);
      });
    }
    map.on('zoomend resize', size);

    return {
      veil: function (bounds, className) { return new Veil('', bounds, { pane: 'veils', className: className || '' }); },
      tint: tint,
      size: size,
      glide: glide,
      halt: halt,

      // A dot dissolving into a blur, or condensing out of one. Removed by a
      // timer rather than on animationend, so nothing is left behind if the
      // animation never runs; with reduced motion there is no puff at all.
      puff: function (latlng, colour, kind) {
        if (reduced) return;
        var m = L.marker(latlng, {
          icon: L.divIcon({ className: '', html: '<div class="puff ' + kind + '" style="background:' + colour + '"></div>',
            iconSize: [16, 16], iconAnchor: [8, 8] }),
          interactive: false, keyboard: false,
        }).addTo(map);
        setTimeout(function () { map.removeLayer(m); }, kind === 'dissolve' ? 750 : 550);
      },

      fadeOut: function (veil) {
        var el = veil.getElement();
        if (reduced || !el) { map.removeLayer(veil); return; }
        el.classList.remove('in');
        el.classList.add('out');
        setTimeout(function () { if (map.hasLayer(veil)) map.removeLayer(veil); }, 650);
      },

      // The beam: a fan under the dot, pointed `deg` from north, or taken
      // away when `deg` is null. It turns the short way round, so 350° to 10°
      // is a nudge rather than a pirouette.
      aim: function (entry, deg, colour) {
        if (deg === null || deg === undefined || !entry.marker) {
          if (entry.beam) { map.removeLayer(entry.beam); entry.beam = null; }
          return;
        }
        if (!entry.beam) {
          entry.beam = L.marker(entry.marker.getLatLng(), {
            icon: L.divIcon({ className: 'beam', html: '<div></div>', iconSize: [64, 64], iconAnchor: [32, 32] }),
            pane: 'beams', interactive: false, keyboard: false,
          }).addTo(map);
          entry.beamDeg = deg;
        } else {
          entry.beamDeg += ((deg - entry.beamDeg) % 360 + 540) % 360 - 180;
        }
        var fan = entry.beam.getElement() && entry.beam.getElement().firstChild;
        if (!fan) return;
        fan.style.transform = 'rotate(' + entry.beamDeg + 'deg)';
        fan.style.background = 'conic-gradient(from -35deg,' + rgba(colour, .6) + ' 0deg 70deg,transparent 70deg)';
      },
    };
  }

  root.PeopleMap = { on: on, rgba: rgba, reduced: reduced, Veil: Veil };
})(typeof globalThis !== 'undefined' ? globalThis : this);
