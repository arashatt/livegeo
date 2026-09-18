// positions.js — the part of this service that has no idea Telegram exists.
//
// Everything arriving over MTProto is turned into one plain shape here, and
// kept here, so the whole of it can be tested without a network or an account:
//
//   { id, name, latitude, longitude, accuracy, heading, at, liveUntil, stopped }
//
// A live location, per core.telegram.org/api/live-location, is one message
// that its sender keeps editing. So a position update is an *edit*, not a new
// message, and the same sender keeps the same entry rather than adding one.

// MTProto constructors we care about, matched by name rather than by class so
// that a synthetic object in a test is as good as a real one off the wire.
const GEO_LIVE = 'MessageMediaGeoLive';
const GEO_STATIC = 'MessageMediaGeo';
const POINT_EMPTY = 'GeoPointEmpty';

const cn = (o) => (o && (o.className || o.CONSTRUCTOR_NAME)) || '';
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Telegram sends ids as BigInt-ish objects; a string is what we key on.
function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const inner = value.userId ?? value.channelId ?? value.chatId ?? value.value;
    if (inner !== undefined && inner !== null) return String(inner);
  }
  return String(value);
}

export function senderOf(message) {
  return idOf(
    message?.senderId
    ?? message?.fromId?.userId ?? message?.fromId
    ?? message?.peerId?.userId ?? message?.peerId
  );
}

export function chatOf(message) {
  return idOf(message?.chatId ?? message?.peerId);
}

// Returns null for any message that is not a location, so a caller can hand
// it every message it sees.
export function fromMessage(message, { at = Math.floor(Date.now() / 1000) } = {}) {
  const media = message?.media;
  const kind = cn(media);
  if (kind !== GEO_LIVE && kind !== GEO_STATIC) return null;

  const id = senderOf(message);
  if (!id) return null;

  const geo = media.geo;
  // How a receiver learns that sharing ended. Note that `stopped` belongs to
  // inputMediaGeoLive, which is the *sending* side; the messageMediaGeoLive
  // that comes back has no such field, so an empty point is the real signal
  // and the flag is only a belt-and-braces check for anything that adds one.
  //   messageMediaGeoLive#b940c666 flags:# geo:GeoPoint heading:flags.0?int
  //     period:int proximity_notification_radius:flags.1?int = MessageMedia;
  const stopped = cn(geo) === POINT_EMPTY || media.stopped === true;

  const latitude = num(geo?.lat);
  const longitude = num(geo?.long ?? geo?.lng);
  if (!stopped && (latitude === null || longitude === null)) return null;
  if (latitude !== null && Math.abs(latitude) > 90) return null;
  if (longitude !== null && Math.abs(longitude) > 180) return null;

  const period = kind === GEO_LIVE ? num(media.period) : null;

  return {
    id,
    chat: chatOf(message),
    name: nameOf(message),
    latitude,
    longitude,
    accuracy: num(geo?.accuracyRadius ?? geo?.accuracy_radius),
    heading: kind === GEO_LIVE ? num(media.heading) : null,
    at,
    // A deadline rather than a flag: if the edit that ends sharing never
    // arrives, the map stops calling it live on its own.
    liveUntil: !stopped && period && period > 0 ? at + period : null,
    stopped,
  };
}

function nameOf(message) {
  const s = message?.sender;
  if (!s) return '';
  const named = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
  return named || (s.username ? `@${s.username}` : '');
}

// Metres between two points. Haversine rather than comparing degrees: a degree
// of longitude is 111km at the equator and nothing at all at the pole, so a
// threshold in degrees means something different for every person on the map.
export function metresBetween(a, b) {
  if (!a || !b || a.latitude === null || b.latitude === null) return Infinity;
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// How far a point has to be from the last one before it is evidence of travel
// rather than of a phone sitting still.
//
// A stationary phone does not report a stationary position: the fix wanders
// inside its own accuracy radius, several times a minute. Recorded, that draws
// a scribble where somebody stood. And since two fixes each accurate to r can
// differ by nearly 2r through noise alone, the radius itself is the least that
// can count as movement — below it there is simply no information.
//
// `minMove` is the floor for when Telegram reports no accuracy, or an
// improbably good one.
export function movementThreshold(prev, next, minMove) {
  return Math.max(minMove, prev?.accuracy ?? 0, next?.accuracy ?? 0);
}

// ---------- the store ----------

export class Positions {
  constructor({ staleAfter = 3600, trailMax = 120, minMove = 25,
                now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.staleAfter = staleAfter;
    this.trailMax = trailMax;
    this.minMove = minMove;
    this.now = now;
    this.people = new Map();
  }

  // Returns the stored entry when something actually changed, and null when
  // the update was a repeat — so a caller can avoid waking every browser for
  // a phone reporting the same spot from a pocket.
  update(position) {
    if (!position || !position.id) return null;
    const prev = this.people.get(position.id);

    const moved = !prev
      || prev.latitude === null
      || position.latitude === null
      || metresBetween(prev, position) > movementThreshold(prev, position, this.minMove);

    const wasLive = Boolean(prev && prev.liveUntil);
    const isLive = Boolean(position.liveUntil);
    if (!moved && wasLive === isLive && prev.stopped === position.stopped) {
      // Still there, just not anywhere new. The entry has to stay fresh or a
      // person standing still expires out of the map after STALE_AFTER, but
      // there is nothing to wake an open map for.
      prev.at = position.at;
      prev.liveUntil = position.liveUntil;
      if (position.accuracy !== null && position.accuracy !== undefined) prev.accuracy = position.accuracy;
      return null;
    }

    const trail = prev ? prev.trail.slice() : [];
    if (moved && position.latitude !== null) {
      trail.push({ latitude: position.latitude, longitude: position.longitude, at: position.at });
    }

    const next = {
      ...position,
      // A stop keeps the last place it was seen rather than blanking the map.
      // So does a reading that did not clear the threshold: the marker stays
      // on the last point actually known, instead of twitching around it.
      latitude: (moved ? position.latitude : prev?.latitude) ?? prev?.latitude ?? null,
      longitude: (moved ? position.longitude : prev?.longitude) ?? prev?.longitude ?? null,
      name: position.name || prev?.name || '',
      trail: trail.slice(-this.trailMax),
      firstSeen: prev?.firstSeen ?? position.at,
    };
    this.people.set(position.id, next);
    return next;
  }

  get(id) { return this.people.get(String(id)) || null; }

  // Anything nobody has updated for `staleAfter` is dropped rather than left
  // on the map looking current.
  list() {
    const cutoff = this.now() - this.staleAfter;
    const out = [];
    for (const [id, p] of this.people) {
      if (p.at < cutoff) { this.people.delete(id); continue; }
      out.push({ ...p, live: Boolean(p.liveUntil && p.liveUntil > this.now()) });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  forget(id) { return this.people.delete(String(id)); }
  clear() { this.people.clear(); }
}
