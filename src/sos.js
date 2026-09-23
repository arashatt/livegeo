// sos.js — somebody asking for help.
//
// Tapsi's safety button reaches its safety team. Here the circle is the
// safety team: an SOS tells everybody who can see you where you are, with a
// link that follows you for an hour — and for that hour your private places do
// not hide you from them. You asked to be found, and a blur would be in the
// way. Only where you are: the path you came by stays veiled, because being
// found is about now, and the way from your door is not something you asked
// to hand over.
//
// It calls nobody else, and every message says so, with the number to call.
//
// An SOS is a live link with reason 'sos' (live.js). That is all the state
// there is: the server reads it to decide what each viewer is shown, and it
// is in the database, so an emergency outlasts a deploy.

import { SOS_MINUTES } from './live.js';

// What the circle is sent. Pure, so what somebody reads at the worst moment
// of someone else's day is tested rather than assembled on the spot.
export function sosMessage({ who, place = '', minutes = null, located = false, url = '', call }) {
  let where;
  if (!located) where = 'Where they are is not known — they have not shared a location lately.';
  else where = `Where: ${place ? `near ${place}` : 'the pin below'}${minutes !== null && minutes >= 2 ? ` (${minutes} min ago)` : ''}`;
  return [
    `🆘 ${who || 'Somebody'} asked for help.`,
    where,
    url ? `Follow them live for the next hour: ${url}` : '',
    `This came through livegeo, which has called nobody. If they may be in danger, call ${call}.`,
  ].filter(Boolean).join('\n');
}

// Everybody who can see somebody: whoever they let, and the admins, who see
// everyone. Not them — they know. Who an SOS goes to, and who is told when a
// check on somebody goes unanswered.
export const everyoneWhoSees = (circles, admins, id) => [...new Set([
  ...circles.circleOf(id).canSeeMe.map((u) => String(u.id)),
  ...admins.map(String),
])].filter((x) => x !== String(id));

export function makeSos({
  live, circles, positions,
  admins = [],
  publicUrl = '',
  call = '110 (police) or 115 (ambulance)',
  placeOf = null,
  // Telegram, once connected: a message, and a pin. Either may be absent —
  // the account ingest cannot send anything — and an SOS still shows on the
  // map without them.
  notify = null,
  locate = null,
  // The server's: send somebody afresh to every open map that may see them,
  // and stop a link, telling whoever is following it why.
  resend,
  stopLink,
  minutes = SOS_MINUTES,
  clock = () => Date.now(),
  log = console,
}) {
  // Who had an SOS running at the last look, so one that runs out by itself
  // can be noticed and put back.
  const running = new Set();
  // When everybody was last told, per person. Pressing again sends where
  // they are now — but not twice in half a minute: a panicked double press
  // is one message, and a held button is not a flood.
  const lastSent = new Map();
  const AGAIN_AFTER = 30_000;

  const nameOf = (id) => circles.user(id)?.name || positions.get(id)?.name || 'Somebody';
  const whoSees = (id) => everyoneWhoSees(circles, admins, id);

  async function tell(ids, text, point = null) {
    let told = 0;
    for (const to of ids) {
      if (!notify || !(await notify(to, text))) continue;
      told += 1;
      if (point && locate) await locate(to, point.latitude, point.longitude);
    }
    return told;
  }

  return {
    // After live.load(): an SOS that was running before a restart still is.
    load() {
      for (const link of live.all()) if (link.reason === 'sos') running.add(link.person);
      return running.size;
    },

    // Raising it again while it runs sends everybody where they are now, with
    // the same link, rather than starting a second one.
    async raise(id) {
      const key = String(id);
      const had = live.sosOf(key);
      const link = had || await live.create({ person: key, minutes, reason: 'sos' });
      running.add(key);
      if (!had) resend(key);
      const url = publicUrl ? `${publicUrl}/live/${link.token}` : '';
      const ids = whoSees(key);
      if (had && clock() - (lastSent.get(key) ?? -Infinity) < AGAIN_AFTER) {
        return { link, url, told: 0, circle: ids.length, again: true, recent: true, call };
      }
      lastSent.set(key, clock());

      const p = positions.get(key);
      const located = Boolean(p && p.latitude !== null && p.latitude !== undefined);
      const place = located && placeOf ? await placeOf(p.latitude, p.longitude).catch(() => '') : '';
      const text = sosMessage({
        who: nameOf(key), place, located, url, call,
        minutes: located ? Math.round((clock() / 1000 - p.at) / 60) : null,
      });
      const told = await tell(ids, text, located ? { latitude: p.latitude, longitude: p.longitude } : null);
      // Counted, never named: these logs are read where an id should not be.
      log.info(`sos: somebody asked for help; ${told} told`);
      return { link, url, told, circle: ids.length, again: Boolean(had), call };
    },

    // Safe. The link stops, open maps are sent them veiled again, and
    // everybody who was told is told this too.
    async end(id) {
      const key = String(id);
      const link = live.sosOf(key);
      running.delete(key);
      lastSent.delete(key);
      if (!link) return false;
      await stopLink(link, 'safe');
      resend(key);
      await tell(whoSees(key), `${nameOf(key)} is safe now. Their SOS is over, and their private places hide them again.`);
      log.info('sos: somebody is safe');
      return true;
    },

    // An SOS that ran out by itself: open maps are put right, and the person
    // is asked whether they still need help rather than being left to find
    // out that nobody can see them exactly any more.
    async sweep() {
      for (const key of [...running]) {
        if (live.sosOf(key)) continue;
        running.delete(key);
        resend(key);
        if (notify) {
          await notify(key, 'Your SOS ran out after an hour, and your private places hide you again. /sos if you still need help.');
        }
      }
    },
  };
}
