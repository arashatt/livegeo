// devices.js — a watch that reports where it is, without a phone or Telegram.
//
// A watch cannot sign in the way a person does: there is no browser to open a
// link in and no keyboard worth typing a password on. So it pairs once, with a
// six-digit code the person reads off the bot or the map, and receives a long
// token that it keeps. From then on that token is the watch.
//
// Only a hash of the token is stored. Somebody who reads the database learns
// which devices exist, not how to be one.
//
// Six digits is a million codes, which is guessable by anyone patient, so the
// guessing is what is limited — see makeCodes. And a device token is not a
// person: it can report positions and read what its owner may read, and
// nothing else. It cannot erase, publish, or change who sees whom.

import { createHash, randomBytes, randomInt } from 'node:crypto';

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

export function newDeviceToken() {
  return randomBytes(32).toString('base64url');
}

// An app installation's own random id, as the watch sends it, or '' for
// anything else. It proves nothing and grants nothing: it only says which
// earlier entry a new pairing replaces.
export const installId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : '');

// A fixed-window counter per key. Small on purpose: it guards one rare
// operation, and a process restart clearing it costs nothing that matters.
export function makeLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();   // key -> { count, until }
  return {
    // True once `key` has been seen more than `limit` times this window.
    over(key) {
      const t = now();
      let h = hits.get(key);
      if (!h || h.until <= t) { h = { count: 0, until: t + windowMs }; hits.set(key, h); }
      h.count += 1;
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.until <= t) hits.delete(k);
      }
      return h.count > limit;
    },
    reset(key) { hits.delete(key); },
  };
}

// Pairing codes, in memory: they live five minutes and a restart losing them
// costs somebody one more /pair.
//
// Guessing is limited two ways. Per address, a few failures per window. And
// globally: a wrong guess is not an attempt at any particular code, so it
// cannot "use up" one — but a burst of failures across all addresses means
// somebody is sweeping the space, and then every live code is burned. The
// person pairing asks for a new one; the sweeper has to start over and is
// guessing into an empty space.
export function makeCodes({
  life = 300_000,
  perAddress = 10,
  globalFailures = 50,
  windowMs = 600_000,
  now = () => Date.now(),
} = {}) {
  const live = new Map();   // code -> { owner, expires }
  const perIp = makeLimiter({ limit: perAddress, windowMs, now });
  const everyone = makeLimiter({ limit: globalFailures, windowMs, now });
  let burned = 0;

  const sweep = () => {
    const t = now();
    for (const [code, c] of live) if (c.expires <= t) live.delete(code);
  };

  return {
    issue(owner) {
      sweep();
      // At most one live code per person: asking again replaces it.
      for (const [code, c] of live) if (c.owner === String(owner)) live.delete(code);
      let code;
      do { code = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (live.has(code));
      live.set(code, { owner: String(owner), expires: now() + life });
      return code;
    },

    // { owner } on success; { limited: true } when this address or everyone
    // has failed too often; null for a wrong or expired code.
    redeem(code, address = 'unknown') {
      sweep();
      const clean = String(code || '').replace(/\D/g, '');
      const hit = clean.length === 6 ? live.get(clean) : null;
      if (hit) {
        live.delete(clean);
        return { owner: hit.owner };
      }
      const tooMany = perIp.over(address);
      if (everyone.over('*')) {
        if (live.size) { burned += live.size; live.clear(); }
        return { limited: true };
      }
      return tooMany ? { limited: true } : null;
    },

    get size() { sweep(); return live.size; },
    get burned() { return burned; },
  };
}

// The paired devices, held in memory like circles' grants and for the same
// reason: this process is the only writer, so the copy is exact, and checking
// a token on every ingest costs a Map lookup rather than a query.
export function makeDevices({ geo = null, log = console } = {}) {
  const byHash = new Map();   // hash -> { id, owner, name, platform }
  const lastTouched = new Map();

  return {
    get enabled() { return Boolean(geo && geo.enabled && geo.enabled()); },

    async load() {
      byHash.clear();
      if (!this.enabled) return 0;
      for (const d of await geo.listDevices()) byHash.set(d.token_hash, d);
      return byHash.size;
    },

    // `install` is the watch saying which installation of the app it is: the
    // same one pairing again, because the map's address changed and it had
    // to find it again, replaces the entry it had, so its old token stops
    // working rather than lingering beside the new one. Only for the same
    // owner, and the code already proved that.
    async pair({ owner, name = '', platform = '', install = '' }) {
      const token = newDeviceToken();
      const hash = hashToken(token);
      const who = String(owner);
      const same = installId(install);
      const id = await geo.createDevice({
        owner: who,
        name: String(name).slice(0, 60),
        platform: String(platform).slice(0, 20),
        tokenHash: hash,
        install: same,
      });
      byHash.set(hash, { id, owner: who, name, platform, install: same, token_hash: hash });
      let replaced = 0;
      if (same) {
        for (const [h, d] of byHash) {
          if (d.id === id || d.owner !== who || d.install !== same) continue;
          await geo.deleteDevice(d.id);
          byHash.delete(h);
          replaced += 1;
        }
      }
      return { id, token, replaced };
    },

    // Who a bearer token belongs to, or null.
    lookup(token) {
      if (!token) return null;
      return byHash.get(hashToken(token)) || null;
    },

    // Recorded at most once a minute per device, so "last seen" is useful
    // without being a write per position.
    touch(device) {
      const t = Date.now();
      if ((lastTouched.get(device.id) || 0) > t - 60_000) return;
      lastTouched.set(device.id, t);
      geo.touchDevice(device.id).catch((e) => log.error('devices: cannot touch —', e.message));
    },

    list(owner) {
      return [...byHash.values()]
        .filter((d) => owner === undefined || d.owner === String(owner))
        .map(({ id, owner: o, name, platform }) => ({ id, owner: o, name, platform }));
    },

    ownerOf(id) {
      for (const d of byHash.values()) if (d.id === Number(id)) return d.owner;
      return undefined;
    },

    async remove(id) {
      await geo.deleteDevice(Number(id));
      for (const [h, d] of byHash) if (d.id === Number(id)) byHash.delete(h);
    },

    // /stop: the database cascades; this is the same for the copy here.
    forget(owner) {
      for (const [h, d] of byHash) if (d.owner === String(owner)) byHash.delete(h);
    },
  };
}
