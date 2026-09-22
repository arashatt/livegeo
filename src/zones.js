// zones.js — private places: where somebody's circle is not told they are.
//
// A private place hides its owner whenever they are inside it. Hiding means
// the point is never sent. A blur drawn over exact coordinates hides nothing
// from anybody who opens the network tab, so what leaves the server for a
// viewer who may not see exactly is the blur itself — a centre and a radius —
// and the page draws what it was given. The exact position goes only to the
// person themselves and to admins (canActFor in circles.js), which is the same
// line that already decides who may erase or publish a path.
//
// Pure functions first, so the rules are tested without a database; the store
// at the bottom keeps places in memory and writes them through, the same
// arrangement circles.js has, because every position is checked against it.

import { randomBytes } from 'node:crypto';
import { metresBetween } from './positions.js';

export const ZONE_MIN = 200;
export const ZONE_MAX = 5000;
export const ZONES_EACH = 10;

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

// A path as a viewer who may not see exactly is shown it: fixes inside a
// private place are gone, and the first fix after a hidden stretch says so
// with `gap`, so nothing draws a line across what was hidden or reads a time
// off it.
//
// Chronological out, whatever order came in (history arrives newest first).
// A gap already marked stays marked, so veiling twice changes nothing.
export function veilPoints(points, zones = []) {
  const list = (points || []).filter(Boolean);
  // Number(null) is 0, a perfectly good time, so null is checked for first.
  const timed = list.every((q) => q.at !== null && q.at !== undefined && Number.isFinite(Number(q.at)));
  const ordered = timed ? [...list].sort((a, b) => a.at - b.at) : list;
  const out = [];
  let skipped = false;
  for (const q of ordered) {
    if (zoneAt(zones, q.latitude, q.longitude)) { skipped = true; continue; }
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

// Somebody, as a viewer who may not see exactly is shown them: inside a
// private place, the place's centre and radius stand in for where they are.
export function veilPerson(p, zones = []) {
  const trail = veilPoints(p.trail || [], zones);
  const out = { ...p, trail };
  if (p.latitude === null || p.latitude === undefined) return out;
  const cover = zoneAt(zones, p.latitude, p.longitude);
  if (!cover) return out;
  return {
    ...out,
    latitude: cover.latitude,
    longitude: cover.longitude,
    accuracy: cover.radius,
    heading: null,
    hidden: true,
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

export function makeZones({ geo = null, random = secureRandom } = {}) {
  const zones = new Map();     // owner -> [{ id, owner, name, latitude, longitude, radius }]
  const zonesOf = (id) => zones.get(String(id)) || [];

  return {
    get enabled() { return Boolean(geo && geo.enabled && geo.enabled()); },

    async load() {
      if (!this.enabled) return false;
      zones.clear();
      for (const z of await geo.listZones()) {
        const key = String(z.owner);
        if (!zones.has(key)) zones.set(key, []);
        zones.get(key).push(z);
      }
      return true;
    },

    // What the owner sees of their own places. Never anybody else's.
    of: (id) => zonesOf(id).map(({ id: zid, name, latitude, longitude, radius }) =>
      ({ id: zid, name, latitude, longitude, radius })),

    async create({ owner, name = '', latitude, longitude, radius }) {
      const centre = offsetCentre({ latitude, longitude, radius }, random);
      const id = await geo.createZone({ owner: String(owner), name, ...centre, radius });
      const key = String(owner);
      zones.set(key, [...zonesOf(key), { id, owner: key, name, ...centre, radius }]);
      return { id, name, ...centre, radius };
    },

    // Only the owner's own place; anybody else's reads as no such place.
    async remove(owner, id) {
      const key = String(owner);
      const mine = zonesOf(key);
      if (!mine.some((z) => z.id === Number(id))) return false;
      await geo.deleteZone(Number(id));
      zones.set(key, mine.filter((z) => z.id !== Number(id)));
      return true;
    },

    forget(id) { zones.delete(String(id)); },

    // Whether a position is hidden from anybody who may not see exactly: the
    // fence alerts ask, so a small fence cannot find what the blur hides.
    at: (person, latitude, longitude) => zoneAt(zonesOf(person), latitude, longitude),

    veil(p) {
      const z = zonesOf(p.id);
      return z.length ? veilPerson(p, z) : p;
    },

    veilPoints: (person, points) => veilPoints(points, zonesOf(person)),
  };
}
