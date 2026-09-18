// index.js — wires the three pieces together: Telegram in, store in the
// middle, browsers out.

import { load } from './config.js';
import { Positions } from './positions.js';
import { serve } from './server.js';
import { connect } from './mtproto.js';
import { makeDirectory } from './directory.js';

const config = load();
const positions = new Positions({ staleAfter: config.staleAfter, trailMax: config.trailMax });
// Built before either side so the page can ask about an id straight away;
// it simply answers "unknown" until Telegram is connected below.
const directory = makeDirectory();
const { publish } = serve(positions, config, { directory });

const telegram = await connect(config, {
  directory,
  onPosition: (position) => {
    // update() returns null when nothing actually changed, which keeps a
    // phone repeating itself from waking every open map.
    const changed = positions.update(position);
    if (changed) publish(changed);
  },
});

const bye = async () => { await telegram.stop(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
