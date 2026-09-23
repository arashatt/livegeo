// live.js — a link that lets somebody follow one person, live, for a while.
//
// Tapsi calls this sharing a trip: whoever the passenger sends it to watches
// the ride move, without the app, until it ends. Here it is the same thing for
// somebody without Telegram, or without the bot, or outside the circle: one
// person, for a quarter of an hour to four hours, and nothing else.
//
// What a link shows is what the circle is shown, and less. Private places
// apply to it as to anybody who may not see exactly, and the path starts when
// the link was made — whatever came before, usually a front door, is not what
// was sent. The server decides both (see `shown` in server.js); this file only
// keeps the links.
//
// Held in memory and written through, the way circles and zones are: an SOS is
// a link too, and every position that arrives asks whether its person is in
// one, which must not cost a query.

import { randomBytes } from 'node:crypto';

// How long a link may last, in minutes. A few fixed choices rather than any
// number: "until tonight" is a different thing from a live link, and a link
// nobody remembers sending should not still be working next week.
export const LIVE_MINUTES = [15, 60, 240];
export const LIVE_EACH = 5;
// An SOS is a live link too (see sos.js), for an hour.
export const SOS_MINUTES = 60;

export function makeLive({ geo = null, clock = () => Date.now() } = {}) {
  const links = new Map();   // token -> { token, person, reason, createdAt, expiresAt }, in seconds
  const now = () => clock() / 1000;

  // Ran out: gone from memory as soon as anybody asks, so an expired link is
  // indistinguishable from one that never existed.
  const current = (link) => {
    if (!link) return null;
    if (link.expiresAt > now()) return link;
    links.delete(link.token);
    return null;
  };

  return {
    get enabled() { return Boolean(geo && geo.enabled && geo.enabled()); },

    async load() {
      if (!this.enabled) return 0;
      links.clear();
      for (const link of await geo.listLiveLinks()) links.set(link.token, link);
      return links.size;
    },

    get: (token) => current(links.get(String(token))),

    // Somebody's links that still work, newest first.
    of: (person) => [...links.values()]
      .filter((l) => l.person === String(person) && current(l))
      .sort((a, b) => b.createdAt - a.createdAt),

    // Every link that still works, whoever's it is.
    all: () => [...links.values()].filter((l) => current(l)),

    // The SOS somebody has running, or null. Asked for every position sent
    // to every open map, so it stays a walk over a handful of links.
    sosOf: (person) => [...links.values()]
      .find((l) => l.reason === 'sos' && l.person === String(person) && current(l)) || null,

    async create({ person, minutes, reason = 'share' }) {
      const createdAt = Math.floor(now());
      const link = {
        token: randomBytes(18).toString('base64url'),
        person: String(person),
        reason,
        createdAt,
        expiresAt: createdAt + Math.round(minutes * 60),
      };
      await geo.createLiveLink(link);
      links.set(link.token, link);
      return link;
    },

    // Returns the link that was stopped, or null if there was none.
    async revoke(token) {
      const link = links.get(String(token));
      if (!link) return null;
      links.delete(link.token);
      await geo.revokeLiveLink(link.token);
      return link;
    },

    // /stop. The database cascades; this is the same for the copy here.
    forget(person) {
      for (const [token, link] of links) if (link.person === String(person)) links.delete(token);
    },
  };
}

// What the owner is told about a link of theirs. The person is them, and the
// page needs a path to show rather than a token to assemble one from.
export const describeLink = (link) => ({
  token: link.token,
  path: `/live/${link.token}`,
  reason: link.reason,
  createdAt: link.createdAt,
  expiresAt: link.expiresAt,
});
