// server.js — the dashboard: a map page, the positions behind it, and a
// stream that pushes every change to whoever is watching.
//
// This page shows where people are, so it is never served without the token.

import { parseVectorPath, parseTerrainPath } from './tile-path.js';
import { EMPTY_VECTOR, parseVectorLayers } from './postgis-vector.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname, join } from 'node:path';
import { parseTilePath, parseCartoPath, makeTiles } from './tiles.js';
import { makeDistrict } from './district.js';
import { makeVectorUpstream } from './vector-tiles.js';
import { makeVectorCartography } from './cartography-vector.js';
import { makeWorldVector } from './world-vector.js';
import { makeTerrainTiles } from './terrain-tiles.js';
import { EMPTY_CARTOGRAPHY, parseCartographyLayers } from './cartography.js';
import { COOKIE, sameToken, tokenOf } from './token.js';
import { SESSION_COOKIE, mint, readSession, checkWidget, seal, unseal } from './login.js';
import {
  getDiscovery, issuerFor, randomToken, codeChallenge, exchangeCode, verifyIdToken, userFromClaims,
} from './oidc.js';
import { makeCircles, canActFor } from './circles.js';
import { makeDevices, makeCodes } from './devices.js';
import { readFixes, fromDevice, MAX_BATCH } from './ingest.js';
import {
  makeZones, ZONE_MIN, ZONE_MAX, ZONES_EACH, trimEnds, trimLengths, breaksOf, withBreaks,
} from './zones.js';
import { toGpx, splitAtPauses, dayOf, contentDisposition } from './gpx.js';
import { cleanTrack } from './track.js';
import { makeIncidents } from './incidents.js';
import { makeLive, describeLink, LIVE_MINUTES, LIVE_EACH } from './live.js';
import { CHECK_HOURS } from './checks.js';
import { randomBytes, createHash } from 'node:crypto';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PAGE = resolve(PUBLIC, 'index.html');
const SHARE_PAGE = resolve(PUBLIC, 'share.html');
const LIVE_PAGE = resolve(PUBLIC, 'live.html');
const LOGIN_PAGE = resolve(PUBLIC, 'login.html');

const STATIC_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  // Oswald, for the district name's Latin line (/vendor/fonts).
  '.woff2': 'font/woff2',
};

// Resolves a request path inside public/, or returns null. The prefix check is
// the point: URL parsing collapses a literal "..", but a percent-encoded one
// survives to decodeURIComponent, and only comparing the resolved path catches
// that.
// The bot username and domain are interpolated into the login page, and both
// come from outside this file. Neither can contain a quote once escaped.
function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// What a paired watch may read, besides tiles. Everything else is not found.
const DEVICE_READS = new Set(['/api/me', '/api/positions', '/api/place', '/api/fences']);
const DEVICE_READ_PREFIXES = ['/api/history/', '/api/person/', '/api/photo/'];

// A GPX file is a day of somebody's movements in a form made to be kept, so
// its size is bounded twice: a week at most, and a number of fixes no real
// week comes near.
const GPX_WINDOW = 7 * 86400;
const GPX_MAX = 50_000;

// The body of a request as JSON, or an error saying why not. Capped, because
// a body is whatever the other end chose to send.
export function readJson(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve({ error: 'too large', status: 413 }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return;
      try { resolve({ body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }); }
      catch { resolve({ error: 'not JSON', status: 400 }); }
    });
    req.on('error', () => resolve({ error: 'unreadable', status: 400 }));
  });
}

export function staticFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  // New dashboard assets follow the app deployment through an existing Worker.
  // The Worker's separately uploaded /vendor bundle may predate MapLibre.
  if(rel.startsWith('/lib/map-assets/')){
    const root=resolve(PUBLIC,'vendor'),asset=resolve(root,rel.slice('/lib/map-assets/'.length));
    if(!asset.startsWith(root+sep))return null;
    const type=STATIC_TYPES[extname(asset).toLowerCase()];return type?{file:asset,type}:null;
  }
  const file = resolve(PUBLIC, '.' + (rel.startsWith('/') ? rel : `/${rel}`));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return null;
  const type = file===resolve(PUBLIC,'lib/terrain-credits.html')?'text/html; charset=utf-8':STATIC_TYPES[extname(file).toLowerCase()];
  return type ? { file, type } : null;
}

export function serve(positions, config, {
  log = console, directory = null, geo = null, links = null,
  // Who may see whom. Without one, a circle-less stand-in: admins and the
  // shared token, which is exactly what the service did before circles.
  circles = makeCircles({ admins: config.viewers }),
  // Mints a one-time invite for a person and returns a link to it, or null.
  // Given by index.js because only the bot knows its own username.
  makeInvite = null,
  // Told when a fence is deleted, so whatever is watching them can drop the
  // state it holds about it.
  onFenceDeleted = null,
  // Paired watches, and the codes that pair them. Absent, pairing is off.
  devices = makeDevices(),
  codes = makeCodes(),
  // Given the positions a watch reported and the device, feeds them into the
  // same pipeline as Telegram's. Returns nothing worth waiting on.
  onIngest = null,
  // Private places. Without a database there are none, and everybody is
  // shown exactly as before.
  zones = makeZones(),
  // Live links. Without a database there are none to make.
  live = makeLive(),
  // SOS (sos.js): { raise(id), end(id) }. Absent, the map offers none.
  sos = null,
  // Check on me (checks.js). Absent, likewise.
  checks = null,
  // Where links sent from here point (address.js). Only its source is ever
  // said out loud, in /healthz.
  address = null,
  // The name of where the middle of the map is (district.js): { at(lat, lon,
  // zoom) }. Built from the config and the database unless given, which is
  // what tests do.
  district = null,
  // Vector tiles from the upstream (vector-tiles.js): { enabled, tile(t) }.
  // Built from the config unless given; the district name and the styled
  // map layers both draw from it.
  vectorTiles = null,
  terrainTiles = null,
  // Road reports (incidents.js). Without one given, reports live in memory
  // until a restart, which is what tests use.
  incidents = makeIncidents(),
} = {}) {
  // Open streams, and who is at the other end of each. Every event is checked
  // against the viewer before it is written, so a stream only ever carries
  // people its viewer may see.
  const watchers = new Map();   // res -> viewer
  const hasAdmins = (config.viewers || []).length > 0;
  // Sign-in is available when there is anybody it could admit: admins, or —
  // with a database to keep circles in — everyone the bot has met. A login
  // page that can admit nobody is worse than no login page.
  const signInOn = () => Boolean(config.botToken && links && (hasAdmins || circles.enabled));
  // Known only after the bot connects, which happens after this is listening.
  let botName = '';

  // Share tokens seen to be good, and when that answer goes stale. A share page
  // asks for dozens of tiles; one database round trip covers all of them.
  const shareCache = new Map();
  const SHARE_CACHE_MS = 60_000;

  async function validShare(token) {
    if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token) || !geo) return false;
    const seen = shareCache.get(token);
    if (seen && seen > Date.now()) return true;
    const found = await geo.readShare(token).catch(() => null);
    if (!found) { shareCache.delete(token); return false; }
    shareCache.set(token, Date.now() + SHARE_CACHE_MS);
    return true;
  }

  async function serveTile(tile, res) {
    const got = await tiles.get(tile);
    if (!got) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('no tile'); return; }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=604800',
      'x-tile-source': got.from,
    });
    res.end(got.bytes);
  }

  async function serveCartography(tile, res, layers) {
    let svg = geo?.cartographyTile ? await geo.cartographyTile(tile.z, tile.x, tile.y, layers) : null;
    let source = svg ? 'postgis' : 'empty';
    // Where the import has nothing — or there is none, as on a server that
    // only keeps history — the same features from the upstream's vector
    // tiles (cartography-vector.js), drawn the same way.
    if (!svg) {
      svg = await vectorCarto.tile(tile.z, tile.x, tile.y, layers).catch((e) => {
        log.error('carto: cannot draw from vector tiles —', e && e.message ? e.message : e);
        return null;
      });
      if (svg) source = 'upstream';
    }
    // Transparent is a normal fallback: with neither, the raster basemap
    // still shows.
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': source === 'postgis' ? 'private, max-age=300' : source === 'upstream' ? 'private, max-age=3600' : 'private, max-age=30',
      'x-carto-source': source,
    });
    res.end(svg || EMPTY_CARTOGRAPHY);
  }

  async function serveStatic(url, req, res) {
    const hit = staticFile(url.pathname);
    const bytes = hit ? await readFile(hit.file).catch(() => null) : null;
    if (!bytes) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    // Leaflet does not change under a deploy, so a browser may keep it for a
    // week. Our own code in /lib/ does, and the pages that load it are never
    // cached: a fresh page against last week's copy of its scripts breaks in
    // ways nobody can reproduce. So /lib/ is checked every time, which costs
    // a 304 when nothing changed.
    if (url.pathname.startsWith('/lib/')) {
      const tag = `"${createHash('sha1').update(bytes).digest('base64url')}"`;
      const headers = { 'content-type': hit.type, 'cache-control': 'no-cache', etag: tag };
      if (req.headers['if-none-match'] === tag) { res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, headers);
      res.end(bytes);
      return;
    }
    res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'private, max-age=604800' });
    res.end(bytes);
  }

  const tiles = makeTiles({
    cacheDir: config.tileCache,
    upstream: config.tileUpstream,
    userAgent: config.tileUserAgent,
    maxAge: config.tileMaxAge,
    log,
  });

  const vectors = vectorTiles || makeVectorUpstream({
    upstream: config.vectorUpstream,
    cacheDir: join(config.tileCache || '/tmp/livegeo-tiles', 'vector'),
    userAgent: config.tileUserAgent,
    maxAge: config.vectorMaxAge,
    log,
  });
  const districts = district || makeDistrict({
    postgis: geo && geo.placesIn ? { places: (t) => geo.placesIn(t) } : null,
    upstream: vectors,
    log,
  });
  const vectorCarto = makeVectorCartography({ upstream: vectors, log });
  const worldVector = makeWorldVector({ upstream: vectors, log });
  const terrain = terrainTiles || makeTerrainTiles({upstream:config.terrainUpstream,cacheDir:join(config.tileCache || '/tmp/livegeo-tiles','terrain'),maxAge:config.terrainMaxAge,userAgent:config.tileUserAgent,log});

  const send = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Removing somebody, from wherever the request came from: the button on the
  // page, or /stop sent to the bot. One implementation, because these must not
  // be able to disagree about what forgetting means.
  async function forget(id) {
    // Who could see them has to be worked out before the erasure, which takes
    // the grants with it — afterwards nobody could, and nobody would be told.
    const told = [...watchers].filter(([, viewer]) => circles.canSee(viewer, id)).map(([res]) => res);
    positions.forget(id);
    // Forgetting has to mean forgetting. History is kept indefinitely, so the
    // one action that removes a person must clear the record too, not just
    // take them off the map until the next update arrives.
    const erased = geo ? await geo.forget(id).catch((e) => {
      log.error('geo: erasure failed —', e && e.message ? e.message : e);
      return null;
    }) : 0;
    circles.forget(id);
    devices.forget(id);
    zones.forget(id);
    live.forget(id);
    checks?.forget(id);
    // Their answers to road reports and their reliability go; reports they
    // made stay on the map as anybody's.
    await incidents.forget(id).catch((e) => log.error('incidents: erasure failed —', e && e.message ? e.message : e));
    for (const res of told) { try { send(res, 'forget', { id }); } catch { watchers.delete(res); } }
    // Whoever was following them by a link is not left holding an open
    // stream that would carry them again if they ever came back.
    endLive((v) => v.sees === String(id));
    return erased;
  }

  // A live link stopped by its owner: gone from the store, and whoever is
  // following it is told at once rather than at the next reconnect — and why,
  // since "stopped" and "safe" are different things to be told.
  async function stopLink(link, why = 'stopped') {
    await live.revoke(link.token);
    endLive((v) => v.token === link.token, why);
  }

  // Somebody's SOS began or ended: every open map that may see them is sent
  // them afresh, the exact point or the blur as `shown` now decides. Nothing
  // needs forgetting first — what a veiled map fetched of their path was
  // veiled, and stays so either way.
  function resend(id) {
    const key = String(id);
    const p = positions.get(key);
    if (!p) return;
    const payload = { ...p, live: isLive(p) };
    let veiled = null;
    const veil = () => (veiled ??= zones.veil(payload));
    for (const [res, viewer] of watchers) {
      if (!circles.canSee(viewer, key)) continue;
      try { send(res, 'position', shown(viewer, payload, veil)); } catch { watchers.delete(res); }
    }
  }

  // A live link's stream, closed: told why first, so the page can say so
  // rather than trying to reconnect to something that is gone.
  function endLive(which, why = 'ended') {
    for (const [res, v] of watchers) {
      if (v.via !== 'live' || !which(v)) continue;
      watchers.delete(res);
      try { send(res, 'ended', { why }); res.end(); } catch { /* already gone */ }
    }
  }

  // What one viewer is shown of one person.
  //
  // Everything, to themselves and to admins — the same line canActFor draws
  // for erasing or publishing a path. To anybody else who may see them, what
  // their private places leave: the exact point inside one is never sent, so
  // there is nothing under the blur for a curious viewer to find. `veil`
  // works that out, and is passed in when one veiled copy serves many.
  //
  // Except in an emergency. Somebody who raised an SOS asked to be found, and
  // for as long as it runs everybody who may see them is sent where they are
  // — the point, not the path: the way they came stays veiled (sos.js). Every
  // view of them says it is an SOS, and until when.
  //
  // Somebody following a live link sees the person from the moment the link
  // was made and no earlier: the path before it — usually from a front door
  // — was not what was sent.
  function shown(viewer, p, veil = () => zones.veil(p)) {
    const sos = live.sosOf(p.id);
    let view = canActFor(viewer, p.id) ? p : veil();
    if (sos && view.hidden) {
      const { hidden, ...rest } = view;
      view = { ...rest, latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, heading: p.heading };
    }
    if (sos) view = { ...view, sos: sos.expiresAt };
    if (viewer.since !== undefined) {
      view = { ...view, trail: (view.trail || []).filter((q) => q.at >= viewer.since) };
    }
    return view;
  }
  const isLive = (p) => Boolean(p.liveUntil && p.liveUntil > Date.now() / 1000);

  // `about` is the person the event concerns, when there is one. An event
  // about nobody in particular goes to everyone; an event about somebody goes
  // only to the streams whose viewer may see them.
  const broadcast = (event, data, { about = undefined, to = null } = {}) => {
    for (const [res, viewer] of watchers) {
      if (about !== undefined && !circles.canSee(viewer, about)) continue;
      if (to && !to(viewer)) continue;
      try { send(res, event, data); } catch { watchers.delete(res); }
    }
  };

  // Called whenever a position changes; every open map hears about it at once,
  // which is the whole point of doing this over MTProto rather than polling.
  // Two versions at most — exact, and veiled — and the veiled one is only
  // worked out if somebody is going to be sent it.
  const publish = (person) => {
    const exact = { ...person, live: isLive(person) };
    let veiled = null;
    const veil = () => (veiled ??= zones.veil(exact));
    for (const [res, viewer] of watchers) {
      if (!circles.canSee(viewer, person.id)) continue;
      try { send(res, 'position', shown(viewer, exact, veil)); } catch { watchers.delete(res); }
    }
  };

  // A private place made or removed: what a veiled viewer holds about this
  // person may now be wrong in either direction. Their map is told to forget
  // and is sent the person afresh — including the history it had fetched,
  // which the page drops with the rest. The person's own maps are told to
  // redraw their places.
  function republish(id) {
    const key = String(id);
    const p = positions.get(key);
    const payload = p ? { ...p, live: isLive(p) } : null;
    let veiled = null;
    const veil = () => (veiled ??= zones.veil(payload));
    for (const [res, viewer] of watchers) {
      if (!circles.canSee(viewer, key)) continue;
      try {
        if (canActFor(viewer, key)) {
          if (viewer.id === key) send(res, 'zones', { id: key });
          continue;
        }
        send(res, 'forget', { id: key });
        if (payload) send(res, 'position', shown(viewer, payload, veil));
      } catch { watchers.delete(res); }
    }
  }

  // Changing a circle changes what open maps may show, and they should not
  // have to be reloaded to find out. Revoking takes the person off the other
  // viewer's map at once; granting puts them on it.
  async function revoke(owner, viewer) {
    await circles.revoke(owner, viewer);
    for (const [res, v] of watchers) {
      if (v.id === String(viewer) && !circles.canSee(v, owner)) {
        try { send(res, 'forget', { id: String(owner) }); } catch { watchers.delete(res); }
      }
    }
  }

  async function grant(owner, viewer) {
    const done = await circles.grant(owner, viewer);
    const p = done ? positions.get(owner) : null;
    if (p) {
      const payload = { ...p, live: isLive(p) };
      for (const [res, v] of watchers) {
        if (v.id === String(viewer)) { try { send(res, 'position', shown(v, payload)); } catch { watchers.delete(res); } }
      }
    }
    return done;
  }

  // A fence crossed, or somebody's fences changed. Only the fence's owner and
  // admins are told, and a crossing only if they may also see who crossed: a
  // fence is a named place in somebody's life, and "Ada arrived at home" is
  // two private facts, not one.
  //
  // A crossing inside somebody's private place is `exactOnly`: told to them
  // and admins, nobody else. Otherwise a 25 m fence dropped on a guessed
  // doorstep would find exactly what the blur is there to hide.
  const publishFence = (data) => broadcast('fence', data, {
    about: data.person === undefined ? undefined : data.person,
    to: (viewer) => (viewer.admin || (data.owner !== null && data.owner !== undefined && viewer.id === String(data.owner)))
      && (!data.exactOnly || canActFor(viewer, data.person)),
  });

  // Who this request is: { id, admin, via }, or null.
  //
  // Checked on every request rather than once at sign-in, so removing somebody
  // from DASHBOARD_USERS, or /stop, takes effect on their next request rather
  // than whenever their cookie happens to expire.
  const viewerOf = (req, url) => {
    // A watch presents its token as a bearer credential. It is its owner, for
    // reading — see DEVICE_ROUTES for how much less than its owner it may do.
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (bearer) {
      const device = devices.lookup(bearer);
      const owner = device ? circles.viewerFor(device.owner) : null;
      return owner ? { ...owner, via: 'device', device } : null;
    }
    // The `config.dashboardToken &&` is load-bearing: sameToken('', '') is
    // true, so without it an unset token would admit everybody rather than
    // nobody.
    if (config.dashboardToken && sameToken(tokenOf(req.headers.cookie, url), config.dashboardToken)) {
      return { id: null, admin: true, via: 'token' };
    }
    if (!signInOn()) return null;
    const raw = String(req.headers.cookie || '')
      .split(';').map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!raw) return null;
    const id = readSession(decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1)),
      { botToken: config.botToken });
    const viewer = circles.viewerFor(id);
    return viewer ? { ...viewer, via: 'session' } : null;
  };

  const setSession = (res, id, to = '/', also = []) => {
    res.writeHead(302, {
      location: to,
      'cache-control': 'no-store',
      'set-cookie': [
        `${SESSION_COOKIE}=${encodeURIComponent(mint(id, { botToken: config.botToken }))}`
          + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
        ...also,
      ],
    });
    res.end();
  };

  const cookieOf = (req, name) => {
    const hit = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
    if (!hit) return '';
    try { return decodeURIComponent(hit.slice(name.length + 1)); } catch { return ''; }
  };
  // Lax, not Strict: the OpenID callback arrives as a navigation from
  // Telegram, and Strict would withhold exactly the cookie it needs.
  const shortCookie = (name, value, seconds) =>
    `${name}=${encodeURIComponent(value)}; Path=/auth/; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
  const OIDC_TX = 'tll_oidc_tx';
  const OIDC_PENDING = 'tll_oidc';

  // "Sign in with Telegram". Needs the client secret, and circles: the
  // subject Telegram issues is scoped to this site and has to be linked, once,
  // to the id the bot knows — which needs somewhere to keep the link.
  const oidcOn = () => Boolean(config.oidcSecret && config.oidcClientId && circles.enabled && geo);
  const oidcEnv = { TELEGRAM_OIDC_ISSUER: config.oidcIssuer || undefined };
  const redirectUri = (req) => config.oidcRedirect
    || `${config.publicUrl || `http://${req.headers.host || 'localhost'}`}/auth/telegram/callback`;

  const page = (res, status, title, body, cookies = []) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': cookies });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.1rem">${escapeAttr(title)}</h1>${body}</body>`);
  };

  // Every request, answered by `handle`. An exception anywhere in it is a
  // 500 for that request, never the whole process: one bad request — a
  // malformed escape in a path once did it, with nobody signed in — must not
  // take the map down for everyone.
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('request:', e && e.message ? e.message : e);
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('error');
      } catch { /* the connection is already gone */ }
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // The rest of a path after a prefix, decoded — or null when it is not
    // valid percent-encoding, which every route treats as no such thing.
    const after = (prefix) => {
      try { return decodeURIComponent(url.pathname.slice(prefix.length)); } catch { return null; }
    };
    const viewer = viewerOf(req, url);
    const ok = Boolean(viewer);

    // Not "forbidden": that would confirm the person exists. Somebody you may
    // not see answers exactly as somebody who was never there.
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"not found"}');
    };
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    // A browser gets a page explaining how to get in; anything else gets the
    // one line it can act on. Being turned away should not be a dead end.
    const deny = async () => {
      const wantsPage = signInOn() && /text\/html/.test(req.headers.accept || '');
      const page = wantsPage ? await readFile(LOGIN_PAGE, 'utf8').catch(() => null) : null;
      if (page) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page.replace('<body>',
          `<body data-bot="${escapeAttr(botName)}" data-domain="${escapeAttr(config.botDomain || '')}" data-oidc="${oidcOn() ? '1' : ''}">`));
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(signInOn()
        ? '401 — send /login to the bot for a link that opens this'
        : '401 — append ?token=… to the URL');
    };

    // /healthz is deliberately before this: the rollout's health check runs on
    // the server itself, over loopback, and has no key to present. It reports
    // counts and nothing else.
    if (url.pathname === '/healthz') {
      // Whether the database is there too: a service that came up without it
      // answers, but with circles, private places and history all off, and
      // the rollout should be able to tell that from a healthy one.
      const database = typeof geo?.state === 'function' ? geo.state()
        : (geo && geo.enabled && geo.enabled() ? 'connected' : 'off');
      // And where the bot's links point: PUBLIC_URL, the quick tunnel, or
      // nowhere — the source, never the address, since this answers anybody.
      if (address) await address.get();
      const linksTo = address ? address.source() : (config.publicUrl ? 'PUBLIC_URL' : 'none');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, watching: watchers.size, people: positions.list().length, database, address: linksTo }));
      return;
    }

    // Answer only the edge, when an edge has been configured. This is what
    // makes binding to a public interface safe enough to do: a scanner that
    // finds the port gets nothing, without having to guess the dashboard
    // token to find that out.
    if (config.edgeKey && !sameToken(req.headers['x-edge-key'] || '', config.edgeKey)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('403');
      return;
    }

    // Signing in necessarily happens before there is anything to sign in
    // with, so these sit ahead of the gate rather than behind it.
    // A watch pairing itself. Before the gate, because the code *is* how it
    // gets in; limited, because six digits can be guessed.
    if (url.pathname === '/api/devices/pair' && req.method === 'POST') {
      if (!devices.enabled) return json(404, { error: 'not found' });
      const { body, error, status } = await readJson(req, { limit: 4096 });
      if (error) return json(status, { error });
      // Behind the edge the peer is Cloudflare; its header is only believed
      // when the edge proved itself with the key.
      const address = (config.edgeKey && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || 'unknown';
      const got = codes.redeem(body.code, address);
      if (got?.limited) return json(429, { error: 'too many wrong codes — ask for a new one and try again later' });
      if (!got) return json(404, { error: 'that code is wrong or has expired' });
      const person = circles.viewerFor(got.owner);
      if (!person) return json(404, { error: 'that code is wrong or has expired' });
      const made = await devices.pair({ owner: got.owner, name: body.name, platform: body.platform });
      log.info('devices: a watch was paired');
      return json(200, { token: made.token, id: made.id, owner: { id: got.owner, name: circles.user(got.owner)?.name || '' } });
    }

    // Signing out needs no sign-in to reach, and clears only this browser.
    if (url.pathname === '/auth/logout') {
      res.writeHead(302, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': [
          `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        ],
      });
      res.end();
      return;
    }

    if (url.pathname === '/auth/telegram/start') {
      if (!oidcOn()) return json(404, { error: 'not found' });
      const discovery = await getDiscovery(oidcEnv).catch((e) => { log.error('oidc:', e.message); return null; });
      if (!discovery) return page(res, 503, 'Telegram sign-in is unavailable', '<p>Telegram could not be reached. Try /login in the bot instead.</p>');
      const state = randomToken(24);
      const nonce = randomToken(24);
      const verifier = randomToken(32);
      const to = new URL(discovery.authorization_endpoint);
      to.searchParams.set('response_type', 'code');
      to.searchParams.set('client_id', config.oidcClientId);
      to.searchParams.set('redirect_uri', redirectUri(req));
      to.searchParams.set('scope', config.oidcScope);
      to.searchParams.set('state', state);
      to.searchParams.set('nonce', nonce);
      to.searchParams.set('code_challenge', await codeChallenge(verifier));
      to.searchParams.set('code_challenge_method', 'S256');
      res.writeHead(302, {
        location: to.toString(),
        'cache-control': 'no-store',
        'set-cookie': shortCookie(OIDC_TX, seal('oidc-tx', { state, nonce, verifier }, 600, config.oidcSecret), 600),
      });
      res.end();
      return;
    }

    if (url.pathname === '/auth/telegram/callback') {
      if (!oidcOn()) return json(404, { error: 'not found' });
      const dropTx = shortCookie(OIDC_TX, '', 0);
      const fail = (why) => page(res, 400, 'Sign-in did not work', `<p>${escapeAttr(why)}</p><p><a href="/">Try again</a>, or send /login to the bot.</p>`, [dropTx]);
      if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || url.searchParams.get('error'));
      const tx = unseal('oidc-tx', cookieOf(req, OIDC_TX), config.oidcSecret);
      // A missing or mismatched state is either an expired attempt or a
      // forged callback, and the answer to both is to start again.
      if (!tx || tx.state !== url.searchParams.get('state') || !url.searchParams.get('code')) {
        return fail('That sign-in expired or did not match. Please start again.');
      }
      let user;
      try {
        const discovery = await getDiscovery(oidcEnv);
        const tokens = await exchangeCode({
          tokenEndpoint: discovery.token_endpoint,
          code: url.searchParams.get('code'),
          codeVerifier: tx.verifier,
          redirectUri: redirectUri(req),
          clientId: config.oidcClientId,
          clientSecret: config.oidcSecret,
        });
        const claims = await verifyIdToken(tokens.id_token, {
          jwksUri: discovery.jwks_uri, issuer: issuerFor(oidcEnv), clientId: config.oidcClientId, nonce: tx.nonce,
        });
        // The claim *names*, never their values: enough to tell from the logs
        // whether Telegram ever sends the bot-visible id, which would make the
        // linking step below unnecessary.
        log.info(`oidc: claims received — ${Object.keys(claims).sort().join(', ')}`);
        user = userFromClaims(claims);
      } catch (e) {
        log.error('oidc: callback failed —', e.message);
        return fail('Telegram’s answer could not be verified.');
      }
      if (!user.id) return fail('Telegram did not say who you are.');

      const linked = await geo.userBySub(user.id);
      if (linked && circles.viewerFor(linked)) {
        log.info('login: somebody signed in with Telegram');
        return setSession(res, linked, '/', [dropTx]);
      }
      // The first time only. Telegram's subject for this site is not the id
      // the bot knows, so it is carried, sealed, until this browser opens a
      // /login link — which proves the Telegram account the bot knows. Both
      // proofs in one browser are the same person. It adds nothing to steal:
      // somebody holding your /login link can already sign in as you.
      const pending = seal('oidc-pending', { sub: user.id, name: user.firstName || '' }, 900, config.oidcSecret);
      return page(res, 200, 'One more step, the first time', `
<p>Telegram has confirmed who you are. To connect that to your place on the map:</p>
<ol><li>Open ${botName ? '<b>@' + escapeAttr(botName) + '</b>' : 'the bot'} in Telegram and send <code>/login</code>.</li>
<li>Open the link it sends <b>in this browser</b>, within fifteen minutes.</li></ol>
<p>After that, “Sign in with Telegram” takes you straight in.</p>`,
      [dropTx, shortCookie(OIDC_PENDING, pending, 900)]);
    }

    if (signInOn() && url.pathname.startsWith('/auth/')) {
      const refuse = (why) => {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(why);
      };

      // The widget's reply, which Telegram signs. Off unless a domain has
      // been registered for the bot, because without one the button cannot
      // appear in the first place.
      if (url.pathname === '/auth/widget') {
        if (!config.botDomain) return refuse('the login widget is not configured');
        const fields = Object.fromEntries(url.searchParams.entries());
        const id = checkWidget(fields, { botToken: config.botToken });
        if (!id) return refuse('that sign-in did not verify');
        // The widget's id is the real Telegram id, so somebody the bot has not
        // met yet can be recorded here and see themselves from the start.
        await circles.seen({
          id,
          name: [fields.first_name, fields.last_name].filter(Boolean).join(' '),
          username: fields.username || '',
        });
        if (!circles.viewerFor(id)) return refuse('that account cannot sign in here');
        log.info('login: somebody signed in with the widget');
        return setSession(res, id);
      }

      // A one-time link from the bot. Single use and short-lived, because a
      // link sits in a chat history where somebody else may read it.
      //
      // Opening it is not using it. Telegram — like every chat app — fetches
      // the links in a message to make a preview, with a GET, and a GET that
      // used the link up left nothing for the person who tapped it: "used
      // already" on the first try. So a GET only answers with a page that
      // sends the link back as a POST, at once by script or by its button
      // without one, and only the POST signs in. A previewer does neither.
      const token = url.pathname.slice('/auth/'.length);
      if (req.method !== 'POST') {
        if (!links.peek(token)) return refuse('that link has been used already, or has expired — send /login again');
        return page(res, 200, 'Signing you in…', `
<form method="post" action="/auth/${escapeAttr(token)}"><button type="submit">Sign in</button></form>
<script>document.forms[0].submit();</script>`);
      }
      const id = links.redeem(token);
      if (!id) return refuse('that link has been used already, or has expired — send /login again');
      if (!circles.viewerFor(id)) return refuse('that account cannot sign in here');
      log.info('login: somebody signed in through the bot');
      // A Telegram sign-in waiting in this browser is linked to the account
      // this link belongs to, and not asked for again.
      const waiting = oidcOn() ? unseal('oidc-pending', cookieOf(req, OIDC_PENDING), config.oidcSecret) : null;
      if (waiting?.sub) {
        await geo.linkSub(id, waiting.sub).catch((e) => log.error('oidc: cannot link —', e.message));
        log.info('login: a Telegram sign-in was linked');
      }
      return setSession(res, id, '/', waiting ? [shortCookie(OIDC_PENDING, '', 0)] : []);
    }

    // Leaflet is a public library and a share page needs it, so it is not
    // behind the dashboard token. It carries no data. /lib/ is the same for
    // code of our own that both pages load — arithmetic, not information.
    if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/lib/')) return serveStatic(url, req, res);

    // A share link is a second key, and a far narrower one: it opens the
    // viewer, the one path behind it, and the tiles that page draws on.
    // Nothing else, and only until it expires.
    const shareToken = url.pathname.startsWith('/share/')
      ? url.pathname.slice('/share/'.length)
      : (url.pathname.startsWith('/api/shared/')
        ? url.pathname.slice('/api/shared/'.length)
        : url.searchParams.get('s') || '');

    if (url.pathname.startsWith('/share/')) {
      if (!(await validShare(shareToken))) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such share'); return; }
      const html = await readFile(SHARE_PAGE, 'utf8').catch(() => null);
      if (!html) { res.writeHead(500); res.end('missing page'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname.startsWith('/api/shared/')) {
      const shared = (await validShare(shareToken)) && geo ? await geo.readShare(shareToken) : null;
      // Private places made after the link was sent still apply to it: hiding
      // home should not depend on remembering every link ever handed out.
      const points = shared ? zones.veilPoints(shared.person, withBreaks(
        shared.points.map(([latitude, longitude], i) => ({ latitude, longitude, at: shared.times ? shared.times[i] : null })),
        shared.breaks,
      )) : [];
      if (points.length < 2) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"gone"}'); return; }
      if (url.searchParams.get('format') === 'gpx') {
        const first = points.find((q) => q.at !== null)?.at ?? shared.at;
        res.writeHead(200, {
          'content-type': 'application/gpx+xml; charset=utf-8',
          'content-disposition': contentDisposition(shared.name, dayOf(first)),
          'cache-control': 'no-store',
        });
        res.end(toGpx({ name: shared.name ? `${shared.name}’s path` : 'A shared path', points: splitAtPauses(points), time: first }));
        return;
      }
      // Field by field: `person` is for this server, not for whoever holds
      // the link.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        name: shared.name,
        at: shared.at,
        points: points.map((q) => [q.latitude, q.longitude]),
        times: shared.times ? points.map((q) => q.at) : null,
        breaks: breaksOf(points),
      }));
      return;
    }

    // A live link: one person, followed as they move, for as long as the link
    // lasts. Like a share link it is a key of its own — to this page, to one
    // stream, and to the tiles the page draws on — and to nothing else. The
    // viewer it makes exists only inside that stream.
    if (url.pathname.startsWith('/live/')) {
      if (!live.get(url.pathname.slice('/live/'.length))) {
        return page(res, 404, 'This link has ended',
          '<p>It ran out, or the person who sent it stopped it. Ask them for a new one.</p>');
      }
      const html = await readFile(LIVE_PAGE, 'utf8').catch(() => null);
      if (!html) { res.writeHead(500); res.end('missing page'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname.startsWith('/api/live-stream/')) {
      const link = live.get(after('/api/live-stream/'));
      if (!link) return json(404, { error: 'ended' });
      const follower = { id: null, admin: false, via: 'live', sees: link.person, since: link.createdAt, token: link.token };
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      });
      watchers.set(res, follower);
      const p = positions.get(link.person);
      send(res, 'hello', {
        name: circles.user(link.person)?.name || p?.name || '',
        until: link.expiresAt,
        people: p ? [shown(follower, { ...p, live: isLive(p) })] : [],
      });
      const beat = setInterval(() => { try { send(res, 'beat', {}); } catch { /* gone */ } }, 25000);
      // The link's own deadline, kept by the stream: nothing else would come
      // along at that moment to close it.
      const until = setTimeout(() => endLive((v) => v === follower), Math.max(0, link.expiresAt * 1000 - Date.now()));
      const done = () => { clearInterval(beat); clearTimeout(until); watchers.delete(res); };
      req.on('close', done);
      res.on('close', done);
      return;
    }

    // Tiles for a share page or a live one. A share is checked against the
    // database once and then remembered, because a map draws dozens of tiles
    // and none of them should cost a query; live links are in memory anyway.
    const tileForShare = parseTilePath(url.pathname) && shareToken
      && (Boolean(live.get(shareToken)) || await validShare(shareToken));

    if (!ok && !tileForShare) return deny();
    // A share page's tiles, admitted by the share token alone, with nobody
    // signed in behind them. Served here, so that nothing below — all of which
    // is about a viewer — ever runs without one. (It once did: the check that
    // keeps a watch to its allowance read `viewer.via` on nobody, and every
    // share page took the server down with its first tile.)
    if (!ok) return serveTile(parseTilePath(url.pathname), res);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(PAGE, 'utf8').catch(() => null);
      if (!html) { res.writeHead(500); res.end('missing page'); return; }
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      // Remembered so the token is not needed in every later request, and so
      // it stops being visible in the address bar after the first load — but
      // only for somebody who came in *with* the token. Handed to everyone who
      // reached this page, it would give a person signed in as themselves the
      // admin key on their very next request.
      if (viewer.via === 'token') {
        headers['set-cookie'] = `${COOKIE}=${encodeURIComponent(config.dashboardToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
      }
      res.writeHead(200, headers);
      res.end(html);
      return;
    }

    // A watch is its owner for reading and for reporting where it is, and for
    // nothing else. A token on a wrist can be lost with the wrist; it must
    // not be able to erase anybody, publish a path, or change a circle.
    if (viewer.via === 'device') {
      const allowed = url.pathname === '/api/ingest'
        || (req.method === 'GET' && (DEVICE_READS.has(url.pathname)
          || DEVICE_READ_PREFIXES.some((pre) => url.pathname.startsWith(pre))
          || parseTilePath(url.pathname)
          || parseCartoPath(url.pathname) || parseVectorPath(url.pathname)))
        || (url.pathname === '/api/stream' && req.method === 'POST');
      if (!allowed) return notFound();
    }

    const visible = () => positions.list()
      .filter((p) => circles.canSee(viewer, p.id))
      .map((p) => shown(viewer, p));

    // Where a watch says it is. Only a watch may say it, and only as itself.
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      if (viewer.via !== 'device') return notFound();
      const { body, error, status } = await readJson(req);
      if (error) return json(status, { error });
      const fixes = readFixes(body);
      if (fixes.length > MAX_BATCH) return json(413, { error: `at most ${MAX_BATCH} fixes at a time` });
      const now = Math.floor(Date.now() / 1000);
      const name = circles.user(viewer.device.owner)?.name || '';
      const accepted = [];
      const rejected = [];
      fixes.forEach((fix, index) => {
        const r = fromDevice(fix, { owner: viewer.device.owner, name, now });
        if (r.position) accepted.push(r.position); else rejected.push({ index, error: r.error });
      });
      devices.touch(viewer.device);
      if (accepted.length && onIngest) await onIngest(accepted, viewer.device);
      return json(200, { accepted: accepted.length, rejected });
    }

    // ------------------------------------------------------------ devices
    if (url.pathname === '/api/devices/code' && req.method === 'POST') {
      if (!devices.enabled || !viewer.id || viewer.via === 'device') return notFound();
      return json(200, { code: codes.issue(viewer.id), expiresIn: 300 });
    }
    if (url.pathname === '/api/devices' && req.method === 'GET') {
      if (!devices.enabled || !viewer.id) return notFound();
      return json(200, { devices: devices.list(viewer.id) });
    }
    if (url.pathname.startsWith('/api/devices/') && req.method === 'DELETE') {
      const id = url.pathname.slice('/api/devices/'.length);
      const owner = devices.enabled ? devices.ownerOf(id) : undefined;
      if (owner === undefined || !(viewer.admin || owner === viewer.id)) return notFound();
      await devices.remove(id);
      return json(200, { devices: devices.list(viewer.id) });
    }

    // Who this is, for the page: whether to offer a circle, a share button.
    if (url.pathname === '/api/me') {
      const me = viewer.id ? circles.user(viewer.id) : null;
      return json(200, {
        id: viewer.id,
        admin: viewer.admin,
        name: me?.name || '',
        circles: circles.enabled && Boolean(viewer.id),
        // Whether Follow me can work: yourself, with somewhere to keep links.
        live: live.enabled && Boolean(viewer.id) && viewer.via !== 'device',
        // Likewise Check on me, and until when one is running.
        checks: Boolean(checks && checks.enabled) && Boolean(viewer.id) && viewer.via !== 'device',
        check: (viewer.id && checks?.get(viewer.id)?.until) || null,
        checkStop: checks?.stopMinutes || 15,
      });
    }

    if (url.pathname === '/api/positions') {
      return json(200, { people: visible() });
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // no-transform asks the middle of the internet not to recompress this.
        // Compression implies buffering, and a buffered stream is not one.
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',   // nginx would otherwise hold the stream
      });
      // No `connection: keep-alive` here: it is the HTTP/1.1 default and Node
      // sends it regardless, so setting it said nothing. It is forbidden in
      // HTTP/2, but a gateway is required to strip it on the way, so this is
      // tidying rather than a fix for anything.
      watchers.set(res, viewer);
      send(res, 'hello', { people: visible() });
      // A named event rather than a bare `: comment`, which costs a few bytes
      // and buys the page the ability to tell a quiet stream from a stalled
      // one: EventSource never surfaces comments to JavaScript, so a stream
      // that silently stopped delivering looked exactly like nobody moving.
      const beat = setInterval(() => { try { send(res, 'beat', {}); } catch { /* gone */ } }, 25000);
      req.on('close', () => { clearInterval(beat); watchers.delete(res); });
      return;
    }

    if(url.pathname==='/api/map-config')return json(200,{relief:terrain.enabled});
    const elevation=parseTerrainPath(url.pathname);
    if(elevation){
      const got=await terrain.get(elevation);
      if(!got){res.writeHead(503,{'content-type':'text/plain','cache-control':'private, max-age=60','retry-after':'60'});res.end('relief unavailable');return;}
      res.writeHead(200,{'content-type':'image/png','cache-control':'private, max-age=2592000','x-terrain-source':got.from});res.end(got.bytes);return;
    }

    // Styled vector geometry, local OSM first then the cached worldwide source.
    // It is deliberately
    // guarded like raster tiles: this service is not a public map-tile host.
    const vector = parseVectorPath(url.pathname);
    if (vector) {
      const layers = parseVectorLayers(url.searchParams.get('layers'));
      if (layers === null) return json(400, { error: 'unknown cartography layer' });
      let got = (geo?.vectorTile && await geo.vectorTile(vector.z, vector.x, vector.y, layers)) || EMPTY_VECTOR;
      if(got.empty && layers.length) got = await worldVector.tile(vector.z, vector.x, vector.y, layers);
      const compressed = (req.headers['accept-encoding'] || '').split(',').some((item) => {
        const [name, quality] = item.trim().split(';');
        return name === 'gzip' && (!quality || Number(quality.trim().replace(/^q=/, '')) > 0);
      });
      res.writeHead(200, {
        'content-type': 'application/vnd.mapbox-vector-tile',
        'cache-control': got.empty ? 'private, max-age=30' : 'private, max-age=300',
        'x-carto-source': got.empty ? 'empty' : got.source || 'postgis',
        'vary': 'Accept-Encoding',
        ...(compressed ? { 'content-encoding': 'gzip' } : {}),
      });
      res.end(compressed ? got.gzip : got.raw);
      return;
    }
    const carto = parseCartoPath(url.pathname);
    if (carto) {
      const layers = parseCartographyLayers(url.searchParams.get('layers'));
      if (layers === null) return json(400, { error: 'unknown cartography layer' });
      return serveCartography(carto, res, layers);
    }

    // The basemap. Guarded like everything else, so this cannot be used as
    // somebody else's free tile proxy.
    const tile = parseTilePath(url.pathname);
    if (tile) return serveTile(tile, res);

    // What is at a point. Asked per person by the page, which rounds the
    // coordinates before asking, so someone standing still asks once.
    if (url.pathname === '/api/place') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      const place = geo ? await geo.placeOf(lat, lon) : '';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ place }));
      return;
    }

    // The name of where the middle of the map is, for the corner of the map
    // (district.js). Asked once the map has settled. The coordinates are
    // where somebody is looking, so they are never logged.
    if (url.pathname === '/api/district') {
      const num = (key) => {
        const v = url.searchParams.get(key);
        return v === null || v.trim() === '' ? NaN : Number(v);
      };
      const lat = num('lat');
      const lon = num('lon');
      const zoom = num('z');
      if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon) || !(zoom >= 0 && zoom <= 24)) {
        return json(400, { error: 'lat, lon and z are needed' });
      }
      // Leaflet's longitude keeps counting past the dateline.
      const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
      const [lines, street] = await Promise.all([
        districts.at(lat, wrapped, zoom).catch(() => []),
        districts.street ? districts.street(lat, wrapped, zoom).catch(() => '') : '',
      ]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=300' });
      res.end(JSON.stringify({ lines, street }));
      return;
    }

    // Road reports (incidents.js). Everybody who can sign in sees every one,
    // and none says who made it: reporting one says so before it is sent.
    // What a viewer does here, they do as themselves — the shared token as
    // one more reporter.
    const reporter = viewer.id ?? 'dashboard';
    const toMaps = { to: (v) => v.via !== 'device' };
    if (url.pathname === '/api/incidents') {
      if (req.method === 'GET') return json(200, { incidents: incidents.list(reporter) });
      if (req.method !== 'POST') return notFound();
      const num = (k) => {
        const v = url.searchParams.get(k);
        return v === null || v.trim() === '' ? NaN : Number(v);
      };
      const made = await incidents.report(reporter, {
        kind: url.searchParams.get('kind'), detail: url.searchParams.get('detail') || '',
        latitude: num('lat'), longitude: num('lon'),
      });
      if (made.error) return json(made.status || 400, { error: made.error });
      broadcast('incidents', {}, toMaps);
      return json(200, made);
    }
    if (url.pathname.startsWith('/api/incidents/')) {
      const id = Number(after('/api/incidents/'));
      if (!Number.isInteger(id) || id <= 0) return notFound();
      if (req.method === 'POST') {
        const got = await incidents.answer(reporter, id, url.searchParams.get('answer'));
        if (got.error) return json(got.status || 400, { error: got.error });
        if (!got.again) broadcast('incidents', {}, toMaps);
        return json(200, got);
      }
      // Your own, while nobody else has backed it.
      if (req.method === 'DELETE') {
        if (!(await incidents.withdraw(reporter, id))) return notFound();
        broadcast('incidents', {}, toMaps);
        return json(200, { ok: true });
      }
      return notFound();
    }

    // Where someone has been. Empty rather than an error when nothing is
    // recorded, so the page does not need to know whether PostGIS is there.
    if (url.pathname.startsWith('/api/history/')) {
      const id = after('/api/history/');
      if (!circles.canSee(viewer, id)) return notFound();
      // A window, because a path drawn across a week is a tangle nobody reads.
      const since = Number(url.searchParams.get('since'));
      const stored = geo
        ? await geo.historyOf(id, { limit: 1000, since: Number.isFinite(since) && since > 0 ? since : null })
        : [];
      // Without the fixes the phone got wrong (track.js), which the table
      // keeps as they came.
      const recorded = cleanTrack([...stored].reverse()).reverse();
      // Newest first either way; the veiled one has its hidden stretches
      // taken out and the fix after each marked as a gap.
      const points = canActFor(viewer, id) ? recorded : zones.veilPoints(id, recorded).reverse();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ id, points }));
      return;
    }

    // A day of your own path as GPX, for Strava, Garmin or your own records.
    // Yours, or an admin's call: a circle sees a path on the map, but a file
    // made to be kept is for the person who walked it.
    if (url.pathname.startsWith('/api/gpx/') && req.method === 'GET') {
      const id = after('/api/gpx/');
      if (!canActFor(viewer, id)) return notFound();
      if (!geo || !geo.enabled()) return json(503, { error: 'no database' });
      const nowS = Math.floor(Date.now() / 1000);
      const to = Number(url.searchParams.get('to')) || nowS;
      const from = Number(url.searchParams.get('from')) || to - 86400;
      if (!(to > from) || to - from > GPX_WINDOW) return json(400, { error: 'a window of at most seven days' });
      const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0));
      const recorded = await geo.historyOf(id, { since: from - 1, until: to, limit: GPX_MAX + 1 });
      if (recorded.length > GPX_MAX) return json(413, { error: 'more than 50,000 fixes in that window — pick a shorter one' });
      if (!recorded.length) return json(404, { error: 'nothing recorded then' });
      const name = circles.user(id)?.name || positions.get(id)?.name || '';
      const day = dayOf(from, tz);
      res.writeHead(200, {
        'content-type': 'application/gpx+xml; charset=utf-8',
        'content-disposition': contentDisposition(name, day),
        'cache-control': 'no-store',
      });
      res.end(toGpx({ name: `${name || 'Path'} — ${day}`, points: splitAtPauses(cleanTrack([...recorded].reverse())), time: from }));
      return;
    }

    // Hand one person's path to somebody who does not have the dashboard.
    if (url.pathname.startsWith('/api/share/') && req.method === 'POST') {
      const id = after('/api/share/');
      // Your own path, or an admin's call. Being allowed to see somebody is
      // not their consent to have their movements published to the world.
      if (!canActFor(viewer, id)) return notFound();
      const person = positions.get(id);
      const points = (person?.trail || []).filter((t) => t.latitude !== null);
      if (!geo || !geo.enabled()) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"no database"}'); return; }
      if (points.length < 2) { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"no path yet"}'); return; }
      // What the world gets is what the circle gets, less a few hundred
      // metres at each end: a path usually starts or ends at somebody's door,
      // and a share should never show which one.
      const shown = trimEnds(zones.veilPoints(id, points), trimLengths());
      if (shown.length < 2) return json(409, { error: 'too short to share without its ends' });

      const token = randomBytes(18).toString('base64url');
      const made = await geo.createShare({
        token, person: id, name: person.name || '', points: shown, breaks: breaksOf(shown), ttlSeconds: config.shareTtl,
      }).catch((e) => { log.error('share:', e && e.message ? e.message : e); return false; });
      if (!made) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"could not share"}'); return; }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ token, path: `/share/${token}`, expiresIn: config.shareTtl }));
      return;
    }

    if (url.pathname.startsWith('/api/share/') && req.method === 'DELETE') {
      const token = after('/api/share/');
      const whose = geo ? await geo.shareOwner(token) : null;
      if (!whose || !canActFor(viewer, whose)) return notFound();
      const gone = await geo.revokeShare(token);
      shareCache.delete(token);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked: gone }));
      return;
    }

    // Who a numeric id belongs to. Asked on hover, so it must be cheap: the
    // directory caches, and answers "unknown" rather than blocking when
    // Telegram cannot say.
    if (url.pathname.startsWith('/api/person/')) {
      const id = after('/api/person/');
      if (!circles.canSee(viewer, id)) return notFound();
      const person = directory
        ? await directory.lookup(id)
        : { id, name: '', username: '', photo: false };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(person));
      return;
    }

    // The profile photo, fetched only when someone opens a card — there is no
    // reason to pull every face just to draw dots on a map.
    if (url.pathname.startsWith('/api/photo/')) {
      const id = after('/api/photo/');
      if (!circles.canSee(viewer, id)) return notFound();
      const bytes = directory ? await directory.photo(id) : null;
      if (!bytes || !bytes.length) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no photo');
        return;
      }
      // Private and short: this is a picture of a person, behind the token.
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300' });
      res.end(bytes);
      return;
    }

    // Fences. Parameters ride in the query string rather than a JSON body,
    // which is how every other write here works — adding a body reader would
    // mean size limits and content types for the sake of four values.
    if (url.pathname === '/api/fences') {
      if (!geo || !geo.enabled()) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"no database"}');
        return;
      }
      if (req.method === 'POST') {
        const name = (url.searchParams.get('name') || '').trim().slice(0, 80);
        const latitude = Number(url.searchParams.get('lat'));
        const longitude = Number(url.searchParams.get('lon'));
        const radius = Number(url.searchParams.get('radius'));
        // A fence with no name cannot be announced usefully, and one of no
        // size or of absurd size is a mistake rather than an intention.
        const sane = name
          && Number.isFinite(latitude) && Math.abs(latitude) <= 90
          && Number.isFinite(longitude) && Math.abs(longitude) <= 180
          && Number.isFinite(radius) && radius >= 25 && radius <= 50_000;
        if (!sane) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"need a name, a point, and a radius between 25m and 50km"}');
          return;
        }
        // A person's fences are theirs; the shared token's are nobody's, which
        // only admins see. Capped, because every fence is tested against every
        // position and nobody needs fifty.
        const owner = viewer.id;
        if (owner && !viewer.admin && (await geo.countFences(owner)) >= 50) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end('{"error":"fifty fences is the limit"}');
          return;
        }
        const id = await geo.createFence({ name, latitude, longitude, radius, owner })
          .catch((e) => { log.error('fence:', e && e.message ? e.message : e); return null; });
        if (id === null) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"could not create"}');
          return;
        }
        publishFence({ changed: true, owner });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }
      const fences = await geo.listFences(viewer.admin ? {} : { owner: viewer.id }).catch(() => []);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ fences }));
      return;
    }

    if (url.pathname.startsWith('/api/fences/') && req.method === 'DELETE') {
      const id = Number(url.pathname.slice('/api/fences/'.length));
      if (!geo || !geo.enabled() || !Number.isFinite(id)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"no such fence"}');
        return;
      }
      const owner = await geo.fenceOwner(id).catch(() => undefined);
      // Yours, or an admin's call; anybody else's reads as no such fence.
      if (owner === undefined || !(viewer.admin || (owner !== null && owner === viewer.id))) return notFound();
      const gone = await geo.deleteFence(id).catch(() => 0);
      // The watcher holds state per person and fence; leaving it behind would
      // mean a recreated fence inherited somebody's old position.
      onFenceDeleted?.(id);
      publishFence({ changed: true, owner });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: gone }));
      return;
    }

    // ----------------------------------------------------- private places
    //
    // Your own, and nobody else's: another person's places are exactly what
    // these exist to keep from you. The shared token has nobody behind it to
    // hide, and a watch is not on the list of what it may do.
    if (url.pathname === '/api/zones' || url.pathname.startsWith('/api/zones/')) {
      if (!zones.enabled || !viewer.id) return notFound();
      const me = viewer.id;
      // The rows below reference the user, and an admin named in
      // DASHBOARD_USERS may never have written to the bot.
      if (!circles.user(me)) await circles.seen({ id: me });

      if (url.pathname === '/api/zones' && req.method === 'GET') {
        return json(200, { zones: zones.of(me) });
      }
      if (url.pathname === '/api/zones' && req.method === 'POST') {
        const name = (url.searchParams.get('name') || '').trim().slice(0, 80);
        const latitude = Number(url.searchParams.get('lat'));
        const longitude = Number(url.searchParams.get('lon'));
        const radius = Number(url.searchParams.get('radius'));
        const sane = Number.isFinite(latitude) && Math.abs(latitude) <= 90
          && Number.isFinite(longitude) && Math.abs(longitude) <= 180
          && Number.isFinite(radius) && radius >= ZONE_MIN && radius <= ZONE_MAX;
        if (!sane) return json(400, { error: `need a point and a radius between ${ZONE_MIN} m and ${ZONE_MAX / 1000} km` });
        if (zones.of(me).length >= ZONES_EACH) return json(409, { error: `${ZONES_EACH} private places is the limit` });
        const zone = await zones.create({ owner: me, name, latitude, longitude, radius })
          .catch((e) => { log.error('zones:', e && e.message ? e.message : e); return null; });
        if (!zone) return json(500, { error: 'could not save that place' });
        republish(me);
        return json(200, { zone, zones: zones.of(me) });
      }
      if (url.pathname.startsWith('/api/zones/') && req.method === 'DELETE') {
        const gone = await zones.remove(me, Number(url.pathname.slice('/api/zones/'.length)))
          .catch(() => false);
        if (!gone) return notFound();
        republish(me);
        return json(200, { zones: zones.of(me) });
      }
      return notFound();
    }

    // --------------------------------------------------------- live links
    //
    // Made for yourself, and only by yourself. Being allowed to see somebody
    // is not their consent to be followed by whoever you pass a link to, and
    // a watch — a token on a wrist, which can be lost with the wrist — may not
    // hand out a way to follow its owner.
    if (url.pathname === '/api/live' || url.pathname.startsWith('/api/live/')) {
      if (!live.enabled || !viewer.id || viewer.via === 'device') return notFound();
      const me = viewer.id;
      // The row references the user, and an admin named in DASHBOARD_USERS
      // may never have written to the bot.
      if (!circles.user(me)) await circles.seen({ id: me });

      if (url.pathname === '/api/live' && req.method === 'GET') {
        return json(200, { links: live.of(me).map(describeLink) });
      }
      if (url.pathname === '/api/live' && req.method === 'POST') {
        const minutes = Number(url.searchParams.get('minutes') || 60);
        if (!LIVE_MINUTES.includes(minutes)) return json(400, { error: `for ${LIVE_MINUTES.join(', ')} minutes` });
        if (live.of(me).filter((l) => l.reason === 'share').length >= LIVE_EACH) {
          return json(409, { error: `${LIVE_EACH} live links at once is the limit — stop one first` });
        }
        const link = await live.create({ person: me, minutes })
          .catch((e) => { log.error('live:', e && e.message ? e.message : e); return null; });
        if (!link) return json(500, { error: 'could not make a link' });
        return json(200, describeLink(link));
      }
      if (url.pathname.startsWith('/api/live/') && req.method === 'DELETE') {
        const link = live.get(after('/api/live/'));
        // Yours, or an admin's call; anybody else's reads as no such link.
        if (!link || !canActFor(viewer, link.person)) return notFound();
        // Stopping an SOS's link is ending the SOS, and everybody who was
        // told about it is told that too.
        if (link.reason === 'sos' && sos) await sos.end(link.person);
        else await stopLink(link);
        return json(200, { links: live.of(me).map(describeLink) });
      }
      return notFound();
    }

    // An SOS from the map: the same act as /sos to the bot, through the same
    // code. Yours only — nobody raises one for somebody else — and not from a
    // watch's token, which cannot hand out a way to follow its owner.
    if (url.pathname === '/api/sos') {
      if (!sos || !live.enabled || !viewer.id || viewer.via === 'device') return notFound();
      if (!circles.user(viewer.id)) await circles.seen({ id: viewer.id });
      if (req.method === 'POST') {
        const raised = await sos.raise(viewer.id)
          .catch((e) => { log.error('sos:', e && e.message ? e.message : e); return null; });
        if (!raised) return json(500, { error: 'could not raise an SOS' });
        return json(200, {
          told: raised.told, circle: raised.circle, again: raised.again, recent: Boolean(raised.recent), call: raised.call,
          path: `/live/${raised.link.token}`, until: raised.link.expiresAt,
        });
      }
      if (req.method === 'DELETE') return json(200, { ended: await sos.end(viewer.id) });
      return notFound();
    }

    // Check on me, from the map: the same as /checkon and /checkoff.
    // Yours only, and not from a watch's token.
    if (url.pathname === '/api/check') {
      if (!checks || !checks.enabled || !viewer.id || viewer.via === 'device') return notFound();
      const me = viewer.id;
      if (req.method === 'GET') return json(200, { until: checks.get(me)?.until ?? null });
      if (req.method === 'POST') {
        const hours = Number(url.searchParams.get('hours') || 2);
        if (!CHECK_HOURS.includes(hours)) return json(400, { error: `for ${CHECK_HOURS.join(', ')} hours` });
        const started = await checks.start(me, hours)
          .catch((e) => { log.error('check:', e && e.message ? e.message : e); return { error: 'could not start checking' }; });
        if (started.error) return json(409, { error: started.error });
        return json(200, { until: started.check.until, circle: started.circle });
      }
      if (req.method === 'DELETE') return json(200, { ended: await checks.stop(me) });
      return notFound();
    }

    // ------------------------------------------------------------ circles
    //
    // Only for a person signed in as themselves: the shared token has nobody
    // behind it to be seen, or to see.
    if (url.pathname === '/api/circle' || url.pathname.startsWith('/api/circle/')) {
      if (!circles.enabled || !viewer.id) return notFound();
      const me = viewer.id;

      if (url.pathname === '/api/circle' && req.method === 'GET') {
        return json(200, circles.circleOf(me));
      }
      // A link that lets whoever opens it see you. Made here or with /invite.
      if (url.pathname === '/api/circle/invite' && req.method === 'POST') {
        const link = makeInvite ? await makeInvite(me) : null;
        return link ? json(200, { link }) : json(503, { error: 'invites need the bot' });
      }
      // Taking back what you gave: somebody may no longer see you.
      if (url.pathname.startsWith('/api/circle/viewer/') && req.method === 'DELETE') {
        await revoke(me, after('/api/circle/viewer/'));
        return json(200, circles.circleOf(me));
      }
      // Giving back what you were given: you stop seeing somebody.
      if (url.pathname.startsWith('/api/circle/owner/') && req.method === 'DELETE') {
        await revoke(after('/api/circle/owner/'), me);
        return json(200, circles.circleOf(me));
      }
      return notFound();
    }

    if (url.pathname.startsWith('/api/forget/') && req.method === 'POST') {
      const id = after('/api/forget/');
      // Erasing is the most final thing here, and until circles it was open
      // to anyone who could load the page. Yourself, or an admin.
      if (!canActFor(viewer, id)) return notFound();
      const erased = await forget(id);
      res.writeHead(erased === null ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(erased === null ? { ok: false, error: 'history not erased' } : { ok: true, erased }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  server.listen(config.port, config.host, () => {
    log.info(`dashboard on http://${config.host}:${config.port}/?token=…`);
  });

  return {
    server, publish, publishFence, forget, watchers, grant, revoke, stopLink, resend,
    // Told once the bot has connected, so the login page can name it.
    setBot: (username) => { botName = username || ''; },
    // Road reports changed somewhere other than here (a sweep, the bot):
    // every open map fetches them again.
    incidentsChanged: () => broadcast('incidents', {}, { to: (v) => v.via !== 'device' }),
  };
}
