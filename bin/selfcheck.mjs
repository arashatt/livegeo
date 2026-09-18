#!/usr/bin/env node
// selfcheck.mjs — the dashboard on its own, with no Telegram connection.
//
// Used by the build to prove the image starts and serves before it is
// published, and useful by hand when you want to look at the page without
// signing an account in.

import { Positions } from '../src/positions.js';
import { serve } from '../src/server.js';
import { defaults } from '../src/config.js';

serve(new Positions(), {
  // The same settings the real service uses, so the map here is the map there.
  ...defaults(),
  dashboardToken: process.env.DASHBOARD_TOKEN || 'selfcheck',
  // Published rather than loopback: this is what the image's own smoke test
  // curls from outside the container.
  host: process.env.HOST || '0.0.0.0',
});

console.log('selfcheck: dashboard up, no Telegram connection');
