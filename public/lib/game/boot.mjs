// boot.mjs — start the 3D map, or hand the page to the classic one.
//
// Loaded by the page only where WebGL2 and ES modules exist. Anything that
// goes wrong before the dashboard starts — a download that fails, a GPU that
// refuses, MapLibre throwing — ends in the classic map instead, which is
// already loaded and has every feature. After the dashboard has started on
// this map, nothing falls back: two dashboards must never run at once.

function stylesheet(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

try {
  stylesheet('/vendor/maplibre/maplibre-gl.css');
  stylesheet('/lib/game/game.css');
  const { startGame } = await import('./game-map.mjs');
  // The page may have given up waiting and started the classic map.
  if (window.livegeoClaim && window.livegeoClaim()) {
    document.body.classList.add('gl');
    const game = await startGame({ container: document.getElementById('map'), L: window.L });
    // For looking at from the console; nothing depends on it.
    window.livegeo3d = game;
    window.livegeoStart(game);
  }
} catch (e) {
  console.error('3D map unavailable, using the classic map —', e && e.message ? e.message : e);
  if (window.livegeoClassic) window.livegeoClassic();
}
