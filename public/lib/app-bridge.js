// app-bridge.js — the map page's side of the Android app (android/).
//
// In a browser this does nothing: window.LivegeoApp exists only inside the
// app's web view, which puts it there. Inside the app it:
//   - shows Go live, which shares this device's GPS through the app, and
//     keeps the button saying whether it is on and for how long;
//   - saves files through the app, since a web view drops blob downloads;
//   - gives the page navigator.share, which a web view does not have;
//   - starts the camera tilted in 3D the first time, for a game's view.
// The app finds its own way to tell the map is ready, and to close a dialog
// on Back; nothing on the page needs to call it for those.
//
// Loaded before map-bootstrap.js, so the camera choice is in place before
// the 3D map reads it. Deliberately ES5, like map-bootstrap.js.
(function () {
  var app = window.LivegeoApp;
  if (!app) return;
  document.documentElement.classList.add('in-app');

  // A first look through the game camera; a choice made since is kept.
  try {
    if (!localStorage.getItem('livegeo.camera')) localStorage.setItem('livegeo.camera', 'auto');
  } catch (e) {}

  function base64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var url = String(reader.result || '');
        resolve(url.slice(url.indexOf(',') + 1));
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  if (!navigator.share) {
    navigator.share = function (data) {
      data = data || {};
      var files = Array.prototype.slice.call(data.files || []);
      return Promise.all(files.map(function (file) {
        return base64(file).then(function (content) {
          return { name: file.name || 'livegeo', type: file.type || 'application/octet-stream', base64: content };
        });
      })).then(function (read) {
        app.share(JSON.stringify({ title: data.title || '', text: data.text || '', url: data.url || '', files: read }));
      });
    };
    navigator.canShare = function () { return true; };
  }

  var state = { on: false, until: null, paired: false };
  try { state = JSON.parse(app.sharing()) || state; } catch (e) {}
  var button = null;

  function left() {
    var seconds = Math.max(0, state.until - Date.now() / 1000);
    if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + ' min';
    return Math.floor(seconds / 3600) + ' h ' + Math.floor((seconds % 3600) / 60) + ' min';
  }

  function render() {
    if (!button) return;
    var on = Boolean(state.on);
    button.classList.toggle('is-live', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    var text = button.querySelector('.tool-label');
    if (text) text.textContent = on ? (state.until ? 'Live · ' + left() : 'Live') : 'Go live';
    button.title = on ? 'You are live on the map. Tap to stop.' : 'Share where this device is, live';
  }

  window.livegeoApp = {
    // Called by the app whenever sharing starts or stops, or the app returns.
    onSharing: function (next) {
      if (next && typeof next === 'object') state = next;
      render();
    },
    save: function (blob, name) {
      return base64(blob).then(function (content) {
        app.saveFile(name, blob.type || 'application/octet-stream', content);
      });
    },
    buzz: function (kind) {
      try { app.buzz(kind); } catch (e) {}
    },
  };

  function wire() {
    button = document.getElementById('golivebtn');
    if (!button) return;
    button.hidden = false;
    button.addEventListener('click', function () { app.toggleSharing(); });
    render();
    setInterval(render, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
