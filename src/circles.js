// circles.js — who may see whom. The one gate.
//
// Every route that returns a person asks canSee(), and nothing re-derives the
// answer on its own. That is the whole design: a rule restated in six places
// is six chances for one of them to be wrong, and here being wrong means
// showing somebody where a person is who never agreed to it.
//
// The rule is short. You see yourself. Admins see everyone. Anyone else, only
// if that person granted it — and a grant runs one way: Ada letting Grace see
// her does not let Ada see Grace.
//
// Grants are held in memory and written through to the database. This process
// is the only thing that changes them, so the copy here is exact rather than
// a cache that can go stale, and a check costs a Map lookup rather than a
// query — which matters, because every position that arrives is checked
// against every open map.

// A viewer is { id, admin }. id is a Telegram user id, or null for a request
// that came in with the shared DASHBOARD_TOKEN, which has no person behind it
// and is treated as an admin for exactly as long as that token exists.
//
// Or it is somebody holding a live link (live.js): nobody in particular, who
// `sees` exactly one person, for as long as the link lasts. That viewer is
// only ever made by the stream a live link opens, so it reaches nothing else.
export function canSee(viewer, person, grants) {
  if (!viewer) return false;
  if (viewer.admin) return true;
  if (person === null || person === undefined) return false;
  if (viewer.sees !== undefined) return String(viewer.sees) === String(person);
  if (!viewer.id) return false;
  const p = String(person);
  if (String(viewer.id) === p) return true;
  return Boolean(grants?.get(String(viewer.id))?.has(p));
}

// Acting on somebody rather than looking at them — erasing their history,
// publishing their path. Seeing someone is not consent to either, so this is
// narrower than canSee: yourself, or an admin.
export function canActFor(viewer, person) {
  if (!viewer) return false;
  if (viewer.admin) return true;
  return Boolean(viewer.id) && String(viewer.id) === String(person);
}

export function makeCircles({ geo = null, admins = [], log = console } = {}) {
  // viewer -> Set(owners they may see)
  const grants = new Map();
  // Everyone the bot has met. A session is only good while its id is here, so
  // /stop — which deletes the user — ends every session they hold at once.
  const users = new Map();   // id -> { id, name, username }
  const adminSet = new Set((admins || []).map(String));
  let loaded = false;

  const add = (owner, viewer) => {
    if (!grants.has(viewer)) grants.set(viewer, new Set());
    grants.get(viewer).add(owner);
  };

  return {
    // Per-user sign-in needs somewhere to keep grants. Without a database the
    // service does exactly what it did before: admins and the shared token.
    get enabled() { return Boolean(geo && geo.enabled && geo.enabled()); },
    get loaded() { return loaded; },

    async load() {
      if (!this.enabled) return false;
      grants.clear();
      users.clear();
      for (const u of await geo.listUsers()) users.set(String(u.id), u);
      for (const g of await geo.listGrants()) add(String(g.owner), String(g.viewer));
      loaded = true;
      return true;
    },

    isAdmin: (id) => id !== null && id !== undefined && adminSet.has(String(id)),

    // Who a Telegram id is as a viewer, or null if they may not sign in at all.
    viewerFor(id) {
      if (id === null || id === undefined || id === '') return null;
      const key = String(id);
      if (adminSet.has(key)) return { id: key, admin: true };
      if (this.enabled && users.has(key)) return { id: key, admin: false };
      return null;
    },

    canSee: (viewer, person) => canSee(viewer, person, grants),

    // Recorded the first time the bot hears from somebody, and again only when
    // their name changes — not once per position.
    async seen({ id, name = '', username = '' }) {
      if (!this.enabled || id === null || id === undefined) return;
      const key = String(id);
      const had = users.get(key);
      if (had && had.name === name && had.username === username) return;
      users.set(key, { id: key, name, username });
      await geo.upsertUser({ id: key, name, username })
        .catch((e) => log.error('circles: cannot record a user —', e.message));
    },

    user: (id) => users.get(String(id)) || null,

    async grant(owner, viewer) {
      const o = String(owner);
      const v = String(viewer);
      if (o === v || !users.has(o) || !users.has(v)) return false;
      await geo.addGrant(o, v);
      add(o, v);
      return true;
    },

    async revoke(owner, viewer) {
      const o = String(owner);
      const v = String(viewer);
      await geo.removeGrant(o, v);
      grants.get(v)?.delete(o);
      return true;
    },

    // Gone entirely: /stop. The database cascades on its side; this is the
    // same thing for the copy held here.
    forget(id) {
      const key = String(id);
      users.delete(key);
      grants.delete(key);
      for (const owners of grants.values()) owners.delete(key);
    },

    // Both directions, for the "who can see me" panel and /circle.
    circleOf(id) {
      const key = String(id);
      const name = (x) => users.get(x) || { id: x, name: '', username: '' };
      const canSeeMe = [];
      for (const [viewer, owners] of grants) if (owners.has(key)) canSeeMe.push(name(viewer));
      const iCanSee = [...(grants.get(key) || [])].map(name);
      return { canSeeMe, iCanSee };
    },
  };
}
