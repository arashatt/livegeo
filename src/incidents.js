// incidents.js — what people report on the road, and how far to believe it.
//
// Closed roads, accidents, hazards and jams, reported from the map or the bot
// and shown to everyone who can sign in, never with who reported them. How
// far each is believed follows the traffic research (research §2.2 and
// Appendix A; SPEC §3–§5), which is how Waze does it:
//
//   - Reports of the same thing merge: the same kind, near enough (150 m for
//     an accident or a hazard, 300 m for a closure or a jam), going the same
//     way (headings within 45°), while the first is still believed.
//   - Belief is a probability kept as log-odds. A report starts at even odds
//     and moves them by log(w/(1−w)), where w is how reliable its reporter
//     has been: Beta(α, β), from 3:2 (0.6), kept within 0.5–0.95. "Still
//     there" moves them the same way, "not there" the other.
//   - Between answers it fades, p(t) = p(t₀)·e^(−(t−t₀)/τ), faster for a jam
//     than for a closure.
//   - On the map once believed at 0.55 or more, so one reporter at the floor
//     cannot put something there alone, and until it fades below 0.3 or two
//     "not there" come with nobody but the reporter behind it. The research
//     hides a report as soon as it fades under 0.55, which suits Waze, where
//     somebody confirms a report within minutes; here that would be about
//     two minutes for a jam reported once. Down to 0.3, one report shows for
//     about 14 minutes (a jam), 40 (an accident), 80 (a hazard) or 8 hours
//     (a closure), and longer as others confirm it.
//   - Once settled (confirmed, or dismissed soon after it was made), everyone
//     who answered becomes a little more or less reliable.
//   - People sharing their location who pass within 200 m, heading towards
//     it, are asked "still there?": about each report once, at most once in
//     five minutes, and never about their own.
//   - No police or speed cameras. Warning of them is banned or restricted in
//     several countries (research §3), so there is nothing to report them with.
//
// A reporter is kept only as a keyed hash of their id: the tables do not say
// who reported what, and the hash is what their reliability hangs on.

import { createHmac, randomBytes } from 'node:crypto';
import { metresBetween } from './positions.js';

// τ, how fast belief fades (seconds); near, how far apart two reports of it
// can be and still be the same thing (metres).
export const KINDS = {
  closed: { tau: 12 * 3600, near: 300 },
  accident: { tau: 3600, near: 150 },
  hazard: { tau: 2 * 3600, near: 150 },
  jam: { tau: 20 * 60, near: 300 },
};
// What a hazard is, when the reporter says.
export const DETAILS = ['object', 'pothole', 'stopped', 'weather', 'works'];

export const SHOW = 0.55;
export const GONE = 0.3;
export const SAME_WAY = 45;
export const PRIOR = { alpha: 3, beta: 2 };
// Asking passers-by: how near, how often, and only while it is uncertain.
export const ASK = { within: 200, every: 300, below: 0.9 };
// Each person, each hour.
export const LIMITS = { reports: 10, answers: 60 };
// Seconds between seeing something and pressing report: the report is moved
// back along the way the reporter was going by their speed times this.
export const LAG = 3;
const CONFIRMED = 0.8;
const DISMISSED_WITHIN = 15 * 60;

const clampP = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));
export const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

export function reliability(r = PRIOR) {
  const w = r.alpha / (r.alpha + r.beta);
  return Math.min(0.95, Math.max(0.5, Number.isFinite(w) ? w : 0.6));
}

// How far an incident is believed at `t` (seconds).
export function belief(inc, t) {
  return sigmoid(inc.logit) * Math.exp(-Math.max(0, t - inc.lastAt) / KINDS[inc.kind].tau);
}

// The angle between two headings, 0 to 180 degrees.
export function turn(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

// Degrees clockwise from north, from a to b.
export function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.longitude - a.longitude) * rad) * Math.cos(b.latitude * rad);
  const x = Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad)
    - Math.sin(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.cos((b.longitude - a.longitude) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

// Where the reporter was when they saw it: back along their way by LAG
// seconds at their speed (m/s). Without both, where they are.
export function seenAt({ latitude, longitude, heading = null, speed = null }) {
  if (!finite(heading) || !(speed > 0)) return { latitude, longitude };
  const back = Math.min(speed, 70) * LAG;
  const rad = Math.PI / 180;
  return {
    latitude: latitude - (back * Math.cos(heading * rad)) / 111195,
    longitude: longitude - (back * Math.sin(heading * rad)) / (111195 * Math.cos(latitude * rad)),
  };
}

// The incident a new report is about, or null.
export function sameAs(incidents, report, t) {
  let best = null;
  let nearest = Infinity;
  for (const inc of incidents) {
    if (inc.status !== 'active' || inc.kind !== report.kind || belief(inc, t) < GONE) continue;
    const d = metresBetween(inc, report);
    if (d > KINDS[inc.kind].near || d >= nearest) continue;
    if (finite(inc.heading) && finite(report.heading) && turn(inc.heading, report.heading) > SAME_WAY) continue;
    best = inc;
    nearest = d;
  }
  return best;
}

// On the map: active, believed at SHOW at some point, and not yet faded.
export function shown(inc, t) {
  return inc.status === 'active' && (inc.peak ?? 0) >= SHOW && belief(inc, t) >= GONE;
}

// 'active' while believed, 'expired' once faded below GONE. 'removed', by
// people saying it is not there, is decided as they say it (withEvidence).
export function statusOf(inc, t) {
  if (inc.status !== 'active') return inc.status;
  return belief(inc, t) < GONE ? 'expired' : 'active';
}

// One piece of evidence, { kind: 'report' | 'there' | 'not_there', reporter,
// w, at }: the incident as it stands afterwards, as a new object.
export function withEvidence(inc, ev) {
  const step = logit(ev.w) * (ev.kind === 'not_there' ? -1 : 1);
  const supporters = new Set(inc.supporters);
  const dismissers = new Set(inc.dismissers);
  if (ev.kind === 'not_there') dismissers.add(ev.reporter);
  else supporters.add(ev.reporter);
  const after = logit(belief(inc, ev.at)) + step;
  const next = {
    ...inc,
    logit: after,
    peak: Math.max(inc.peak ?? 0, sigmoid(after)),
    lastAt: ev.at,
    supporters,
    dismissers,
    there: inc.there + (ev.kind === 'there' ? 1 : 0),
    notThere: inc.notThere + (ev.kind === 'not_there' ? 1 : 0),
  };
  // Two "not there" and nobody but the reporter behind it is Waze's rule for
  // taking a report down at once, however reliable its reporter.
  if (next.status === 'active' && ev.kind === 'not_there'
    && ((next.notThere >= 2 && next.supporters.size <= 1) || belief(next, ev.at) < GONE)) {
    return { ...next, status: 'removed', endedAt: ev.at };
  }
  return next;
}

// Settled, for reliability: 'confirmed' (believed at 0.8 or more, with two
// different people behind it), 'dismissed' (taken down by answers within 15
// minutes of being made), or null. Fading away settles nothing: a jam nobody
// else passed may well have been real.
export function settled(inc, t) {
  if (inc.resolved) return null;
  if (inc.status === 'active' && inc.supporters.size >= 2 && belief(inc, t) >= CONFIRMED) return 'confirmed';
  if (inc.status === 'removed' && (inc.endedAt ?? t) - inc.createdAt <= DISMISSED_WITHIN) return 'dismissed';
  return null;
}

// The incident to ask somebody about as they pass, or null: near, ahead of
// them, still uncertain, not theirs, and not asked of them before.
export function toAsk(incidents, person, t, { me, asked = () => false } = {}) {
  if (!finite(person.latitude) || !finite(person.heading)) return null;
  let best = null;
  let nearest = Infinity;
  for (const inc of incidents) {
    if (inc.status !== 'active' || inc.reporter === me || inc.supporters.has(me) || inc.dismissers.has(me)) continue;
    const p = belief(inc, t);
    if (p < GONE || p > ASK.below || asked(inc.id)) continue;
    const d = metresBetween(person, inc);
    if (d > ASK.within || d >= nearest) continue;
    if (turn(bearing(person, inc), person.heading) > SAME_WAY) continue;
    best = inc;
    nearest = d;
  }
  return best;
}

// What the map is sent: never who reported it. `mine` only ever goes to the
// person it is true of.
export function viewOf(inc, t, me = null) {
  return {
    id: inc.id,
    kind: inc.kind,
    detail: inc.detail || '',
    lat: Number(inc.latitude.toFixed(6)),
    lon: Number(inc.longitude.toFixed(6)),
    heading: finite(inc.heading) ? Math.round(inc.heading) : null,
    since: Math.floor(inc.createdAt),
    last: Math.floor(inc.lastAt),
    p: Math.round(belief(inc, t) * 100) / 100,
    confirmed: inc.there,
    // Somebody besides its reporter is behind it: it can no longer be taken back.
    backed: inc.supporters.size > 1 || inc.there > 0,
    mine: Boolean(me && inc.reporter === me),
  };
}

// ------------------------------------------------------------------ the store

export function makeIncidents({ geo = null, key = null, now = () => Date.now() / 1000, log = console } = {}) {
  const secret = key || randomBytes(32);
  const incidents = new Map();   // id → incident
  const reporters = new Map();   // pseudonym → { alpha, beta }
  const prefs = new Map();       // person → { questions, told }
  const asked = new Map();       // incident id → Set of people asked
  const lastAsked = new Map();   // person → when they were last asked
  const recent = new Map();      // 'reports:' / 'answers:' + pseudonym → times
  let nextId = 1;

  const db = () => Boolean(geo && geo.enabled && geo.enabled());
  const pseudonym = (person) => createHmac('sha256', secret).update(`reporter:${person}`).digest('base64url').slice(0, 22);
  const reporterOf = (who) => reporters.get(who) || { ...PRIOR };
  const quiet = (what) => (e) => log.error(`incidents: cannot ${what} —`, e && e.message ? e.message : e);
  const active = () => [...incidents.values()].filter((i) => i.status === 'active');

  // At most `limit` in the last hour, and this one counted if it goes ahead.
  function allowed(kind, who, limit) {
    const t = now();
    const times = (recent.get(`${kind}:${who}`) || []).filter((x) => t - x < 3600);
    if (times.length >= limit) { recent.set(`${kind}:${who}`, times); return false; }
    times.push(t);
    recent.set(`${kind}:${who}`, times);
    return true;
  }

  function settle(inc, t) {
    const how = settled(inc, t);
    if (!how) return inc;
    const bump = (who, field) => {
      const r = { ...reporterOf(who) };
      r[field] += 1;
      reporters.set(who, r);
      if (db()) geo.saveReporter({ reporter: who, ...r }).catch(quiet('keep a reliability'));
    };
    for (const who of inc.supporters) bump(who, how === 'confirmed' ? 'alpha' : 'beta');
    for (const who of inc.dismissers) bump(who, how === 'confirmed' ? 'beta' : 'alpha');
    return { ...inc, resolved: true };
  }

  function keep(inc) {
    incidents.set(inc.id, inc);
    if (inc.status !== 'active') { incidents.delete(inc.id); asked.delete(inc.id); }
    if (db()) geo.saveIncident(inc).catch(quiet('save an incident'));
  }

  function evidence(inc, ev) {
    const next = settle(withEvidence(inc, ev), ev.at);
    keep(next);
    if (db()) {
      geo.addIncidentEvidence({ incident: inc.id, reporter: ev.reporter, kind: ev.kind, weight: logit(ev.w), at: ev.at })
        .catch(quiet('keep an answer'));
    }
    return next;
  }

  return {
    // Whatever is still active, with its evidence, and everyone's
    // reliability and questions. Nothing to load without a database.
    async load() {
      if (!db()) return 0;
      const got = await geo.loadIncidents();
      for (const r of got.reporters) reporters.set(r.reporter, { alpha: Number(r.alpha), beta: Number(r.beta) });
      for (const p of got.prefs) prefs.set(String(p.person), { questions: Boolean(p.questions), told: Boolean(p.told) });
      for (const inc of got.incidents) {
        incidents.set(inc.id, inc);
        nextId = Math.max(nextId, Number(inc.id) + 1);
      }
      return incidents.size;
    },

    // What everyone is shown, as `person` sees it.
    list(person = null) {
      const t = now();
      const me = person ? pseudonym(person) : null;
      return active().filter((i) => shown(i, t)).map((i) => viewOf(i, t, me));
    },

    // A new report, or one more for the same thing. { incident, merged } or
    // { error, status }.
    async report(person, { kind, detail = '', latitude, longitude, heading = null, speed = null } = {}) {
      if (!Object.hasOwn(KINDS, kind)) return { error: 'what kind of report?', status: 400 };
      const what = kind === 'hazard' && DETAILS.includes(detail) ? detail : '';
      if (!(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) return { error: 'where?', status: 400 };
      const way = finite(heading) ? ((Number(heading) % 360) + 360) % 360 : null;
      const who = pseudonym(person);
      if (!allowed('reports', who, LIMITS.reports)) return { error: `${LIMITS.reports} reports an hour is the most`, status: 429 };
      const t = now();
      const at = seenAt({ latitude: Number(latitude), longitude: Number(longitude), heading: way, speed });
      const w = reliability(reporterOf(who));
      const same = sameAs(active(), { kind, ...at, heading: way }, t);
      if (same) {
        if (same.supporters.has(who)) return { incident: viewOf(same, t, who), merged: true };
        const next = evidence(same, { kind: 'report', reporter: who, w, at: t });
        return { incident: viewOf(next, t, who), merged: true };
      }
      let inc = {
        id: null, kind, detail: what, latitude: at.latitude, longitude: at.longitude, heading: way,
        reporter: who, createdAt: t, lastAt: t, logit: 0, peak: 0, status: 'active', resolved: false,
        supporters: new Set(), dismissers: new Set(), there: 0, notThere: 0,
      };
      inc = withEvidence(inc, { kind: 'report', reporter: who, w, at: t });
      if (db()) {
        try {
          inc.id = await geo.saveIncident(inc);
        } catch (e) {
          quiet('save an incident')(e);
          return { error: 'could not save the report', status: 500 };
        }
        geo.addIncidentEvidence({ incident: inc.id, reporter: who, kind: 'report', weight: logit(w), at: t })
          .catch(quiet('keep a report'));
      } else {
        inc.id = nextId++;
      }
      incidents.set(inc.id, inc);
      return { incident: viewOf(inc, t, who), merged: false };
    },

    // "Still there" (`there`) or "not there" from somebody who passed it.
    async answer(person, id, answer) {
      const inc = incidents.get(Number(id));
      if (!inc || inc.status !== 'active') return { error: 'no such report', status: 404 };
      if (answer !== 'there' && answer !== 'not_there') return { error: 'there or not_there', status: 400 };
      const who = pseudonym(person);
      if (inc.reporter === who) return { error: 'that is your own report', status: 409 };
      if (inc.supporters.has(who) || inc.dismissers.has(who)) return { incident: viewOf(inc, now(), who), again: true };
      if (!allowed('answers', who, LIMITS.answers)) return { error: `${LIMITS.answers} answers an hour is the most`, status: 429 };
      const next = evidence(inc, { kind: answer, reporter: who, w: reliability(reporterOf(who)), at: now() });
      return { incident: next.status === 'active' ? viewOf(next, now(), who) : null };
    },

    // Taking back your own report, as long as nobody else has backed it.
    async withdraw(person, id) {
      const inc = incidents.get(Number(id));
      const who = pseudonym(person);
      if (!inc || inc.reporter !== who) return false;
      if (inc.supporters.size > 1 || inc.there > 0) return false;
      keep({ ...inc, status: 'removed', endedAt: now(), resolved: true });
      return true;
    },

    // Once a minute: what has faded, and what has settled. True when the map
    // should be redrawn because something went from it.
    async sweep() {
      const t = now();
      let changed = false;
      for (const inc of active()) {
        const next = settle({ ...inc, status: statusOf(inc, t) }, t);
        if (next.status === inc.status && next.resolved === inc.resolved) continue;
        keep(next);
        if (next.status !== 'active') changed = true;
      }
      return changed;
    },

    // Whether to ask this person "still there?" about something now, and
    // what: the incident's view, or null. Asking is remembered.
    askFor(person) {
      const id = String(person.id);
      const t = now();
      if (!this.questions(id)) return null;
      if (t - (lastAsked.get(id) ?? -Infinity) < ASK.every) return null;
      const inc = toAsk(active(), person, t, { me: pseudonym(id), asked: (i) => asked.get(i)?.has(id) });
      if (!inc) return null;
      lastAsked.set(id, t);
      if (!asked.has(inc.id)) asked.set(inc.id, new Set());
      asked.get(inc.id).add(id);
      return viewOf(inc, t);
    },

    questions(person) { return prefs.get(String(person))?.questions ?? true; },
    told(person) { return prefs.get(String(person))?.told ?? false; },
    setPrefs(person, change) {
      const id = String(person);
      const next = { questions: this.questions(id), told: this.told(id), ...change };
      prefs.set(id, next);
      if (db()) geo.saveRoadPrefs({ person: id, ...next }).catch(quiet('keep a preference'));
      return next;
    },

    // /stop: their answers, reliability and preferences go; the reports stay
    // on the map as anybody's, without anything tying them back.
    async forget(person) {
      const id = String(person);
      const who = pseudonym(id);
      reporters.delete(who);
      prefs.delete(id);
      lastAsked.delete(id);
      for (const set of asked.values()) set.delete(id);
      for (const [k, inc] of incidents) {
        if (inc.reporter !== who && !inc.supporters.has(who) && !inc.dismissers.has(who)) continue;
        const supporters = new Set(inc.supporters); supporters.delete(who);
        const dismissers = new Set(inc.dismissers); dismissers.delete(who);
        incidents.set(k, { ...inc, reporter: inc.reporter === who ? '' : inc.reporter, supporters, dismissers });
      }
      if (db()) await geo.forgetReporter({ person: id, reporter: who }).catch(quiet('forget a reporter'));
    },

    // For tests and /healthz-like counts.
    get size() { return active().length; },
  };
}
