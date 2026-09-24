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
  var supported = 'noModule' in probe && Boolean(context);
  if (context) { var lose = context.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
  if (choice === 'classic' || !supported) { classic(!supported ? 'Classic map · 3D is unavailable in this browser' : ''); return; }
  document.body.dataset.renderer = 'loading';
  var script = document.createElement('script');
  script.type = 'module';
  script.src = '/lib/game-start.mjs';
  window.livegeoFallback = function () { classic('Classic map · 3D could not start'); };
  script.onerror = window.livegeoFallback;
  document.head.appendChild(script);
})();
