// checks.js — "check on me": noticing a stop that should not be happening.
//
// Tapsi watches its rides for abnormal stops: a car standing somewhere odd,
// or for too long, gets a call from its safety team. Here it is something you
// switch on for yourself — walking home late, a long drive — and the circle is
// the safety team. While a check runs, stopping for a quarter of an hour
// somewhere that is not one of your places, or your live location ending,
// gets you asked whether you are all right. Only if you do not answer are the
// people who can see you told, and where.
//
// Asking first is the whole design. A long lunch is not an emergency, and a
// check that told the circle every time somebody sat down would be switched
// off by the second day.
//
// It never lifts a private place. It fires only outside them — a stop at home
// is not unusual — and if a live location ends somewhere private, the check
// simply ends: somebody who got home and stopped sharing is fine.

import { everyoneWhoSees } from './sos.js';

export const CHECK_HOURS = [1, 2, 4];

// What to do about one check, now. Pure, and the whole of the judgement:
//
//   'over'   the check ran out
//   'ask'    ask them whether they are all right
//   'tell'   they were asked, long enough ago, and did not answer
//   'moved'  they were asked, and have moved on since
//   'home'   their live location ended somewhere of their own
//   null     nothing to do
//
// `settled` is the last sign all was well: a move, an /ok, or the check
// starting — somebody already sitting still when they switch it on is given
// the full quarter of an hour from then, not asked at once.
export function decide({
  now, until, startedAt, lastMove = null, okAt = null, live, known,
  askedAt = null, toldAt = null, stop = 900, grace = 300,
}) {
  if (now >= until) return 'over';
  if (askedAt !== null) {
    if (live && lastMove !== null && lastMove > askedAt) return 'moved';
    if (toldAt === null && now - askedAt >= grace) return 'tell';
    return null;
  }
  if (!live) return known ? 'home' : 'ask';
  const settled = Math.max(lastMove ?? 0, okAt ?? 0, startedAt ?? 0);
  if (!known && now - settled >= stop) return 'ask';
  return null;
}

const near = (place) => (place ? ` near ${place}` : '');

// What the person is asked. Pure, so the words are tested.
export function checkAsk({ minutes, place = '', stoppedSharing = false, grace = 5 }) {
  const what = stoppedSharing
    ? `Your live location stopped${near(place)} while I was checking on you.`
    : `You have been stopped for ${minutes} min${near(place)}.`;
  return `${what} Are you all right? Send /ok — otherwise in ${grace} minutes I will tell the people who can see you where you are.`;
}

// What the circle is told when nobody answered.
export function checkTell({ who, minutes, place = '', located = true, stoppedSharing = false, call }) {
  const name = who || 'Somebody';
  const what = stoppedSharing
    ? `${name}’s live location stopped ${minutes} min ago${near(place)}, while they had asked to be checked on, and they have not answered.`
    : `${name} has been stopped for ${minutes} min${near(place)}, while they had asked to be checked on, and they have not answered.`;
  return [
    `⚠️ ${what}`,
    located ? (place ? '' : 'Where: the pin below.') : 'Where they are is not known.',
    `It may be nothing. This came through livegeo, which has called nobody; if they may be in danger, call ${call}.`,
  ].filter(Boolean).join('\n');
}

export function makeChecks({
  geo, circles, positions, zones,
  admins = [],
  call = '110 (police) or 115 (ambulance)',
  placeOf = null,
  // Fences a point is inside, as geo.fencesAt returns them: somewhere of your
  // own counts as known, like a private place.
  fencesAt = null,
  notify = null,
  locate = null,
  stop = 900,
  grace = 300,
  clock = () => Date.now(),
  log = console,
}) {
  const checks = new Map();   // person -> { person, startedAt, until, askedAt, toldAt, okAt }
  const now = () => Math.floor(clock() / 1000);
  const nameOf = (id) => circles.user(id)?.name || positions.get(id)?.name || 'Somebody';
  const isLive = (p) => Boolean(p && !p.stopped && p.liveUntil && p.liveUntil > now());
  const lastMoveOf = (p) => (p && p.trail && p.trail.length ? p.trail[p.trail.length - 1].at : null);
  const save = (c) => geo.saveCheck(c).catch((e) => log.error('check:', e && e.message ? e.message : e));

  const say = async (to, text) => (notify ? notify(to, text) : false);

  async function knownAt(person, p) {
    if (!p || p.latitude === null || p.latitude === undefined) return false;
    if (zones.at(person, p.latitude, p.longitude)) return true;
    const fences = fencesAt ? await fencesAt(p.latitude, p.longitude).catch(() => []) : [];
    return fences.some((f) => f.inside === true && String(f.owner) === String(person));
  }

  async function tellCircle(person, text, p) {
    let told = 0;
    // A point inside a private place is never handed on, even here.
    const point = p && p.latitude !== null && !zones.at(person, p.latitude, p.longitude)
      ? { latitude: p.latitude, longitude: p.longitude } : null;
    for (const to of everyoneWhoSees(circles, admins, person)) {
      if (!(await say(to, text))) continue;
      told += 1;
      if (point && locate) await locate(to, point.latitude, point.longitude);
    }
    return told;
  }

  const placeNear = async (person, p) => (p && p.latitude !== null && placeOf && !zones.at(person, p.latitude, p.longitude)
    ? placeOf(p.latitude, p.longitude).catch(() => '') : '');

  return {
    get enabled() { return Boolean(geo && geo.enabled && geo.enabled()); },
    stopMinutes: Math.round(stop / 60),

    async load() {
      if (!this.enabled) return 0;
      checks.clear();
      for (const c of await geo.listChecks()) if (c.until > now()) checks.set(c.person, c);
      return checks.size;
    },

    get: (person) => {
      const c = checks.get(String(person));
      return c && c.until > now() ? c : null;
    },

    // Only while sharing: a check on somebody the map cannot see would be a
    // promise it cannot keep.
    async start(person, hours) {
      const key = String(person);
      if (!isLive(positions.get(key))) return { error: 'Share your live location first — I can only check on you while I can see you.' };
      const at = now();
      const c = { person: key, startedAt: at, until: at + Math.round(hours * 3600), askedAt: null, toldAt: null, okAt: null };
      checks.set(key, c);
      await save(c);
      return { check: c, circle: everyoneWhoSees(circles, admins, key).length, stopMinutes: Math.round(stop / 60) };
    },

    async stop(person) {
      const key = String(person);
      const had = checks.delete(key);
      await geo.deleteCheck(key).catch(() => 0);
      return had;
    },

    // /ok. Whoever was told is told this too. A check whose live location
    // has ended cannot go on, and ends here.
    async ok(person) {
      const key = String(person);
      const c = checks.get(key);
      if (!c) return 'none';
      if (c.toldAt !== null) await tellCircle(key, `${nameOf(key)} says they are all right.`, null);
      if (!isLive(positions.get(key))) {
        await this.stop(key);
        return 'ended';
      }
      Object.assign(c, { askedAt: null, toldAt: null, okAt: now() });
      await save(c);
      return 'cleared';
    },

    forget(person) { checks.delete(String(person)); },

    // Once a minute.
    async sweep() {
      for (const c of [...checks.values()]) {
        const key = c.person;
        const p = positions.get(key);
        const live = isLive(p);
        const known = await knownAt(key, p);
        const verdict = decide({
          now: now(), until: c.until, startedAt: c.startedAt, lastMove: lastMoveOf(p), okAt: c.okAt,
          live, known, askedAt: c.askedAt, toldAt: c.toldAt, stop, grace,
        });
        if (verdict === 'over') {
          checks.delete(key);
          await geo.deleteCheck(key).catch(() => 0);
          await say(key, 'Checking on you has ended. /checkon to start again.');
        } else if (verdict === 'home') {
          checks.delete(key);
          await geo.deleteCheck(key).catch(() => 0);
          await say(key, 'Your live location stopped somewhere of your own, so checking on you has ended.');
        } else if (verdict === 'ask') {
          c.askedAt = now();
          await save(c);
          const settled = Math.max(lastMoveOf(p) ?? 0, c.okAt ?? 0, c.startedAt);
          await say(key, checkAsk({
            minutes: Math.round((c.askedAt - settled) / 60), place: await placeNear(key, p),
            stoppedSharing: !live, grace: Math.round(grace / 60),
          }));
          log.info('check: somebody was asked whether they are all right');
        } else if (verdict === 'tell') {
          c.toldAt = now();
          await save(c);
          const located = Boolean(p && p.latitude !== null && p.latitude !== undefined);
          const since = live ? Math.max(lastMoveOf(p) ?? 0, c.okAt ?? 0, c.startedAt) : (p?.at ?? c.askedAt);
          const told = await tellCircle(key, checkTell({
            who: nameOf(key), minutes: Math.round((now() - since) / 60), place: await placeNear(key, p),
            located, stoppedSharing: !live, call,
          }), p);
          log.info(`check: nobody answered; ${told} told`);
        } else if (verdict === 'moved') {
          if (c.toldAt !== null) await tellCircle(key, `${nameOf(key)} is moving again.`, null);
          Object.assign(c, { askedAt: null, toldAt: null });
          await save(c);
        }
      }
    },
  };
}
