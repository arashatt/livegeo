// Same-origin SVG tiles, with an honest indication when imported map detail
// is absent. Keep failed/empty tiles transparent so the street map survives.
(function (root) {
  var FEATURES = ['landuse', 'parks', 'water', 'buildings', 'rail', 'roads'];
  var EMPTY = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>');

  function on(map, status) {
    var tiles = new Set();
    var visible = true;
    var features = FEATURES.slice();
    var layer;
    function report() {
      if (!visible || !features.length) return status('Styled details are off.');
      if (map.getZoom() < 8) return status('Zoom in for styled map details.');
      var bounds = map.getPixelBounds();
      var span = Math.pow(2, map.getZoom());
      var current = Array.from(tiles).filter(function (tile) {
        if (tile.coords.z !== map.getZoom()) return false;
        var y = tile.coords.y * 256;
        if (y >= bounds.max.y || y + 256 <= bounds.min.y) return false;
        // Leaflet retains offscreen tiles. Only visible world copies count
        // when saying that styled data is available at this view.
        return [-span, 0, span].some(function (offset) {
          var x = (tile.coords.x + offset) * 256;
          return x < bounds.max.x && x + 256 > bounds.min.x;
        });
      });
      if (current.some(function (tile) { return tile.dataset.source === 'postgis'; })) return status('Styled details in available areas.');
      if (!current.length || current.some(function (tile) { return !tile.dataset.source; })) return status('Loading styled details…');
      if (current.some(function (tile) { return tile.dataset.source === 'error'; })) return status('Styled details unavailable. The street map is still available.');
      status('No styled features here. Keep the street map on for coverage.');
    }
    var Cartography = root.L.TileLayer.extend({
      createTile: function (coords, done) {
        var tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        tile.coords = coords;
        tile.controller = new AbortController();
        tiles.add(tile);
        tile.onload = function () {
          if (tile.blobUrl) { URL.revokeObjectURL(tile.blobUrl); tile.blobUrl = null; }
          done(null, tile);
          report();
        };
        tile.onerror = function () {
          if (tile.blobUrl) { URL.revokeObjectURL(tile.blobUrl); tile.blobUrl = null; }
          tile.dataset.source = 'error';
          done(new Error('Could not draw map detail'), tile);
          report();
        };
        fetch(this.getTileUrl(coords), { signal: tile.controller.signal, credentials: 'same-origin' })
          .then(function (response) {
            if (!response.ok) throw new Error('Map detail unavailable');
            tile.dataset.source = response.headers.get('x-carto-source') || 'empty';
            return response.blob();
          })
          .then(function (blob) {
            if (tile.controller.signal.aborted) return;
            tile.blobUrl = URL.createObjectURL(blob);
            tile.src = tile.blobUrl;
          })
          .catch(function (error) {
            if (error.name === 'AbortError' || tile.controller.signal.aborted) return;
            tile.dataset.source = 'error';
            tile.src = EMPTY;
          });
        return tile;
      },
    });
    map.createPane('cartography');
    map.getPane('cartography').style.zIndex = 250;
    map.getPane('cartography').style.pointerEvents = 'none';
    layer = new Cartography('', { pane: 'cartography', minZoom: 8, maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
    layer.on('tileunload', function (event) {
      var tile = event.tile;
      tile.controller.abort();
      if (tile.blobUrl) URL.revokeObjectURL(tile.blobUrl);
      tile.onload = tile.onerror = null;
      tiles.delete(tile);
    });
    function sync() {
      // The version avoids reusing previously cached tiles with the old Y axis.
      layer.setUrl('/carto/{z}/{x}/{y}.svg?v=2&layers=' + encodeURIComponent(features.join(',')));
      if (visible && features.length) {
        if (!map.hasLayer(layer)) layer.addTo(map);
      } else if (map.hasLayer(layer)) map.removeLayer(layer);
      report();
    }
    map.on('zoomend moveend', report);
    sync();
    return {
      setVisible: function (value) { visible = value; sync(); },
      setFeature: function (name, value) {
        features = FEATURES.filter(function (feature) { return feature === name ? value : features.includes(feature); });
        sync();
      },
    };
  }
  root.Cartography = { on: on };
})(typeof globalThis !== 'undefined' ? globalThis : this);
