// Deliberately ES5: browsers without modules/WebGL2 get the complete Leaflet dashboard.
(function () {
  var choice = 'game';
  try { choice = localStorage.getItem('livegeo.renderer') || 'game'; } catch (e) {}
  var select = document.getElementById('rendererMode');
  select.value = choice === 'classic' ? 'classic' : 'game';
  select.onchange = function () {
    try { localStorage.setItem('livegeo.renderer', select.value); } catch (e) {}
    location.reload();
  };
  function classic(reason) {
    document.body.dataset.renderer = 'classic';
    document.getElementById('map').innerHTML = '';
    window.startDashboard(window.L, window.PeopleMap, window.Cartography, false);
    document.getElementById('rendererNote').textContent = reason || 'Classic map · all sharing features available';
    select.value = 'classic';
  }
  var probe = document.createElement('script');
  var canvas = document.createElement('canvas');
  var context;
  try { context = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }); } catch (e) {}
  // The 3D map and MapLibre are written in current JavaScript (ES2022: class
  // static blocks, ??=). A browser that cannot parse that would sit on an
  // empty map, because a module that fails to parse tells its script tag
  // nothing. An old Android web view, a car head unit's above all, is the
  // usual one; it gets the classic map instead.
  var modern = false;
  try { modern = Boolean(new Function('class A{static{}#p;m(){return this.#p??=1}}return A')); } catch (e) {}
  var supported = 'noModule' in probe && Boolean(context) && modern;
  if (context) { var lose = context.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
  if (choice === 'classic' || !supported) { classic(!supported ? 'Classic map · 3D is unavailable in this browser' : ''); return; }
  document.body.dataset.renderer = 'loading';
  var script = document.createElement('script');
  script.type = 'module';
  script.src = '/lib/game-start.mjs';
  window.livegeoFallback = function () {
    if (document.body.dataset.renderer === 'classic') return;
    classic('Classic map · 3D could not start');
  };
  script.onerror = window.livegeoFallback;
  // And if the check above is ever wrong about what parses: a syntax error
  // in the 3D map's own files, before it started, falls back the same way.
  window.addEventListener('error', function (event) {
    if (document.body.dataset.renderer !== 'loading') return;
    var syntax = (event.error && event.error.name === 'SyntaxError') || /SyntaxError/.test(String(event.message || ''));
    if (syntax && /\/lib\/(game-|map-assets\/maplibre\/)/.test(String(event.filename || ''))) window.livegeoFallback();
  });
  document.head.appendChild(script);
})();
