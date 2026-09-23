// address.js — where the map can be reached, for the links the bot hands out.
//
// PUBLIC_URL, when it is set. Without it, a quick tunnel still has an address —
// a random `…trycloudflare.com` one that changes every time cloudflared
// restarts — and cloudflared says what it is on its metrics port:
//
//   GET http://tunnel:20241/quicktunnel  →  {"hostname":"…trycloudflare.com"}
//
// So the address is asked for rather than configured, and asked again every
// minute, which is how a restarted tunnel's new address reaches the next
// /login without anybody editing a file.
//
// A PUBLIC_URL on trycloudflare.com was copied from a quick tunnel's log, and
// is right only until that tunnel restarts. So it is not believed over the
// tunnel: while the tunnel answers, its current address is used, and the copy
// only when it cannot be asked.
//
// The page itself never needs this: its own buttons use the address it was
// opened at. This is for links that leave it — /login, /live, an SOS.

// A quick tunnel's name, and nothing else: whatever comes back from the metrics
// port ends up in links sent to people, so it is held to exactly this shape.
const QUICK = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;

export function makeAddress({
  publicUrl = '',
  metrics = 'http://tunnel:20241',
  fetch: f = fetch,
  ttl = 60_000,
  retry = 10_000,
  timeout = 2_000,
  clock = () => Date.now(),
} = {}) {
  const fixed = String(publicUrl || '').replace(/\/+$/, '');
  const copied = Boolean(fixed) && QUICK.test(hostOf(fixed));
  let known = '';
  let next = 0;   // when to ask the tunnel again

  async function ask() {
    const res = await f(`${String(metrics).replace(/\/+$/, '')}/quicktunnel`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return '';
    const body = await res.json().catch(() => null);
    const host = String(body?.hostname || '').toLowerCase();
    return QUICK.test(host) ? `https://${host}` : '';
  }

  return {
    // The address to put in a link, or '' when there is none to give.
    async get() {
      if (fixed && !copied) return fixed;
      if (clock() >= next) {
        try {
          known = (await ask()) || '';
        } catch {
          known = '';
        }
        next = clock() + (known ? ttl : retry);
      }
      return known || fixed;
    },

    // Which address links are using, for /healthz and the startup log. Never
    // the address itself: both are read in places it should not be.
    source: () => (fixed && !copied ? 'PUBLIC_URL' : known ? 'quick tunnel' : fixed ? 'PUBLIC_URL' : 'none'),

    // Whether PUBLIC_URL is a quick tunnel's address, for the startup log.
    copied,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
