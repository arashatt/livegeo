// privacy.js — what somebody's circle is not told.
//
// Two ways not to be followed, and one mechanism behind both:
//
//   private places  somewhere that hides you whenever you are in it
//   Passive mode    a stretch of time that hides you wherever you are
//
// Hiding means the point is never sent. A blur drawn over exact coordinates
// hides nothing from anybody who opens the network tab, so what leaves the
// server for a viewer who may not see exactly is the blur itself — a centre
// and a radius — and the page draws what it was given. The exact position
// goes only to the person themselves and to admins (canActFor in circles.js),
// which is the same line that already decides who may erase or publish a path.
//
// Pure functions first, so the rules are tested without a database; the store
// at the bottom keeps places and windows in memory and writes them through,
// the same arrangement circles.js has, because every position is checked
// against it.

import { randomBytes } from 'node:crypto';
import { metresBetween } from './positions.js';

export const ZONE_MIN = 200;
export const ZONE_MAX = 5000;
export const ZONES_EACH = 10;
// How big the Passive blur is, and how long before switching it on is hidden
// too. Turning it on as you arrive somewhere should not leave the last few
// minutes of path pointing at the door you just walked through.
export const PASSIVE_RADIUS = 5000;
export const PASSIVE_LEAD = 15 * 60;
export const PASSIVE_MAX_MINUTES = 24 * 60;

// A uniform number in [0, 1) that nobody can predict. Math.random would do
// for the geometry, but the whole point of the offset below is that it cannot
// be guessed, so it comes from the same source as every token here.
export function secureRandom() {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

const R = 6371000;
const rad = Math.PI / 180;

// The point `metres` away from (latitude, longitude) along `bearing` radians
// from north. Spherical rather than flat so it stays right away from the
// equator, where a degree of longitude is much less than a degree of latitude.
export function destination({ latitude, longitude }, metres, bearing) {
  const d = metres / R;
  const p1 = latitude * rad;
  const l1 = longitude * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearing));
  const l2 = l1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { latitude: p2 / rad, longitude: ((l2 / rad + 540) % 360) - 180 };
}

// Where a private place's circle is actually centred: somewhere within half
// its radius of the spot that was picked, uniformly over that disc.
//
// This is what defeats the known attack on privacy zones. A path cut where it
// enters a circle around somebody's door ends on that circle, and a few trips
// are enough to fit it and recover the centre — the door. Centred elsewhere,
// fitting the circle recovers only this point, and from there the door is
// anywhere within half the radius, all of it equally likely. Everything within
// half the radius of the spot stays hidden whichever way the offset fell.
export function offsetCentre({ latitude, longitude, radius }, random = secureRandom) {
  const distance = (radius / 2) * Math.sqrt(random());
  return destination({ latitude, longitude }, distance, 2 * Math.PI * random());
}

// The place a point is inside, or null.
export function zoneAt(zones, latitude, longitude) {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return null;
  const here = { latitude: Number(latitude), longitude: Number(longitude) };
  for (const z of zones || []) {
    if (metresBetween(here, z) <= z.radius) return z;
  }
  return null;
}

// The Passive window running at `now`, or null.
export function activeWindow(windows, now) {
  for (const w of windows || []) if (now >= w.start && now < w.end) return w;
  return null;
}

// Whether a fix taken at `at` falls in a Passive window — or in the quarter
// hour before one began.
export function inWindow(windows, at) {
  if (at === null || at === undefined || !Number.isFinite(Number(at))) return false;
  const t = Number(at);
  return (windows || []).some((w) => t >= w.start - PASSIVE_LEAD && t <= w.end);
}

// A path as a viewer who may not see exactly is shown it: fixes inside a
// private place or a Passive window are gone, and the first fix after a hidden
// stretch says so with `gap`, so nothing draws a line across what was hidden
// or reads a time off it.
//
// Chronological out, whatever order came in (history arrives newest first).
// A gap already marked stays marked, so veiling twice changes nothing.
export function veilPoints(points, { zones = [], windows = [] } = {}) {
  const list = (points || []).filter(Boolean);
  // Number(null) is 0, a perfectly good time, so null is checked for first.
  const timed = list.every((q) => q.at !== null && q.at !== undefined && Number.isFinite(Number(q.at)));
  const ordered = timed ? [...list].sort((a, b) => a.at - b.at) : list;
  const out = [];
  let skipped = false;
  for (const q of ordered) {
    if (inWindow(windows, q.at) || zoneAt(zones, q.latitude, q.longitude)) { skipped = true; continue; }
    const rest = withoutGap(q);
    // A gap before the first fix shown is not a gap in anything.
    out.push(out.length && (q.gap || skipped) ? { ...rest, gap: true } : rest);
    skipped = false;
  }
  return out;
}

function withoutGap(q) {
  const { gap, ...rest } = q;
  return rest;
}

// Somebody, as a viewer who may not see exactly is shown them. `passive` is
// the blur currently standing in for them while Passive mode is on.
export function veilPerson(p, { zones = [], windows = [], passive = null } = {}) {
  const trail = veilPoints(p.trail || [], { zones, windows });
  const out = { ...p, trail };
  if (p.latitude === null || p.latitude === undefined) return out;
  const cover = passive || zoneAt(zones, p.latitude, p.longitude);
  if (!cover) return out;
  return {
    ...out,
    latitude: cover.latitude,
    longitude: cover.longitude,
    accuracy: cover.radius,
    heading: null,
    hidden: true,
    ...(passive ? { passive: true } : {}),
  };
}

// How much to take off each end of a shared path: a few hundred metres,
// different every time, so knowing the rule does not undo it.
export function trimLengths(random = secureRandom) {
  return { start: 200 + 300 * random(), end: 200 + 300 * random() };
}

// A path with its first `start` and last `end` metres removed, whole fixes at
// a time. Distance is counted only along what was travelled in view — the
// chord across a hidden stretch is not a distance anybody saw. Too short to
// lose both ends and keep two fixes, it comes back empty.
export function trimEnds(points, { start, end }) {
  const list = points || [];
  const along = (from, step) => {
    let walked = 0;
    let i = from;
    while (i + step >= 0 && i + step < list.length && walked < (step > 0 ? start : end)) {
      const a = list[i];
      const b = list[i + step];
      // Moving forward, the gap mark is on the far fix; moving back, on the near one.
      const across = step > 0 ? b.gap : a.gap;
      if (!across) walked += metresBetween(a, b);
      i += step;
    }
    return walked >= (step > 0 ? start : end) ? i : null;
  };
  if (list.length < 2) return [];
  const first = along(0, 1);
  const last = along(list.length - 1, -1);
  if (first === null || last === null || last - first < 1) return [];
  const kept = list.slice(first, last + 1);
  if (kept[0].gap) kept[0] = withoutGap(kept[0]);
  return kept;
}

// Where a path resumes after a hidden stretch, as indexes — how a share keeps
// its gaps beside a LineString, which has no way to say "and then a jump".
export function breaksOf(points) {
  const out = [];
  (points || []).forEach((q, i) => { if (q && q.gap) out.push(i); });
  return out;
}

export function withBreaks(points, breaks) {
  const at = new Set((breaks || []).map(Number));
  return (points || []).map((q, i) => (at.has(i) ? { ...q, gap: true } : q));
}

// ---------------------------------------------------------------- the store

export function makePrivacy({ geo = null, log = console, random = secureRandom,
                              now = () => Math.floor(Date.now() / 1000) } = {}) {
  const zones = new Map();     // owner -> [{ id, owner, name, latitude, longitude, radius }]
  const windows = new Map();   // person -> [{ id, start, end }]
  // The blur standing in for somebody in Passive mode. Chosen when it starts
  // and again only when they leave it, so standing still does not make it
  // wander and give away the middle.
  const discs = new Map();     // person -> { latitude, longitude, radius }

  const zonesOf = (id) => zones.get(String(id)) || [];
  const windowsOf = (id) => windows.get(String(id)) || [];

  function discFor(person, latitude, longitude) {
    const key = String(person);
    const held = discs.get(key);
    if (held && latitude !== null && latitude !== undefined
        && metresBetween({ latitude, longitude }, held) <= held.radius) return held;
    if (latitude === null || latitude === undefined) return held || null;
    const centre = offsetCentre({ latitude, longitude, radius: PASSIVE_RADIUS }, random);
    const disc = { ...centre, radius: PASSIVE_RADIUS };
    discs.set(key, disc);
    return disc;
  }

  return {
    get enabled() { return Boolean(geo && geo.enabled && geo.enabled()); },

    async load() {
      if (!this.enabled) return false;
      zones.clear();
      windows.clear();
      for (const z of await geo.listZones()) {
        const key = String(z.owner);
        if (!zones.has(key)) zones.set(key, []);
        zones.get(key).push(z);
      }
      for (const w of await geo.listPassive()) {
        const key = String(w.person);
        if (!windows.has(key)) windows.set(key, []);
        windows.get(key).push({ id: w.id, start: w.start, end: w.end });
      }
      return true;
    },

    // What the owner sees of their own places. Never anybody else's.
    zonesOf: (id) => zonesOf(id).map(({ id: zid, name, latitude, longitude, radius }) =>
      ({ id: zid, name, latitude, longitude, radius })),

    async addZone({ owner, name = '', latitude, longitude, radius }) {
      const centre = offsetCentre({ latitude, longitude, radius }, random);
      const id = await geo.createZone({ owner: String(owner), name, ...centre, radius });
      const zone = { id, owner: String(owner), name, ...centre, radius };
      const key = String(owner);
      zones.set(key, [...zonesOf(key), zone]);
      return { id, name, ...centre, radius };
    },

    // Only the owner's own place; anybody else's reads as no such place.
    async removeZone(owner, id) {
      const key = String(owner);
      const mine = zonesOf(key);
      if (!mine.some((z) => z.id === Number(id))) return false;
      await geo.deleteZone(Number(id));
      zones.set(key, mine.filter((z) => z.id !== Number(id)));
      return true;
    },

    passiveOf: (id) => activeWindow(windowsOf(id), now()),

    async startPassive(person, minutes) {
      const key = String(person);
      const t = now();
      const length = Math.max(15, Math.min(PASSIVE_MAX_MINUTES, Math.round(Number(minutes) || 60))) * 60;
      const running = activeWindow(windowsOf(key), t);
      // Asking again while it is on extends it rather than stacking windows.
      if (running) {
        running.end = Math.max(running.end, t + length);
        await geo.setPassiveEnd(running.id, running.end);
        return running;
      }
      const w = { start: t, end: t + length };
      w.id = await geo.createPassive({ person: key, ...w });
      windows.set(key, [...windowsOf(key), w]);
      discs.delete(key);
      return w;
    },

    // Ends it now. The window stays: what was walked during it stays hidden.
    async endPassive(person) {
      const key = String(person);
      const running = activeWindow(windowsOf(key), now());
      if (!running) return false;
      running.end = now();
      await geo.setPassiveEnd(running.id, running.end);
      discs.delete(key);
      return true;
    },

    active: () => [...windows.entries()].flatMap(([person, list]) =>
      list.filter((w) => w.end > now()).map((w) => ({ person, end: w.end }))),

    forget(id) {
      const key = String(id);
      zones.delete(key);
      windows.delete(key);
      discs.delete(key);
    },

    // Whether a position is hidden from anybody who may not see exactly: the
    // fence alerts ask, so a small fence cannot find what the blur hides.
    hiddenAt(person, latitude, longitude, at = now()) {
      return Boolean(zoneAt(zonesOf(person), latitude, longitude)) || Boolean(activeWindow(windowsOf(person), at));
    },

    veil(p) {
      const key = String(p.id);
      const z = zonesOf(key);
      const w = windowsOf(key);
      if (!z.length && !w.length) return p;
      const passive = activeWindow(w, now()) ? discFor(key, p.latitude, p.longitude) : null;
      return veilPerson(p, { zones: z, windows: w, passive });
    },

    veilPoints(person, points) {
      return veilPoints(points, { zones: zonesOf(person), windows: windowsOf(person) });
    },
  };
}
