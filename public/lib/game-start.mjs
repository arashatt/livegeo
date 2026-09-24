import {createGameMap} from './game-map.mjs';
try {
  const renderer=await createGameMap();
  document.body.dataset.renderer='game';
  window.startDashboard(renderer.L,renderer.PeopleMap,renderer.Cartography,true);
} catch(error) {
  // Includes MapLibre v6 GPUInitializationError. A rendering failure never
  // takes away the privacy, location or safety controls in Classic mode.
  window.livegeoMap?.gl.remove();
  window.livegeoFallback();
}
