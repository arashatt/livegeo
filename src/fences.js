// fences.js — deciding that somebody has arrived, and not saying so otherwise.
//
// Detection is the easy half. The hard half is that a geofence is a machine
// for crying wolf: a phone resting near a boundary reports itself inside, then
// outside, then inside, indefinitely, and every flip is a message on somebody's
// lock screen. An alert nobody trusts is worse than no alert, so most of this
// file is about the readings it refuses to act on.
//
// It is the same problem as the scribbled paths in positions.js and it takes
// the same answer: the accuracy Telegram reports is a noise floor, and a fix
// closer to the edge than its own uncertainty is not evidence of which side it
// is on. See metresBetween/movementThreshold there for the other half of it.
//
// Pure, and imports nothing, so all of this is tested without a database —
// which matters because the interesting cases (a jittering phone, a car
// turning round) are tedious to produce and trivial to describe.

const KEY = (person, fence) => `${person}\u0000${fence}`;

// Inside, outside, or too close to the edge to claim either. The third answer
// is the whole point: without it the other two flip against each other forever.
export function verdict({ inside, margin, accuracy }, { floor = 50 } = {}) {
  const m = Number(margin);
  if (!Number.isFinite(m)) return null;
  // Whichever is worse: the floor we always apply, or what this particular fix
  // admits about itself.
  const need = Math.max(Number(floor) || 0, Number(accuracy) || 0);
  if (m <= need) return null;
  return inside ? 'in' : 'out';
}

export function makeWatcher({ floor = 50, dwell = 60 } = {}) {
  // (person, fence) -> { where, pendingWhere, since }
  const state = new Map();

  return {
    // What the last recorded event says, so a restart neither forgets where
    // everybody was nor announces that they have all just arrived.
    seed(rows = []) {
      for (const r of rows) {
        if (!r || r.person === undefined || r.fence === undefined) continue;
        state.set(KEY(r.person, r.fence), { where: r.where, pendingWhere: null, since: 0 });
      }
      return state.size;
    },

    // One position against every fence. Returns only what is worth announcing,
    // which is usually nothing.
    observe({ person, accuracy = null, at, readings = [] }) {
      const events = [];
      for (const r of readings) {
        const key = KEY(person, r.fence);
        const now = state.get(key) || { where: null, pendingWhere: null, since: 0 };
        const seen = verdict({ inside: r.inside, margin: r.margin, accuracy }, { floor });

        // Inside its own uncertainty. Not a reading against the previous
        // state, so it must not clear a change that is part-way to settling.
        if (seen === null) { state.set(key, now); continue; }

        if (now.where === null) {
          // First sighting. Where somebody already is is not an arrival, and
          // announcing it would make every deploy a flood.
          state.set(key, { where: seen, pendingWhere: null, since: 0 });
          continue;
        }

        if (seen === now.where) {
          // Back where it was: whatever was settling has been withdrawn.
          state.set(key, { where: now.where, pendingWhere: null, since: 0 });
          continue;
        }

        // A change, which has to hold before it counts. Driving past the end
        // of the road is not arriving home.
        const since = now.pendingWhere === seen ? now.since : at;
        if (at - since >= dwell) {
          state.set(key, { where: seen, pendingWhere: null, since: 0 });
          events.push({ fence: r.fence, name: r.name, entered: seen === 'in', at });
        } else {
          state.set(key, { where: now.where, pendingWhere: seen, since });
        }
      }
      return events;
    },

    // Forgetting a person has to mean forgetting them here too, or /stop would
    // leave them able to trigger an alert about a place they had been.
    forget(person) {
      const prefix = `${person}\u0000`;
      for (const key of state.keys()) if (key.startsWith(prefix)) state.delete(key);
    },

    dropFence(fence) {
      const suffix = `\u0000${fence}`;
      for (const key of state.keys()) if (key.endsWith(suffix)) state.delete(key);
    },

    where(person, fence) { return state.get(KEY(person, fence))?.where ?? null; },
    get size() { return state.size; },
  };
}

// How an event reads on a phone. Here rather than in bot.js because it is the
// sentence somebody gets woken by, and it should be reviewable next to the
// rules that decide whether to send it at all.
export function announce({ who, name, entered }) {
  return `${who || 'Someone'} ${entered ? 'arrived at' : 'left'} ${name}`;
}
