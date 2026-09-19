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
const { publish, forget, setBot } = serve(positions, config, { directory, geo, links });

// A restart used to blank the map until everyone happened to move again. What
// was last recorded is what the store would have held, so put it back before
// Telegram is even connected — the dashboard then has people the moment it is
// up rather than minutes later.
const restored = await geo.latest(config.staleAfter)
  .then((rows) => rows.filter((p) => positions.update(p)).length)
  .catch((e) => { console.error('geo:', e && e.message ? e.message : e); return 0; });
if (restored) console.log(`restored ${restored} from the last run`);

const onPosition = (position) => {
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

// /stop to the bot is the same act as the button on the page, so it is the
// same code: off the map, out of the database, and every open map told.
const onForget = (id) => forget(id);

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
// So the sign-in page can say which bot to open. Only the bot knows its own
// username, and it only knows it once connected.
if (telegram.me?.username) setBot(telegram.me.username);

if (config.ingest === 'bot' && !config.publicUrl) {
  console.log('PUBLIC_URL is not set — /login cannot send a working link');
}

const bye = async () => { await telegram.stop(); await geo.close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
