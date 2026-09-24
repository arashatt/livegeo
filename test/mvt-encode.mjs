// Enough of a Mapbox Vector Tile encoder to write the tiles the tests need:
// points, lines and polygons, with string, number and boolean properties.
//
//   encodeTile({ roads: { extent: 4096, features: [
//     { type: 2, properties: { class: 'primary' }, lines: [[[0, 0], [10, 10]]] },
//     { type: 3, properties: {}, rings: [[[0, 0], [10, 0], [10, 10]]] },   // closed for you
//     { type: 1, properties: {}, points: [[5, 5]] },
//   ] } })

const varint = (n) => {
  const out = [];
  while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
  out.push(n);
  return out;
};
const key = (no, type) => varint(no * 8 + type);
const sized = (no, bytes) => [...key(no, 2), ...varint(bytes.length), ...bytes];
const text = (s) => [...Buffer.from(s, 'utf8')];
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const command = (id, count) => (id & 7) | (count << 3);

function valueOf(v) {
  if (typeof v === 'string') return sized(1, text(v));
  if (typeof v === 'boolean') return [...key(7, 0), ...varint(v ? 1 : 0)];
  if (Number.isInteger(v) && v >= 0) return [...key(5, 0), ...varint(v)];
  if (Number.isInteger(v)) return [...key(6, 0), ...varint(zz(v))];
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return [...key(3, 1), ...b];
}

function geometryOf(f) {
  const out = [];
  let x = 0;
  let y = 0;
  const to = ([px, py]) => { out.push(zz(px - x), zz(py - y)); x = px; y = py; };
  if (f.type === 1) {
    out.push(command(1, f.points.length));
    f.points.forEach(to);
    return out;
  }
  for (const part of f.type === 2 ? f.lines : f.rings) {
    out.push(command(1, 1));
    to(part[0]);
    out.push(command(2, part.length - 1));
    part.slice(1).forEach(to);
    if (f.type === 3) out.push(command(7, 1));
  }
  return out;
}

export function encodeTile(layers) {
  let out = [];
  for (const [name, { extent, features }] of Object.entries(layers)) {
    const keys = [];
    const values = [];
    const feats = features.map((f) => {
      const tags = [];
      for (const [k, v] of Object.entries(f.properties || {})) {
        if (!keys.includes(k)) keys.push(k);
        if (!values.includes(v)) values.push(v);
        tags.push(keys.indexOf(k), values.indexOf(v));
      }
      return [...sized(2, tags.flatMap(varint)), ...key(3, 0), ...varint(f.type), ...sized(4, geometryOf(f).flatMap(varint))];
    });
    out = out.concat(sized(3, [
      ...key(15, 0), ...varint(2), ...sized(1, text(name)),
      ...feats.flatMap((f) => sized(2, f)),
      ...keys.flatMap((k) => sized(3, text(k))),
      ...values.flatMap((v) => sized(4, valueOf(v))),
      ...(extent ? [...key(5, 0), ...varint(extent)] : []),
    ]));
  }
  return Buffer.from(out);
}
