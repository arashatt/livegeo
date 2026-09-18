#!/usr/bin/env node
// clean-history.mjs — take the scribble out of what was already recorded.
//
// Until the movement threshold existed, every fix was written down, including
// the ones that only differed because a stationary phone's fix wanders inside
// its own accuracy radius. This walks what is stored and applies exactly the
// rule the live path applies now.
//
//   docker compose exec -T app node bin/clean-history.mjs           # report
//   docker compose exec -T app node bin/clean-history.mjs --apply   # delete
//
// It reports by default and deletes only when asked, because this is a record
// of where people were and there is no undoing it.
//
// The rule is imported rather than restated. A cleaner that disagreed with the
// filter would either leave noise behind or throw away travel, and nobody
// would notice which.

import pg from 'pg';
import { metresBetween, movementThreshold } from '../src/positions.js';
import { load } from '../src/config.js';

const apply = process.argv.includes('--apply');

const config = (() => {
  try {
    return load();
  } catch {
    // The credentials this needs are the database ones; a missing Telegram
    // session should not stop a maintenance script.
    return { databaseUrl: process.env.DATABASE_URL || '', minMove: Number(process.env.MIN_MOVE || 25) };
  }
})();

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set — there is no history to clean.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

const { rows } = await pool.query(
  `SELECT id, person,
          extract(epoch FROM at)::bigint AS at,
          ST_Y(geom::geometry) AS latitude,
          ST_X(geom::geometry) AS longitude,
          accuracy
     FROM positions
    ORDER BY person, at ASC`,
);

// Walked in time order per person, comparing against the last point kept —
// which is what the store does, so a slow drift cannot accumulate into a
// journey nobody made.
const byPerson = new Map();
for (const r of rows) {
  if (!byPerson.has(r.person)) byPerson.set(r.person, []);
  byPerson.get(r.person).push({
    id: r.id,
    at: Number(r.at),
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    accuracy: r.accuracy === null ? null : Number(r.accuracy),
  });
}

const doomed = [];
let kept = 0;
let nth = 0;

for (const [, points] of byPerson) {
  let anchor = null;
  let keptHere = 0;
  for (const p of points) {
    if (!anchor) { anchor = p; keptHere += 1; continue; }
    const far = metresBetween(anchor, p) > movementThreshold(anchor, p, config.minMove);
    if (far) { anchor = p; keptHere += 1; } else { doomed.push(p.id); }
  }
  kept += keptHere;
  nth += 1;
  // Counted, not named. This runs from a workflow whose logs are public, and
  // a Telegram id is an identifier — the numbers are what the decision needs,
  // and knowing whose they are adds nothing to it.
  console.log(`  person ${nth}: ${points.length} recorded → ${keptHere} travel, ${points.length - keptHere} noise`);
}

console.log(`\n${rows.length} rows, ${kept} worth keeping, ${doomed.length} noise`);

if (!doomed.length) {
  console.log('nothing to remove.');
} else if (!apply) {
  console.log('reporting only — pass --apply to remove them.');
} else {
  const res = await pool.query('DELETE FROM positions WHERE id = ANY($1::bigint[])', [doomed]);
  console.log(`removed ${res.rowCount}.`);
}

await pool.end();
