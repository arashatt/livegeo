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
import { makeLinks, makeViewers } from './login.js';
import { makeWatcher, announce } from './fences.js';

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
const viewers = makeViewers(config.viewers);
// Set once Telegram is connected. Declared up here because the connector
// starts listening before it returns, so a position can reach checkFences()
// while `telegram` is still in its temporal dead zone — which would be a
// ReferenceError rather than a missed message.
let notify = null;

// Watches every position against every fence. Pure decisions, kept here so
// the state survives for as long as the process does.
const fences = makeWatcher({ floor: config.fenceFloor, dwell: config.fenceDwell });

const { publish, publishFence, forget, setBot } = serve(positions, config, {
  directory, geo, links,
  onFenceDeleted: (id) => fences.dropFence(id),
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

  for (const event of events) {
    // Written down first: the record is what a restart reads to know where
    // everybody was, so losing it costs more than a missed message.
    await geo.recordFenceEvent({ person: person.id, ...event })
      .catch((e) => console.error('fence:', e && e.message ? e.message : e));
    publishFence({ ...event, person: person.id, name: event.name });

    const said = announce({ who: person.name, name: event.name, entered: event.entered });
    console.log(`fence: somebody ${event.entered ? 'arrived at' : 'left'} a place`);
    // Everyone trusted to see where people are is told. The account ingest
    // has no way to send a message, so there it is recorded and drawn but
    // not pushed.
    if (notify) for (const viewer of config.viewers) await notify(viewer, said);
  }
}

// /stop to the bot is the same act as the button on the page, so it is the
// same code: off the map, out of the database, and every open map told.
// It has to reach the fence watcher too, or somebody who asked to be forgotten
// could still set off an alert about a place they had been.
const onForget = async (id) => { fences.forget(id); return forget(id); };

// A link is only ever made for somebody already on the list, so an unlisted
// person is told no by the bot rather than handed a link that fails.
const onLogin = (id) => {
  if (!config.publicUrl || !viewers.has(id)) return null;
  return `${config.publicUrl}/auth/${links.issue(id)}`;
};

const telegram = config.ingest === 'bot'
  ? await connectBot(config, { directory, onPosition, onForget, onLogin })
  : await connectAccount(config, { directory, onPosition });

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
