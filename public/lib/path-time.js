// path-time.js — which moment a point on a drawn path stands for.
//
// A path is a line through fixes, and each fix has a time. Hovering somewhere
// between two of them asks what time it was there, and the only honest answer
// is an estimate: the movement filter drops fixes that did not go anywhere, so
// the space between two points is guessed at a steady pace, not observed. The
// page marks that estimate with ≈ and says the exact time only at a fix.
//
// Loaded as a plain script by the dashboard and the share page, and imported
// by the tests. No imports and no DOM, for the same reason tile-path.js has
// none: two pages depend on it and a test should be able to hold it exactly.

(function (root) {
  // A time, or null. Not Number(): Number(null) is 0, which is a perfectly
  // finite time — midnight on 1 January 1970 — and a missing time averaged
  // with a real one produced a confident answer decades wrong.
  function seconds(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // The closest point on the whole polyline to `p`, as a segment index and a
  // fraction along that segment. Screen pixels in, so "close" means close to
  // where the pointer is, at whatever zoom the map happens to be.
  function nearestSegment(points, p) {
    if (!points || points.length < 2 || !p) return null;
    var best = null;
    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i];
      var b = points[i + 1];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      // A segment of zero length is two fixes on the same pixel; the nearest
      // point on it is the point itself.
      var t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      var x = a.x + t * dx;
      var y = a.y + t * dy;
      var d = Math.hypot(p.x - x, p.y - y);
      if (!best || d < best.distance) best = { index: i, t: t, distance: d, x: x, y: y };
    }
    return best;
  }

  // The time at a fraction along a segment, assuming a steady pace between
  // its two fixes. Null when either end has no time, rather than a guess
  // built on a guess.
  function timeAt(times, index, t) {
    if (!times) return null;
    var a = seconds(times[index]);
    var b = seconds(times[index + 1]);
    if (a === null || b === null) return null;
    return a + (b - a) * Math.max(0, Math.min(1, t));
  }

  // Great-circle metres between two fixes. The same formula as metresBetween
  // in src/positions.js; restated because this runs in a browser that cannot
  // import it, and it is short enough that sharing it would cost more than it
  // saves.
  function metres(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.latitude - a.latitude) * rad;
    var dLon = (b.longitude - a.longitude) * rad;
    var s = Math.pow(Math.sin(dLat / 2), 2)
      + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // Average speed over a segment, in metres per second. Null when the times
  // are missing or do not move forward — a segment whose second fix is not
  // later than its first has no speed, only an error.
  function speedBetween(a, b) {
    if (!a || !b) return null;
    var ta = seconds(a.at);
    var tb = seconds(b.at);
    if (ta === null || tb === null || tb - ta <= 0) return null;
    var dt = tb - ta;
    return metres(a, b) / dt;
  }

  // How a speed reads. Walking pace and driving pace need different
  // precision: 4.1 km/h says something that 4 km/h does not, and 63.4 km/h
  // says nothing that 63 km/h does not.
  function speedLabel(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
    var kmh = ms * 3.6;
    if (kmh < 0.5) return 'still';
    return (kmh < 20 ? kmh.toFixed(1) : String(Math.round(kmh))) + ' km/h';
  }

  // Stored history and the live trail, as one path in time order. They
  // overlap — the trail's recent fixes are also in the history — so a fix
  // seen twice is kept once. History comes back newest first; order is not
  // assumed from either side.
  function merge(older, newer) {
    var seen = {};
    var out = [];
    [].concat(older || [], newer || []).forEach(function (q) {
      if (!q || q.latitude === null || q.latitude === undefined || seconds(q.at) === null) return;
      var key = q.at + ':' + Number(q.latitude).toFixed(6) + ':' + Number(q.longitude).toFixed(6);
      if (seen[key]) return;
      seen[key] = true;
      out.push({ latitude: Number(q.latitude), longitude: Number(q.longitude), at: Number(q.at) });
    });
    return out.sort(function (a, b) { return a.at - b.at; });
  }

  var api = {
    merge: merge,
    nearestSegment: nearestSegment,
    timeAt: timeAt,
    metres: metres,
    speedBetween: speedBetween,
    speedLabel: speedLabel,
  };
  root.PathTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
