// track.js — a path as it was travelled, without the fixes a phone got wrong.
//
// A phone now and then reports a fix from a cell tower or a bad satellite
// lock: one point hundreds of metres or kilometres off, then back. Drawn,
// that is a spike across the map; in a GPX file it is a journey nobody made.
// The rule is the traffic research's (anomaly detection, SPEC §5): a fix is
// not believed when getting there from the last good one would have taken an
// impossible speed, and a later fix carries on from the last good one as
// though it never happened.
//
// Two things look like that and are not wrong, and both are kept:
//   - A real jump: a flight, or a phone switched off for a day. Nothing
//     after it goes back, so the far fix becomes the new last good one.
//   - Fixes delivered in a bunch. Telegram can hold a few updates back and
//     hand them over together, all stamped with the moment they arrived, so
//     they seem to be metres apart in no time at all. They lie along the way
//     that was travelled, which a spike never does.
// And the newest fix is always kept: nothing has come after it yet to say
// whether it was wrong, and it is where the map says somebody is.
//
// Pure, so every case is tested without a server. Oldest first in and out.

import { metresBetween } from './positions.js';

// About 250 km/h: faster than anybody travels on a road.
export const MAX_SPEED = 70;
// How far off the way travelled a fix has to be before it can be a spike,
// and the slack in "reachable" for fixes without their own accuracy.
export const SPIKE_OFF = 100;
// The most bad fixes in a row that are taken out as one spike. Longer than
// that it is where the phone really was, or at least cannot be shown not to be.
export const SPIKE_RUN = 3;

const good = (q) => q && Number.isFinite(Number(q.latitude)) && Number.isFinite(Number(q.longitude))
  && q.latitude !== null && q.longitude !== null;
const timed = (q) => q.at !== null && q.at !== undefined && Number.isFinite(Number(q.at));

// Metres from `q` to the straight way from `a` to `c`, on a local flat
// projection: good to well under a metre at the distances a spike is judged at.
export function metresOffWay(a, c, q) {
  const rad = Math.PI / 180;
  const k = 6371000 * rad;
  const cos = Math.cos(a.latitude * rad);
  const cx = (c.longitude - a.longitude) * cos * k;
  const cy = (c.latitude - a.latitude) * k;
  const qx = (q.longitude - a.longitude) * cos * k;
  const qy = (q.latitude - a.latitude) * k;
  const length = cx * cx + cy * cy;
  const t = length ? Math.max(0, Math.min(1, (qx * cx + qy * cy) / length)) : 0;
  return Math.hypot(qx - t * cx, qy - t * cy);
}

export function cleanTrack(points, { maxSpeed = MAX_SPEED, off = SPIKE_OFF, run = SPIKE_RUN } = {}) {
  const list = (points || []).filter(good);
  const withTimes = list.every(timed);
  // Sorted when they all have times: a watch's buffer can arrive after newer
  // fixes. Stable, so fixes with the same time keep the order they came in.
  const ordered = withTimes ? [...list].sort((a, b) => a.at - b.at) : list;

  // The same fix twice says nothing new.
  const once = [];
  for (const q of ordered) {
    const last = once[once.length - 1];
    if (last && last.at === q.at && last.latitude === q.latitude && last.longitude === q.longitude) {
      if (q.gap && !last.gap) once[once.length - 1] = { ...last, gap: true };
      continue;
    }
    once.push(q);
  }
  if (!withTimes) return once;

  // Could the phone have got from a to b in the time between them? A second
  // at least, so two fixes stamped the same moment are not infinitely fast.
  const reachable = (a, b) => metresBetween(a, b) <= maxSpeed * Math.max(1, b.at - a.at) + off;

  const out = [];
  let carryGap = false;
  for (let i = 0; i < once.length;) {
    const q = once[i];
    const last = out[out.length - 1];
    if (last && !reachable(last, q)) {
      // Either q starts a real jump, or q and up to `run - 1` after it are a
      // bad stretch and a later fix carries on from `last`. That fix is where
      // the path resumes, provided everything skipped is well off the way
      // from `last` to it: bunched fixes along the way are not a spike.
      let resume = -1;
      for (let j = i + 1; j < once.length && j <= i + run; j++) {
        if (reachable(last, once[j])) { resume = j; break; }
      }
      if (resume > 0 && once.slice(i, resume).every((b) => metresOffWay(last, once[resume], b) > off)) {
        // A gap marked on a fix that goes still marks where the path breaks.
        carryGap = carryGap || once.slice(i, resume).some((b) => b.gap);
        i = resume;
        continue;
      }
    }
    out.push(carryGap && out.length && !q.gap ? { ...q, gap: true } : q);
    carryGap = false;
    i++;
  }
  return out;
}
