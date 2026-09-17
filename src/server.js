// server.js — the dashboard: a map page, the positions behind it, and a
// stream that pushes every change to whoever is watching.
//
// This page shows where people are, so it is never served without the token.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url));
const COOKIE = 'tll_token';

// Compare without letting response time reveal how much of the token matched.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenOf(req, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  const header = req.headers.cookie || '';
  const hit = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
}

export function serve(positions, config, { log = console } = {}) {
  const watchers = new Set();

  const send = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Called whenever a position changes; every open map hears about it at once,
  // which is the whole point of doing this over MTProto rather than polling.
  const publish = (person) => {
    const payload = { ...person, live: Boolean(person.liveUntil && person.liveUntil > Date.now() / 1000) };
    for (const res of watchers) {
      try { send(res, 'position', payload); } catch { watchers.delete(res); }
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ok = sameToken(tokenOf(req, url), config.dashboardToken);

    const deny = () => {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('401 — append ?token=… to the URL');
    };

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, watching: watchers.size, people: positions.list().length }));
      return;
    }

    if (!ok) return deny();

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(PAGE, 'utf8').catch(() => null);
      if (!html) { res.writeHead(500); res.end('missing page'); return; }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Remembered so the token is not needed in every later request, and
        // so it stops being visible in the address bar after the first load.
        'set-cookie': `${COOKIE}=${encodeURIComponent(config.dashboardToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/positions') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ people: positions.list() }));
      return;
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',   // nginx would otherwise hold the stream
      });
      watchers.add(res);
      send(res, 'hello', { people: positions.list() });
      // Proxies drop a connection that goes quiet; a comment costs nothing.
      const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* gone */ } }, 25000);
      req.on('close', () => { clearInterval(beat); watchers.delete(res); });
      return;
    }

    if (url.pathname.startsWith('/api/forget/') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/forget/'.length));
      positions.forget(id);
      for (const w of watchers) { try { send(w, 'forget', { id }); } catch { watchers.delete(w); } }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(config.port, config.host, () => {
    log.info(`dashboard on http://${config.host}:${config.port}/?token=…`);
  });

  return { server, publish, watchers };
}
