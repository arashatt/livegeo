// config.js — everything the service needs from the environment, checked once
// at startup so a missing value is a clear message rather than a crash later.

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see README «Setting it up»`);
  return v;
};

export function load() {
  return {
    apiId: Number(need('TELEGRAM_API_ID')),
    apiHash: need('TELEGRAM_API_HASH'),
    // Produced once by `npm run login`; it is as good as the account password,
    // so it belongs in the environment and never in the repository.
    session: need('TELEGRAM_SESSION'),

    // The dashboard shows where people are. It is never served without one.
    dashboardToken: need('DASHBOARD_TOKEN'),

    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '127.0.0.1',

    // Only accept locations from these chats (ids, comma-separated). Empty
    // means every chat the account is in, which is rarely what you want.
    chats: (process.env.TELEGRAM_CHATS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),

    // A position nobody has updated for this long stops being shown.
    staleAfter: Number(process.env.STALE_AFTER || 3600),
    trailMax: Number(process.env.TRAIL_MAX || 120),
  };
}
