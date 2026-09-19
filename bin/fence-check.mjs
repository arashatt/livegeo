#!/usr/bin/env node
// fence-check.mjs — walk a phone past a fence and see what gets said.
//
//   DATABASE_URL=postgres://… node bin/fence-check.mjs
//
// The unit tests cover the watcher, which is where the judgement lives. They
// cannot cover the thing that actually went wrong first time: fences were
// checked only for positions that passed the movement filter, so somebody who
// arrived home and put their phone down never produced the second reading the
// dwell needed, and the arrival was never announced. Every individual piece
// was correct and the feature did nothing.
//
// So this exercises the real chain — real PostGIS, real queries, real watcher,
// in the order src/index.js uses — and asserts the counts. It needs a
// database, which is why it is a script rather than part of `npm test`.
//
// It creates a fence with an unmistakable name, uses a person id no Telegram
// account has, and removes both on the way out.

import pg from 'pg';
import { makeGeo } from '../src/geo.js';
import { makeWatcher, announce } from '../src/fences.js';

const url = process.env.DATABASE_URL || '';
if (!url) {
  console.error('DATABASE_URL is not set — this needs a PostGIS to walk past.');
  process.exit(1);
}

const PERSON = '__fence_check__';
const FENCE = '__fence_check__';
const HOME = { lat: 36.297, lon: 59.606 };
const RADIUS = 150;
const T = Math.floor(Date.now() / 1000);

const geo = makeGeo({ url, log: { info() {}, error: console.error } });
if (!(await geo.connect())) process.exit(1);

const pool = new pg.Pool({ connectionString: url, max: 1 });
const watcher = makeWatcher({ floor: 50, dwell: 60 });
const said = [];

let fenceId = null;
let failures = 0;

const check = (what, got, want) => {
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` — wanted ${want}, got ${got}`}`);
};

// Metres east of home as a longitude, at this latitude.
const east = (m) => HOME.lon + m / (111320 * Math.cos((HOME.lat * Math.PI) / 180));

// The same order src/index.js uses: fences see the reading itself, before the
// movement filter has had a chance to discard it.
async function step(at, metres, accuracy = 10) {
  const readings = await geo.fencesAt(HOME.lat, east(metres));
  for (const event of watcher.observe({ person: PERSON, accuracy, at, readings })) {
    said.push(announce({ who: 'Someone', name: event.name, entered: event.entered }));
  }
}

try {
  await pool.query('DELETE FROM fences WHERE name = $1', [FENCE]);
  fenceId = await geo.createFence({ name: FENCE, latitude: HOME.lat, longitude: HOME.lon, radius: RADIUS });

  console.log('\napproaching from 900 m away');
  await step(T, 900);
  check('arriving in view says nothing', said.length, 0);

  console.log('resting on the boundary, twelve fixes, 50 m accuracy');
  for (let i = 0; i < 12; i++) await step(T + 10 + i * 20, RADIUS + (i % 2 ? 8 : -8), 50);
  check('a phone flapping across the line says nothing', said.length, 0);

  console.log('driving in and straight back out, inside the dwell');
  await step(T + 300, 20);
  await step(T + 320, 800);
  check('a transit says nothing', said.length, 0);

  console.log('arriving properly, then standing still');
  await step(T + 400, 20);
  await step(T + 500, 18);            // no movement at all: the case that broke
  check('an arrival is announced once', said.length, 1);
  check('and reads as an arrival', /arrived at/.test(said[0] || ''), true);

  console.log('staying put');
  await step(T + 900, 19);
  check('staying says nothing more', said.length, 1);

  console.log('leaving');
  await step(T + 1000, 900);
  await step(T + 1100, 950);
  check('leaving is announced once', said.length, 2);
  check('and reads as a departure', /left/.test(said[1] || ''), true);
} finally {
  if (fenceId !== null) await geo.deleteFence(fenceId).catch(() => {});
  await pool.query('DELETE FROM fence_events WHERE person = $1', [PERSON]).catch(() => {});
  await pool.end().catch(() => {});
  await geo.close();
}

console.log(failures ? `\n${failures} failed.` : '\nall good.');
process.exit(failures ? 1 : 0);
