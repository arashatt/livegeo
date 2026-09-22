// index.js — wires the three pieces together: Telegram in, store in the
// middle, browsers out.
//
// Which Telegram is decided by config.ingest and nothing else here cares:
// both connectors hand over the same position shape and expose the same
// `client` for the directory to ask names of.

import { load } from './config.js';
import { Positions } from './positions.js';
import { serve } from './server.js';
import { connect as connectAccount } from './mtproto.js';
import { connect as connectBot } from './bot.js';
import { makeDirectory } from './directory.js';
import { makeGeo } from './geo.js';
import { randomBytes } from 'node:crypto';
import { makeLinks } from './login.js';
import { makeWatcher, announce } from './fences.js';
import { makeCircles, canActFor } from './circles.js';
import { makeDevices, makeCodes } from './devices.js';
import { makePrivacy } from './privacy.js';

const config = load();
const positions = new Positions({
  staleAfter: config.staleAfter, trailMax: config.trailMax, minMove: config.minMove,
});
// Built before either side so the page can ask about an id straight away;
// it simply answers "unknown" until Telegram is connected below.
const directory = makeDirectory();
const geo = makeGeo({ url: config.databaseUrl });
await geo.connect();

// One-time sign-in links, held in memory: they live for minutes and a restart
// losing them costs somebody one more /login.
const links = makeLinks();

// Who may see whom. DASHBOARD_USERS are admins and see everyone; everybody
// else sees themselves and whoever invited them. Needs the database — without
// it this is the admins-only service it always was, and says so.
const circles = makeCircles({ geo, admins: config.viewers });
if (await circles.load().catch((e) => { console.error('circles:', e.message); return false; })) {
  console.log('circles: on — everyone the bot meets can sign in and see their circle');
} else {
  console.log('circles: off without DATABASE_URL — only DASHBOARD_USERS can sign in');
}

// Private places and Passive mode: what somebody's circle is shown a blur of
// instead of where they are. Loaded before anything can be published.
const privacy = makePrivacy({ geo });
if (await privacy.load().catch((e) => { console.error('privacy:', e.message); return false; })) {
  console.log('privacy: private places and Passive mode are on');
}

// Watches. Paired with a code from /pair or the map, known by a token after.
const devices = makeDevices({ geo });
const codes = makeCodes();
const paired = await devices.load().catch((e) => { console.error('devices:', e.message); return 0; });
if (paired) console.log(`devices: ${paired} paired`);

// Known once the bot connects; invites are deep links into it.
let inviteLink = null;
async function makeInvite(owner) {
  if (!inviteLink || !circles.enabled) return null;
  const token = randomBytes(24).toString('base64url');
  await geo.createInvite({ token, owner, ttlSeconds: 86400 });
  return inviteLink(token);
}
// Set once Telegram is connected. Declared up here because the connector
// starts listening before it returns, so a position can reach checkFences()
// while `telegram` is still in its temporal dead zone — which would be a
// ReferenceError rather than a missed message.
let notify = null;

// Watches every position against every fence. Pure decisions, kept here so
// the state survives for as long as the process does.
const fences = makeWatcher({ floor: config.fenceFloor, dwell: config.fenceDwell });

const { publish, publishFence, forget, setBot, grant, revoke, setPassive, endPassive } = serve(positions, config, {
  directory, geo, links, circles, makeInvite, devices, codes, privacy,
  onFenceDeleted: (id) => fences.dropFence(id),
  onIngest: (fixes) => ingest(fixes),
});

// A restart used to blank the map until everyone happened to move again. What
// was last recorded is what the store would have held, so put it back before
// Telegram is even connected — the dashboard then has people the moment it is
// up rather than minutes later.
const restored = await geo.latest(config.staleAfter)
  .then((rows) => rows.filter((p) => positions.update(p)).length)
  .catch((e) => { console.error('geo:', e && e.message ? e.message : e); return 0; });
if (restored) console.log(`restored ${restored} from the last run`);

const onPosition = (position) => {
  // Fences are checked against the reading itself, before the movement filter
  // gets a say, and this ordering is load-bearing.
  //
  // update() returns null when nothing moved far enough to count, which is
  // right for waking browsers and writing history — but it discards precisely
  // the readings that confirm an arrival. Somebody who gets home and puts
  // their phone down stops producing movement immediately, so a crossing that
  // has to hold for a minute would never see a second fix and would never be
  // announced. Standing still inside a fence is not the absence of evidence;
  // it is the evidence.
  checkFences(position).catch((e) => console.error('fence:', e && e.message ? e.message : e));

  // update() returns null when nothing actually changed, which keeps a
  // phone repeating itself from waking every open map.
  const changed = positions.update(position);
  if (!changed) return;
  publish(changed);
  // Recorded beside the push rather than before it: the open maps should
  // not wait on a database, and a write that fails is not a reason to drop
  // the update on the floor.
  geo.record(changed).catch((e) => console.error('geo:', e && e.message ? e.message : e));
};

// What a watch reported, in time order, through the same door as Telegram.
//
// Except for the past. A watch that was out of signal uploads its buffer
// later, possibly after newer positions from Telegram have already arrived.
// Those older fixes are history — recorded, so the path is complete — but
// they are not replayed onto the map, which would jump backwards, or through
// the fences, which would announce an arrival hours after it happened.
async function ingest(fixes) {
  for (const fix of [...fixes].sort((a, b) => a.at - b.at)) {
    const current = positions.get(fix.id);
    if (current && current.at > fix.at) {
      await geo.record(fix).catch((e) => console.error('geo:', e && e.message ? e.message : e));
      continue;
    }
    onPosition(fix);
  }
}

// Whether this position crossed anything worth telling somebody about. Runs
// beside the record rather than before it, for the same reason: an open map
// must not wait on a database, and neither must the next position.
async function checkFences(person) {
  if (!geo.enabled() || person.latitude === null || person.latitude === undefined) return;
  const readings = await geo.fencesAt(person.latitude, person.longitude);
  if (!readings.length) return;

  const events = fences.observe({
    person: person.id,
    accuracy: person.accuracy,
    at: person.at,
    readings,
  });
  const ownerOf = new Map(readings.map((r) => [r.fence, r.owner]));
  // Inside a private place, or Passive: whoever may not see this person
  // exactly is not told about the crossing either. A small fence would
  // otherwise locate precisely what the blur hides.
  const exactOnly = privacy.hiddenAt(person.id, person.latitude, person.longitude, person.at);

  for (const event of events) {
    const owner = ownerOf.get(event.fence) ?? null;
    // Written down first: the record is what a restart reads to know where
    // everybody was, so losing it costs more than a missed message.
    await geo.recordFenceEvent({ person: person.id, ...event })
      .catch((e) => console.error('fence:', e && e.message ? e.message : e));
    publishFence({ ...event, person: person.id, name: event.name, owner, exactOnly });

    const said = announce({ who: person.name, name: event.name, entered: event.entered });
    console.log(`fence: somebody ${event.entered ? 'arrived at' : 'left'} a place`);
    // A fence belongs to somebody, and only they are told — and only about
    // people they may see. A fence from before there were owners belongs to
    // the admins, as every fence used to. The account ingest has no way to
    // send a message, so there crossings are recorded and drawn, not pushed.
    if (!notify) continue;
    const recipients = owner === null
      ? config.viewers
      : [owner].filter((id) => {
        const viewer = circles.viewerFor(id);
        return circles.canSee(viewer, person.id) && (!exactOnly || canActFor(viewer, person.id));
      });
    for (const to of recipients) await notify(to, said);
  }
}

// /stop to the bot is the same act as the button on the page, so it is the
// same code: off the map, out of the database, and every open map told.
// It has to reach the fence watcher too, or somebody who asked to be forgotten
// could still set off an alert about a place they had been.
const onForget = async (id) => { fences.forget(id); return forget(id); };

// A link is only ever made for somebody who can sign in, so anyone else is
// told no by the bot rather than handed a link that fails.
const onLogin = (id) => {
  if (!config.publicUrl || !circles.viewerFor(id)) return null;
  return `${config.publicUrl}/auth/${links.issue(id)}`;
};

// What the bot needs to run a circle. Absent without a database, and the bot
// then says circles are unavailable rather than pretending.
const circle = circles.enabled ? {
  seen: (who) => circles.seen(who),
  invite: async (owner) => {
    const token = randomBytes(24).toString('base64url');
    await geo.createInvite({ token, owner, ttlSeconds: 86400 });
    return token;
  },
  // Returns who made the invite, or null if it was used or expired. Your own
  // invite returns you, so the bot can say so rather than grant nothing.
  redeem: async (token, viewer) => {
    const owner = await geo.redeemInvite(token);
    if (!owner) return null;
    if (owner !== viewer) await grant(owner, viewer);
    return { id: owner, ...(circles.user(owner) || {}) };
  },
  circleOf: (id) => circles.circleOf(id),
  // A code to type into a watch, for somebody who can sign in.
  pair: (id) => (devices.enabled && circles.viewerFor(id) ? codes.issue(id) : null),
  // Through the server, so open maps are told as well as the database.
  revoke: (owner, viewer) => revoke(owner, viewer),
} : null;

// Passive mode from the bot, through the server so open maps hear of it the
// same way they do when it is switched on from the page.
const passive = privacy.enabled ? {
  start: (id, minutes) => setPassive(id, minutes),
  end: (id) => endPassive(id),
} : null;

const telegram = config.ingest === 'bot'
  ? await connectBot(config, { directory, onPosition, onForget, onLogin, circle, passive })
  : await connectAccount(config, { directory, onPosition });
inviteLink = telegram.inviteLink || null;

// Both connectors expose the thing the directory needs to resolve a name.
directory.attach(telegram.client);
notify = telegram.notify || null;
// So the sign-in page can say which bot to open. Only the bot knows its own
// username, and it only knows it once connected.
if (telegram.me?.username) setBot(telegram.me.username);

// Where everybody was when this last ran. Without it the first position after
// a deploy is a first sighting, which is silent — correct, but it also means
// a real arrival during the restart goes unremarked.
const seeded = await geo.lastFenceStates()
  .then((rows) => fences.seed(rows))
  .catch((e) => { console.error('fence:', e && e.message ? e.message : e); return 0; });
if (seeded) console.log(`restored ${seeded} fence states`);

if (config.ingest === 'bot' && !config.publicUrl) {
  console.log('PUBLIC_URL is not set — /login cannot send a working link');
}

const bye = async () => { await telegram.stop(); await geo.close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
