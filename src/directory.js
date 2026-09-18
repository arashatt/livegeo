// directory.js — who a numeric id belongs to.
//
// A position carries the sender's id and whatever name happened to ride along
// on the message, which is very often nothing: an id like 108205212 is all the
// dashboard has to show. Telegram knows the rest, but asking costs a round
// trip and counts against rate limits, so answers are kept for a while — and
// so are the misses, because a hover should not re-ask about an account that
// has already said no once.
//
// The fetching lives behind `attach`, so the server can be listening (and
// answering /healthz) before Telegram is connected, and so this file can be
// tested without an account.

const MINUTE = 60 * 1000;

// Shapes a Telegram entity into the little the dashboard needs. Pure, and the
// only part that knows what the library calls things.
export function personOf(entity, id) {
  const name = [entity?.firstName, entity?.lastName].filter(Boolean).join(' ').trim();
  return {
    id: String(id),
    // Groups and channels carry a title where a person carries a name.
    name: name || entity?.title || '',
    username: entity?.username ? `@${entity.username}` : '',
    photo: Boolean(entity?.photo),
  };
}

// An id we could not resolve still gets an answer, so the page has something
// to render and does not sit on a spinner forever.
const unknown = (id) => ({ id: String(id), name: '', username: '', photo: false });

export function makeDirectory({
  now = Date.now,
  ttl = 15 * MINUTE,        // names and usernames change, but rarely
  missTtl = MINUTE,         // an unresolvable id is worth retrying, eventually
  photoTtl = 60 * MINUTE,
} = {}) {
  let client = null;
  const people = new Map();   // id -> { at, person, ok }
  const photos = new Map();   // id -> { at, bytes }  (bytes null = no photo)

  const fresh = (hit, life) => hit && now() - hit.at < life;

  return {
    attach(c) { client = c; },

    async lookup(id) {
      const key = String(id);
      const hit = people.get(key);
      if (fresh(hit, hit?.ok ? ttl : missTtl)) return hit.person;
      if (!client) return unknown(key);

      try {
        const person = personOf(await client.getEntity(key), key);
        people.set(key, { at: now(), person, ok: true });
        return person;
      } catch {
        // Usually means the session has no access hash for this id — it can
        // happen for someone seen only through a channel. Not worth a log line
        // per hover.
        const person = unknown(key);
        people.set(key, { at: now(), person, ok: false });
        return person;
      }
    },

    // Returns the photo bytes, or null when there is none to show.
    async photo(id) {
      const key = String(id);
      const hit = photos.get(key);
      if (fresh(hit, photoTtl)) return hit.bytes;
      if (!client) return null;

      try {
        const bytes = await client.downloadProfilePhoto(key);
        const out = bytes && bytes.length ? Buffer.from(bytes) : null;
        photos.set(key, { at: now(), bytes: out });
        return out;
      } catch {
        photos.set(key, { at: now(), bytes: null });
        return null;
      }
    },
  };
}
