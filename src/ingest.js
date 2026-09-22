// ingest.js — a watch's report, turned into the position every other part of
// this service already understands.
//
// The bot and the MTProto account each have a parser like this one
// (fromUpdate, fromMessage in positions.js), and they produce the same shape.
// So once a fix is through here, the map, the history, the noise filter and
// the fences treat it exactly as if it had come from Telegram — including
// merging it with the same person's Telegram sharing, because the person id
// is the device owner's Telegram id.
//
// Pure: no clock of its own, no I/O. The rules are what is worth testing.

// How far off the watch's clock may be before its times are not believed.
const FUTURE_SLACK = 60;
// How old a buffered fix may be and still be accepted. A watch that was out
// of signal on a hike uploads its whole route; one that was in a drawer for a
// week is not describing anything that matters now.
const MAX_AGE = 24 * 3600;
// How long a watch counts as live after a fix, when it does not say. Long
// enough to cover the gap between reports, short enough that a watch that
// stopped reporting stops being called live on its own.
const DEFAULT_LIVE = 15 * 60;
const MAX_LIVE = 24 * 3600;
// Beyond this the fix is not a location in any useful sense.
const MAX_ACCURACY = 5000;

export const MAX_BATCH = 500;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A single fix, a list of them, or { fixes: [...] } — whichever the watch
// found easiest to send.
export function readFixes(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.fixes)) return body.fixes;
  if (body && typeof body === 'object') return [body];
  return [];
}

// { position } or { error }. `now` is seconds.
export function fromDevice(fix, { owner, name = '', now }) {
  if (!fix || typeof fix !== 'object') return { error: 'not a fix' };
  const latitude = num(fix.lat ?? fix.latitude);
  const longitude = num(fix.lon ?? fix.lng ?? fix.longitude);
  if (latitude === null || longitude === null) return { error: 'no position' };
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { error: 'position out of range' };
  // Exactly 0,0 is a GPS that has not got a fix yet and said so badly.
  if (latitude === 0 && longitude === 0) return { error: 'no fix yet' };

  let at = num(fix.at ?? fix.time);
  // Milliseconds are the commonest mistake; a time past the year 33658 in
  // seconds is one.
  if (at !== null && at > 1e12) at = Math.floor(at / 1000);
  if (at === null) at = now;
  at = Math.floor(at);
  if (at > now + FUTURE_SLACK) return { error: 'from the future' };
  if (at < now - MAX_AGE) return { error: 'too old' };

  const accuracy = num(fix.accuracy);
  if (accuracy !== null && (accuracy < 0 || accuracy > MAX_ACCURACY)) return { error: 'accuracy out of range' };

  let heading = num(fix.heading);
  if (heading !== null && (heading < 0 || heading > 360)) heading = null;

  // The watch may say how long its sharing session runs; it is capped either
  // way, so a bad clock cannot make somebody "live" for a year.
  const until = num(fix.until);
  const liveUntil = Math.min(
    until !== null && until > at ? Math.floor(until > 1e12 ? until / 1000 : until) : at + DEFAULT_LIVE,
    at + MAX_LIVE,
  );

  return {
    position: {
      id: String(owner),
      chat: null,
      name,
      latitude,
      longitude,
      accuracy,
      heading,
      at,
      // A watch ending its session sends one last fix marked stopped, which
      // keeps the place it was last seen and stops calling it live.
      liveUntil: fix.stopped === true ? null : liveUntil,
      stopped: fix.stopped === true,
    },
  };
}
