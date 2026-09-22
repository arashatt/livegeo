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

    // How long a shared path stays readable. A link that never expires is a
    // link somebody forgot they made.
    shareTtl: Number(process.env.SHARE_TTL || 7 * 24 * 3600),

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

    // How far inside or outside a fence a fix has to be before it is taken as
    // proof of which side it is on, and how long a crossing must hold before
    // anybody is told. Both exist because a phone resting on a boundary would
    // otherwise send a message every time it twitched. Same floor idea as
    // minMove: a fix that admits to worse accuracy raises the bar itself.
    fenceFloor: Number(process.env.FENCE_FLOOR || 50),
    fenceDwell: Number(process.env.FENCE_DWELL || 60),
  };
}

// Which way locations arrive. A bot is told only about what is shared with
// the bot; an account is told about anything shared in a chat it is in. The
// bot needs one secret and no login, so it is what BOT_TOKEN selects.
export function ingestOf(env = process.env) {
  if (env.BOT_TOKEN) return 'bot';
  if (env.TELEGRAM_SESSION) return 'account';
  throw new Error('neither BOT_TOKEN nor TELEGRAM_SESSION is set — see README «Setting it up»');
}

export function load() {
  const ingest = ingestOf();
  // A dashboard of where people are, with no way of saying who may look at
  // it, is not a state to start in. One of the two must exist.
  if (!process.env.DASHBOARD_TOKEN && !process.env.DASHBOARD_USERS) {
    throw new Error('set DASHBOARD_TOKEN, or DASHBOARD_USERS to sign in with Telegram — see README «Setting it up»');
  }
  return {
    ingest,

    // The bot's own credential, from @BotFather. One value, no login, and it
    // can be revoked without touching an account.
    botToken: process.env.BOT_TOKEN || '',
    // Where the Bot API lives. Telegram's own, unless you run their
    // self-hosted server (github.com/tdlib/telegram-bot-api) — or a test does.
    telegramApi: process.env.TELEGRAM_API || 'https://api.telegram.org',

    // Only needed by the account ingest, and asked for only then — a bot
    // deployment should not have to invent an api_id to start.
    apiId: ingest === 'account' ? Number(need('TELEGRAM_API_ID')) : 0,
    apiHash: ingest === 'account' ? need('TELEGRAM_API_HASH') : '',
    // Produced once by `npm run login`; it is as good as the account password,
    // so it belongs in the environment and never in the repository.
    session: ingest === 'account' ? need('TELEGRAM_SESSION') : '',

    // The dashboard shows where people are. One of the two ways in must exist:
    // a shared token, or Telegram sign-in against a list of who may look.
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
    // Telegram ids allowed to sign in through the bot. Empty means nobody can,
    // which is the safe direction for a page that shows where people are.
    viewers: (process.env.DASHBOARD_USERS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Where the dashboard is reachable, so the bot can send a working link.
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // The domain registered for the bot with BotFather. Only the Login Widget
    // needs it, and the widget cannot work without it, so it doubles as the
    // switch for that button.
    botDomain: process.env.BOT_DOMAIN || '',

    ...defaults(),
  };
}
