// index.js — wires the three pieces together: Telegram in, store in the
// middle, browsers out.
//
// Which Telegram is decided by config.ingest and nothing else here cares:
// both connectors hand over the same position shape and expose the same
// `client` for the directory to ask names of.

import { load } from './config.js';
import { Positions, metresBetween } from './positions.js';
import { serve } from './server.js';
import { connect as connectAccount } from './mtproto.js';
import { connect as connectBot } from './bot.js';
import { makeDirectory } from './directory.js';
import { makeGeo } from './geo.js';
import { randomBytes, createHash } from 'node:crypto';
import { makeIncidents, bearing } from './incidents.js';
import { makeLinks } from './login.js';
import { makeWatcher, announce } from './fences.js';
import { makeCircles, canActFor } from './circles.js';
import { makeDevices, makeCodes } from './devices.js';
import { makeZones } from './zones.js';
import { makeLive, LIVE_EACH } from './live.js';
import { makeSos } from './sos.js';
import { makeChecks } from './checks.js';
import { makeAddress } from './address.js';

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

// Private places: where somebody's circle is shown a blur instead of them.
// Loaded before anything can be published.
const zones = makeZones({ geo });
if (await zones.load().catch((e) => { console.error('zones:', e.message); return false; })) {
  console.log('zones: private places are on');
}

// Live links: somebody followed as they move, by whoever holds the link, for
// a while. Loaded before anything is published, like private places.
const live = makeLive({ geo });
const running = await live.load().catch((e) => { console.error('live:', e.message); return 0; });
if (running) console.log(`live: ${running} link${running === 1 ? '' : 's'} still running`);

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
let locate = null;

// Where the map is, for links the bot sends: PUBLIC_URL, or else whatever
// address the quick tunnel has this time (address.js).
const address = makeAddress({ publicUrl: config.publicUrl, metrics: config.tunnelMetricsUrl });

// Somebody asking for help (sos.js). Built before the server, which offers
// it on the map, and handed the server's own resend and stopLink, which only
// exist once the server does — so they are reached through closures.
const sos = makeSos({
  live, circles, positions,
  admins: config.viewers,
  address: () => address.get(),
  call: config.sosCall,
  placeOf: (lat, lon) => geo.placeOf(lat, lon),
  notify: (to, text) => (notify ? notify(to, text) : false),
  locate: (to, lat, lon) => (locate ? locate(to, lat, lon) : false),
  resend: (id) => resend(id),
  stopLink: (link, why) => stopLink(link, why),
});
if (sos.load()) console.log('sos: an SOS is still running from before the restart');

// Check on me (checks.js): a stop that should not be happening, noticed.
const checks = makeChecks({
  geo, circles, positions, zones,
  admins: config.viewers,
  call: config.sosCall,
  placeOf: (lat, lon) => geo.placeOf(lat, lon),
  fencesAt: (lat, lon) => geo.fencesAt(lat, lon),
  notify: (to, text) => (notify ? notify(to, text) : false),
  locate: (to, lat, lon) => (locate ? locate(to, lat, lon) : false),
  stop: config.checkStop,
});
const checking = await checks.load().catch((e) => { console.error('check:', e.message); return 0; });
if (checking) console.log(`check: still checking on ${checking} ${checking === 1 ? 'person' : 'people'}`);

// Watches every position against every fence. Pure decisions, kept here so
// the state survives for as long as the process does.
const fences = makeWatcher({ floor: config.fenceFloor, dwell: config.fenceDwell });

// Road reports (incidents.js). Reporters are kept as a keyed hash of their
// id; the key comes from a secret the service already has, so it stays the
// same across restarts and nobody holding only the database can undo it.
const secret = config.botToken || config.dashboardToken;
const incidents = makeIncidents({
  geo,
  key: secret ? createHash('sha256').update(`livegeo road reporters\n${secret}`).digest() : null,
});
const reports = await incidents.load().catch((e) => { console.error('incidents:', e.message); return 0; });
if (reports) console.log(`incidents: ${reports} road report${reports === 1 ? '' : 's'} still on the map`);

const { publish, publishFence, forget, setBot, grant, revoke, stopLink, resend, incidentsChanged } = serve(positions, config, {
  directory, geo, links, circles, makeInvite, devices, codes, zones, live, sos, checks, address, incidents,
  onFenceDeleted: (id) => fences.dropFence(id),
  onIngest: (fixes) => ingest(fixes),
});

// Which way somebody is going: what their phone says, or else the way they
// came from their last fix; and how fast, from the same two fixes.
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
function motionOf(p) {
  const trail = p.trail || [];
  const prev = trail.length > 1 ? trail[trail.length - 2] : null;
  const heading = finite(p.heading) ? Number(p.heading) : (prev ? bearing(prev, p) : null);
  const speed = prev && p.at > prev.at ? metresBetween(prev, p) / (p.at - prev.at) : null;
  return { heading, speed };
}

// Somebody sharing who passes a road report is asked, through the bot,
// whether it is still there. Silent, at most once a report and once in five
// minutes (incidents.js), and never where there is no bot to ask with.
let askRoad = null;
function askAboutRoads(p) {
  if (!askRoad || !p.liveUntil || p.liveUntil < Date.now() / 1000) return;
  const { heading } = motionOf(p);
  const inc = incidents.askFor({ ...p, heading });
  if (!inc) return;
  const first = !incidents.told(p.id);
  const metres = metresBetween(p, { latitude: inc.lat, longitude: inc.lon });
  askRoad(p.id, inc, { first, metres })
    .then((sent) => { if (sent && first) incidents.setPrefs(p.id, { told: true }); })
    .catch((e) => console.error('incidents:', e && e.message ? e.message : e));
}

// What the bot does with /report and the answers to "still there?".
const roads = {
  // Where they are now, which is what a report from the bot means: so only
  // with a live location, and a recent one.
  report: async (id, kind, detail) => {
    const p = positions.get(id);
    const now = Date.now() / 1000;
    if (!p || p.latitude === null || !p.liveUntil || p.liveUntil < now || now - p.at > 120) return { error: 'no live location' };
    const made = await incidents.report(id, { kind, detail, latitude: p.latitude, longitude: p.longitude, ...motionOf(p) });
    if (!made.error) incidentsChanged();
    return made;
  },
  answer: async (id, incident, answer) => {
    const got = await incidents.answer(id, incident, answer);
    if (!got.error && !got.again) incidentsChanged();
    return got;
  },
  setQuestions: async (id, on) => incidents.setPrefs(id, { questions: on, told: true }),
};

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
  askAboutRoads(changed);
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
  // Inside a private place, whoever may not see this person exactly is not
  // told about the crossing either. A small fence would otherwise locate
  // precisely what the blur hides.
  const exactOnly = Boolean(zones.at(person.id, person.latitude, person.longitude));

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
// told no by the bot rather than handed a link that fails. That is asked
// first: somebody who may not look learns nothing about how the map is run.
// Somebody who may, and cannot be sent anywhere, is told why — it used to say
// they were not on the list, which sent people looking in the wrong place.
const onLogin = async (id) => {
  if (!circles.viewerFor(id)) return { error: 'Your account is not on the list of who may see the map.' };
  const base = await address.get();
  if (!base) {
    return { error: 'The map has no address to send you to yet: PUBLIC_URL is not set, and the tunnel is not answering. Whoever runs it can set PUBLIC_URL, or start the tunnel.' };
  }
  return { link: `${base}/auth/${links.issue(id)}` };
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
  // /live: the same link the map's Follow me makes, and /live stop, which
  // ends every one of them through the server so their pages are told.
  live: {
    make: async (id, minutes) => {
      const base = await address.get();
      if (!base) return { error: 'Live links need the map\'s address: PUBLIC_URL is not set, and the tunnel is not answering.' };
      if (live.of(id).filter((l) => l.reason === 'share').length >= LIVE_EACH) {
        return { error: `${LIVE_EACH} live links at once is the limit. /live stop ends them.` };
      }
      const link = await live.create({ person: id, minutes });
      return { url: `${base}/live/${link.token}`, expiresAt: link.expiresAt };
    },
    stop: async (id) => {
      const mine = live.of(id).filter((l) => l.reason === 'share');
      for (const link of mine) await stopLink(link);
      return mine.length;
    },
  },
  // /sos and /safe: the same code as the map's SOS button.
  sos: {
    raise: (id) => sos.raise(id),
    end: (id) => sos.end(id),
  },
  // /checkon, /checkoff and /ok.
  check: checks.enabled ? {
    start: (id, hours) => checks.start(id, hours),
    stop: (id) => checks.stop(id),
    ok: (id) => checks.ok(id),
  } : null,
} : null;

const telegram = config.ingest === 'bot'
  ? await connectBot(config, { directory, onPosition, onForget, onLogin, circle, roads })
  : await connectAccount(config, { directory, onPosition });
inviteLink = telegram.inviteLink || null;
askRoad = telegram.askRoad || null;

// Both connectors expose the thing the directory needs to resolve a name.
directory.attach(telegram.client);
notify = telegram.notify || null;
locate = telegram.locate || null;

// An SOS lasts an hour. One that runs out by itself is noticed here, open
// maps are put right, and its person is asked whether they still need help.
setInterval(() => { sos.sweep().catch((e) => console.error('sos:', e && e.message ? e.message : e)); }, 30_000);
// And every check, once a minute: asked, told, moved on, or over.
setInterval(() => { checks.sweep().catch((e) => console.error('check:', e && e.message ? e.message : e)); }, 60_000);
// Road reports fade: once a minute, whatever faded away or settled is put
// right, and open maps told if what they show changed.
setInterval(() => {
  incidents.sweep()
    .then((changed) => { if (changed) incidentsChanged(); })
    .catch((e) => console.error('incidents:', e && e.message ? e.message : e));
}, 60_000);
// History past HISTORY_DAYS, deleted soon after the start and every six
// hours after. Only a count is logged, never whose.
const prune = () => geo.prune(config.historyDays)
  .then((n) => { if (n) console.log(`history: deleted ${n} rows older than ${config.historyDays} days`); })
  .catch((e) => console.error('history:', e && e.message ? e.message : e));
if (config.historyDays > 0) {
  setTimeout(prune, 60_000);
  setInterval(prune, 6 * 3600_000);
}
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

// Which address the bot's links will carry. Checked once here for the log;
// a tunnel that comes up later is picked up by the first link that needs it.
// Never the address itself: these lines are read where it should not be.
if (config.ingest === 'bot' && !config.publicUrl) {
  await address.get();
  console.log(address.source() === 'quick tunnel'
    ? 'PUBLIC_URL is not set — links the bot sends use the quick tunnel\'s address'
    : 'PUBLIC_URL is not set and no quick tunnel answers — /login cannot send a working link yet');
} else if (config.ingest === 'bot' && address.copied) {
  await address.get();
  console.log(address.source() === 'quick tunnel'
    ? 'PUBLIC_URL is a quick tunnel\'s address, which changes whenever the tunnel restarts — links the bot sends use the tunnel\'s current address'
    : 'PUBLIC_URL is a quick tunnel\'s address and the tunnel does not answer, so links use PUBLIC_URL, which stops working when the tunnel restarts');
}

const bye = async () => { await telegram.stop(); await geo.close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
