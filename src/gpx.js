// gpx.js — a path as a file other software reads: Strava, Garmin Connect,
// OsmAnd, or somebody's own archive.
//
// GPX 1.1 (topografix.com/GPX/1/1): one track, and a new segment wherever the
// path breaks. A segment in GPX means an unbroken stretch of recording, which
// is exactly what a gap is here — a hidden stretch, or a pause long enough
// that joining the two ends with a straight line would add a journey nobody
// made to whatever reads the file.
//
// Pure, so the file is tested without a server.

// Characters XML 1.0 does not allow at all, even escaped. A Telegram name can
// contain any of them, and one would make the whole file unreadable.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlText(value) {
  return String(value ?? '').replace(FORBIDDEN, '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// UTC, to the second, as the schema's xsd:dateTime wants and every importer
// reads.
const iso = (at) => new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const timed = (q) => q.at !== null && q.at !== undefined && Number.isFinite(Number(q.at));

// Marks a gap wherever two fixes are further apart in time than `seconds`:
// the morning walk and the evening drive are two segments, not one line
// across the city between them.
export function splitAtPauses(points, seconds = 600) {
  return (points || []).map((q, i, all) => {
    const prev = all[i - 1];
    return prev && timed(prev) && timed(q) && q.at - prev.at > seconds ? { ...q, gap: true } : q;
  });
}

export function toGpx({ name = '', points = [], creator = 'livegeo', time = null } = {}) {
  const good = (points || []).filter((q) => q
    && Number.isFinite(Number(q.latitude)) && Math.abs(q.latitude) <= 90
    && Number.isFinite(Number(q.longitude)) && Math.abs(q.longitude) <= 180);
  const segments = [];
  for (const q of good) {
    if (!segments.length || q.gap) segments.push([]);
    segments[segments.length - 1].push(q);
  }
  const point = (q) => `      <trkpt lat="${Number(q.latitude).toFixed(7)}" lon="${Number(q.longitude).toFixed(7)}">`
    + (timed(q) ? `<time>${iso(Number(q.at))}</time>` : '') + '</trkpt>';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlText(creator)}" xmlns="http://www.topografix.com/GPX/1/1"`
      + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
      + ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    ...(name ? [`    <name>${xmlText(name)}</name>`] : []),
    ...(time !== null && Number.isFinite(Number(time)) ? [`    <time>${iso(Number(time))}</time>`] : []),
    '  </metadata>',
    '  <trk>',
    ...(name ? [`    <name>${xmlText(name)}</name>`] : []),
    ...segments.flatMap((seg) => ['    <trkseg>', ...seg.map(point), '    </trkseg>']),
    '  </trk>',
    '</gpx>',
    '',
  ];
  return lines.join('\n');
}

// The calendar day a moment falls on for somebody `tz` minutes behind UTC —
// what the page's getTimezoneOffset() says, so a file is named for the day
// its owner picked rather than the day it was in Greenwich.
export function dayOf(at, tz = 0) {
  return new Date((Number(at) - Number(tz || 0) * 60) * 1000).toISOString().slice(0, 10);
}

// RFC 6266: a plain ASCII name for anything old, and the real one, in UTF-8,
// for everything else — a Persian name is not reduced to a date.
export function contentDisposition(name, day) {
  const full = [name, day].filter(Boolean).join(' ').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').trim() || 'path';
  const ascii = full.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').toLowerCase() || 'path';
  const encoded = encodeURIComponent(`${full}.gpx`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}.gpx"; filename*=UTF-8''${encoded}`;
}
