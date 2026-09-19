// login.js — who is allowed to look, decided by Telegram rather than by a
// secret everybody shares.
//
// DASHBOARD_TOKEN is one string held by everyone who has ever been given it,
// and there is no taking it back from one person without taking it back from
// all of them. This replaces it with a list of Telegram ids and two ways for
// somebody on that list to prove they are themselves.
//
//   1. Through the bot. Send /login, get a one-time link, open it. This needs
//      no domain, which is why it is the one that works here today.
//   2. The Telegram Login Widget, which is the more familiar button but needs
//      a domain registered with BotFather, so it stays off until BOT_DOMAIN
//      is set.
//
// Both end in the same place: a cookie carrying an id and an expiry, signed
// with a key derived from the bot token. No session table, because the only
// thing worth storing would be a revocation list and the allowlist already is
// one — drop an id from DASHBOARD_USERS and their next request fails.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'tll_session';
const SESSION_LIFE = 30 * 24 * 3600;
// How long a one-time link is worth opening. Long enough to switch apps,
// short enough that a link left in a chat is not a key to anything.
const LINK_LIFE = 300;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// The signing key is derived from the bot token rather than being another
// thing to configure and lose. Rotating the token invalidates every session,
// which is the correct behaviour and not a side effect.
export function keyFor(botToken) {
  return createHash('sha256').update(`livegeo/session/${botToken}`).digest();
}

// --------------------------------------------------------------- the cookie

export function mint(id, { botToken, now = () => Date.now(), life = SESSION_LIFE }) {
  const body = b64(JSON.stringify({ id: String(id), exp: Math.floor(now() / 1000) + life }));
  const sig = b64(createHmac('sha256', keyFor(botToken)).update(body).digest());
  return `${body}.${sig}`;
}

// Returns the id, or null. Never throws, because this runs on whatever a
// browser chose to send.
export function readSession(value, { botToken, now = () => Date.now() }) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [body, sig] = value.split('.', 2);
  const want = b64(createHmac('sha256', keyFor(botToken)).update(body).digest());
  if (!sig || !same(sig, want)) return null;
  try {
    const { id, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!id || !exp || exp < Math.floor(now() / 1000)) return null;
    return String(id);
  } catch {
    return null;
  }
}

// ------------------------------------------------- the widget's signed reply
//
// Telegram signs the payload with a key that is SHA256 of the bot token, over
// every field except `hash`, sorted by name, joined by newlines. Verifying it
// is the whole of the widget's security, so it is here rather than inline.

export function checkWidget(fields, { botToken, now = () => Date.now(), maxAge = 86400 }) {
  if (!fields || typeof fields !== 'object' || !fields.hash) return null;
  const check = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(String(botToken)).digest();
  const want = createHmac('sha256', secret).update(check).digest('hex');
  if (!same(String(fields.hash).toLowerCase(), want)) return null;
  // A valid signature is forever; the timestamp is what stops a replay of one
  // somebody captured.
  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate) || Math.floor(now() / 1000) - authDate > maxAge) return null;
  return String(fields.id);
}

// ------------------------------------------------------- one-time bot links

export function makeLinks({ now = () => Date.now(), life = LINK_LIFE } = {}) {
  const out = new Map();   // token -> { id, expires }

  const sweep = () => {
    const t = now();
    for (const [token, link] of out) if (link.expires <= t) out.delete(token);
  };

  return {
    // Made for an id that has already been checked against the allowlist, so
    // an unlisted person never receives a link at all rather than receiving
    // one that fails when opened.
    issue(id) {
      sweep();
      const token = randomBytes(24).toString('base64url');
      out.set(token, { id: String(id), expires: now() + life * 1000 });
      return token;
    },
    // Single use. A link in a chat history is a link somebody else can read.
    redeem(token) {
      sweep();
      if (typeof token !== 'string' || !token) return null;
      const link = out.get(token);
      if (!link) return null;
      out.delete(token);
      return link.id;
    },
    get size() { sweep(); return out.size; },
  };
}

// ------------------------------------------------------------- the allowlist

export function makeViewers(ids) {
  const allowed = new Set((ids || []).map(String));
  return {
    has: (id) => allowed.has(String(id)),
    get size() { return allowed.size; },
  };
}
