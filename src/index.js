// index.js — wires the three pieces together: Telegram in, store in the
// middle, browsers out.

import { load } from './config.js';
import { Positions } from './positions.js';
import { serve } from './server.js';
import { connect } from './mtproto.js';

const config = load();
const positions = new Positions({ staleAfter: config.staleAfter, trailMax: config.trailMax });
const { publish } = serve(positions, config);

const telegram = await connect(config, {
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
