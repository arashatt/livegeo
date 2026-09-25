import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrack, metresOffWay, MAX_SPEED, SPIKE_OFF, SPIKE_RUN } from '../src/track.js';
import { Positions, metresBetween } from '../src/positions.js';

// A drive north through Tehran: a fix every 10 s, 100 m apart (36 km/h).
const NORTH = 100 / 111195;          // 100 m of latitude, in degrees
const EAST = 100 / (111195 * Math.cos((35.7 * Math.PI) / 180));
const drive = (n, { from = 0, at = 1000 } = {}) => Array.from({ length: n }, (_, i) => ({
  latitude: 35.7 + (from + i) * NORTH, longitude: 51.4, at: at + (from + i) * 10,
}));
// The same fix, somewhere else: `east` hundreds of metres off the road.
const off = (q, east) => ({ ...q, longitude: q.longitude + east * EAST });

test('a clean drive comes back as it went in', () => {
  const path = drive(10);
  const out = cleanTrack(path);
  assert.equal(out.length, 10);
  out.forEach((q, i) => assert.equal(q, path[i]));
  assert.deepEqual(cleanTrack([]), []);
  assert.deepEqual(cleanTrack(null), []);
  assert.deepEqual(cleanTrack(drive(1)), drive(1));
  assert.equal(MAX_SPEED, 70);
  assert.equal(SPIKE_OFF, 100);
  assert.equal(SPIKE_RUN, 3);
});

test('a fix kilometres off and back is left out', () => {
  const path = drive(10);
  path[5] = off(path[5], 30);        // 3 km east, 10 s after 1 km north
  const out = cleanTrack(path);
  assert.equal(out.length, 9);
  assert.ok(!out.includes(path[5]));
  // Also at the second fix, and just before the newest.
  const early = drive(6); early[1] = off(early[1], -50);
  assert.equal(cleanTrack(early).length, 5);
  const late = drive(6); late[4] = off(late[4], 20);
  assert.equal(cleanTrack(late).length, 5);
});

test('up to three bad fixes in a row go; four are where the phone was', () => {
  for (const bad of [2, 3]) {
    const path = drive(12);
    for (let k = 0; k < bad; k++) path[4 + k] = off(path[4 + k], 25 + k);
    assert.equal(cleanTrack(path).length, 12 - bad, `${bad} in a row`);
  }
  const path = drive(12);
  for (let k = 0; k < 4; k++) path[4 + k] = off(path[4 + k], 25 + k);
  assert.equal(cleanTrack(path).length, 12, 'four stay: nothing shows they were wrong');
});

test('a real jump stays: nothing after it goes back', () => {
  // Tehran, then Istanbul after a three-hour flight.
  const before = drive(4);
  const after = [0, 1, 2].map((i) => ({ latitude: 41.0 + i * NORTH, longitude: 28.9, at: 1000 + 3 * 3600 + i * 10 }));
  const out = cleanTrack([...before, ...after]);
  assert.equal(out.length, 7);
  // A phone off for a day, back on across town.
  const town = [...drive(3), { latitude: 35.75, longitude: 51.45, at: 90_000 }, { latitude: 35.7501, longitude: 51.45, at: 90_010 }];
  assert.equal(cleanTrack(town).length, 5);
});

test('the newest fix always stays, even when it looks wrong', () => {
  const path = drive(5);
  path[4] = off(path[4], 40);
  const out = cleanTrack(path);
  assert.equal(out.length, 5);
  assert.equal(out[4], path[4]);
});

test('fixes delivered in a bunch, stamped the same second, are kept', () => {
  // 300 m apart along the road; the middle five all received at once, so
  // each seems to be 300 m from the last in no time at all.
  const at = [1000, 1010, 1020, 1030, 1040, 1100, 1100, 1100, 1100, 1100, 1110, 1120];
  const path = at.map((t, i) => ({ latitude: 35.7 + 3 * i * NORTH, longitude: 51.4, at: t }));
  assert.equal(cleanTrack(path).length, 12);
});

test('a fast car on a motorway is not a spike', () => {
  // 200 km/h, a fix every 5 s.
  const step = (200 / 3.6) * 5 / 111195;
  const path = Array.from({ length: 10 }, (_, i) => ({ latitude: 35.7 + i * step, longitude: 51.4, at: 1000 + i * 5 }));
  assert.equal(cleanTrack(path).length, 10);
});

test('the same fix twice is kept once; out of order is put in order', () => {
  const path = drive(6);
  const doubled = [path[0], path[1], { ...path[1] }, path[2], path[3], path[4], path[5]];
  assert.equal(cleanTrack(doubled).length, 6);
  const shuffled = [path[3], path[0], path[5], path[1], path[4], path[2]];
  assert.deepEqual(cleanTrack(shuffled), path);
  // A second copy that says the path broke there keeps saying so.
  const marked = cleanTrack([path[0], path[1], { ...path[1], gap: true }, path[2]]);
  assert.equal(marked.length, 3);
  assert.equal(marked[1].gap, true);
});

test('a break marked on a fix that is left out moves to the next one kept', () => {
  const path = drive(8);
  path[3] = { ...off(path[3], 30), gap: true };
  const out = cleanTrack(path);
  assert.equal(out.length, 7);
  assert.equal(out[3].gap, true);
  assert.equal(out[3].at, path[4].at);
  assert.equal(path[4].gap, undefined, 'the caller’s fixes are not changed');
});

test('without times nothing can be judged, so only repeats go', () => {
  const path = drive(5).map(({ at, ...q }) => q);
  path[2] = off(path[2], 30);
  assert.equal(cleanTrack(path).length, 5);
  assert.equal(cleanTrack([path[0], path[0], path[1]]).length, 2, 'a repeat still goes');
  assert.equal(cleanTrack([{ latitude: null, longitude: 1, at: 1 }, ...drive(2)]).length, 2);
});

test('how far off the way a fix is', () => {
  const [a, , c] = drive(3);
  assert.ok(metresOffWay(a, c, off(drive(3)[1], 3)) > 299 && metresOffWay(a, c, off(drive(3)[1], 3)) < 301);
  assert.ok(metresOffWay(a, c, drive(3)[1]) < 0.01);
  // Past the end of the way, it is the distance to the end.
  const beyond = drive(5)[4];
  assert.ok(Math.abs(metresOffWay(a, c, beyond) - metresBetween(c, beyond)) < 0.5);
  assert.ok(metresOffWay(a, a, c) > 199 && metresOffWay(a, a, c) < 201);
});

test('the live trail drops a spike once the next fix carries on without it', () => {
  let now = 1000;
  const store = new Positions({ minMove: 25, now: () => now });
  const path = drive(4);
  const spike = off(drive(5)[4], 30);
  const next = drive(6)[5];
  const send = (q) => { now = q.at; return store.update({ id: '7', name: 'Sam', ...q, accuracy: 10, heading: null, liveUntil: q.at + 900, stopped: false }); };
  path.forEach(send);
  send(spike);
  // Newest: kept, and it is where the map puts them until the next fix.
  assert.equal(store.get('7').trail.length, 5);
  assert.equal(store.get('7').longitude, spike.longitude);
  send(next);
  const trail = store.get('7').trail;
  assert.equal(trail.length, 5);
  assert.ok(!trail.some((q) => q.longitude === spike.longitude));
  assert.equal(store.get('7').latitude, next.latitude);
});
