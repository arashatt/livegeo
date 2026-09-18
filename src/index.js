// index.js — wires the three pieces together: Telegram in, store in the
// middle, browsers out.

import { load } from './config.js';
import { Positions } from './positions.js';
import { serve } from './server.js';
import { connect } from './mtproto.js';
import { makeDirectory } from './directory.js';
import { makeGeo } from './geo.js';

const config = load();
const positions = new Positions({
  staleAfter: config.staleAfter, trailMax: config.trailMax, minMove: config.minMove,
});
// Built before either side so the page can ask about an id straight away;
// it simply answers "unknown" until Telegram is connected below.
const directory = makeDirectory();
const geo = makeGeo({ url: config.databaseUrl });
await geo.connect();
const { publish } = serve(positions, config, { directory, geo });

// A restart used to blank the map until everyone happened to move again. What
// was last recorded is what the store would have held, so put it back before
// Telegram is even connected — the dashboard then has people the moment it is
// up rather than minutes later.
const restored = await geo.latest(config.staleAfter)
  .then((rows) => rows.filter((p) => positions.update(p)).length)
  .catch((e) => { console.error('geo:', e && e.message ? e.message : e); return 0; });
if (restored) console.log(`restored ${restored} from the last run`);

const telegram = await connect(config, {
  directory,
  onPosition: (position) => {
    // update() returns null when nothing actually changed, which keeps a
    // phone repeating itself from waking every open map.
    const changed = positions.update(position);
    if (!changed) return;
    publish(changed);
    // Recorded beside the push rather than before it: the open maps should
    // not wait on a database, and a write that fails is not a reason to drop
    // the update on the floor.
    geo.record(changed).catch((e) => console.error('geo:', e && e.message ? e.message : e));
  },
});

const bye = async () => { await telegram.stop(); await geo.close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
