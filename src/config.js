// config.js — everything the service needs from the environment, checked once
// at startup so a missing value is a clear message rather than a crash later.

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see README «Setting it up»`);
  return v;
};

// Everything that has a sensible default and no secret in it. Split out so
// bin/selfcheck.mjs — which runs the dashboard with no Telegram account — gets
// the same settings rather than restating a subset of them and quietly
// shipping a page whose map cannot load.
export function defaults() {
  return {
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '127.0.0.1',

    // Only accept locations from these chats (ids, comma-separated). Empty
    // means every chat the account is in, which is rarely what you want.
    chats: (process.env.TELEGRAM_CHATS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),

    // Optional on purpose: without it the service still runs, it just cannot
    // name a place or remember where anyone has been. Never need().
    databaseUrl: process.env.DATABASE_URL || '',

    // When set, only a caller presenting this header is answered — which is
    // how the origin can be exposed to the internet for a Cloudflare Worker to
    // reach without being exposed to everyone who finds the address. Unset
    // means no such check, which is the state the service has always been in.
    edgeKey: process.env.EDGE_KEY || '',

    // The basemap is proxied through this service so the browser never has to
    // reach a third party. Point this at your own renderer if you outgrow the
    // public OpenStreetMap tiles.
    tileUpstream: process.env.TILE_UPSTREAM || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileCache: process.env.TILE_CACHE || '/tmp/livegeo-tiles',
    tileMaxAge: Number(process.env.TILE_MAX_AGE || 30 * 24 * 3600),
    // OSM asks that clients say who they are; an anonymous proxy is the kind
    // that gets blocked.
    tileUserAgent: process.env.TILE_USER_AGENT
      || 'livegeo/1.0 (+https://github.com/arashatt/livegeo)',

    // A position nobody has updated for this long stops being shown.
    staleAfter: Number(process.env.STALE_AFTER || 3600),
    trailMax: Number(process.env.TRAIL_MAX || 120),
    // Metres a fix must move before it counts as travel rather than GPS noise.
    // Only the floor — a reported accuracy worse than this raises it.
    minMove: Number(process.env.MIN_MOVE || 25),
  };
}

export function load() {
  return {
    apiId: Number(need('TELEGRAM_API_ID')),
    apiHash: need('TELEGRAM_API_HASH'),
    // Produced once by `npm run login`; it is as good as the account password,
    // so it belongs in the environment and never in the repository.
    session: need('TELEGRAM_SESSION'),

    // The dashboard shows where people are. It is never served without one.
    dashboardToken: need('DASHBOARD_TOKEN'),

    ...defaults(),
  };
}
