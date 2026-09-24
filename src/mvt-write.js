// mvt-write.js — just enough of a Mapbox Vector Tile writer: layers of
// features with properties and geometry, as the 3D map reads them. The other
// half of mvt.js, for game-vector.js, without a dependency.

const zigzag = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const command = (id, count) => (id & 7) | (count << 3);

class Writer {
  constructor() { this.buf = new Uint8Array(4096); this.pos = 0; }
  room(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  varint(n) {
    this.room(10);
    while (n >= 0x80) { this.buf[this.pos++] = (n % 0x80) | 0x80; n = Math.floor(n / 0x80); }
    this.buf[this.pos++] = n;
  }
  key(no, type) { this.varint(no * 8 + type); }
  bytes(no, bytes) { this.key(no, 2); this.varint(bytes.length); this.room(bytes.length); this.buf.set(bytes, this.pos); this.pos += bytes.length; }
  string(no, s) { this.bytes(no, Buffer.from(String(s), 'utf8')); }
  packed(no, values) {
    const inner = new Writer();
    for (const v of values) inner.varint(v);
    this.bytes(no, inner.done());
  }
  done() { return this.buf.subarray(0, this.pos); }
}

function valueBytes(v) {
  const w = new Writer();
  if (typeof v === 'string') w.string(1, v);
  else if (typeof v === 'boolean') { w.key(7, 0); w.varint(v ? 1 : 0); }
  else if (Number.isInteger(v) && v >= 0) { w.key(5, 0); w.varint(v); }
  else if (Number.isInteger(v)) { w.key(6, 0); w.varint(zigzag(v)); }
  else {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    w.key(3, 1);
    w.room(8); w.buf.set(b, w.pos); w.pos += 8;
  }
  return w.done();
}

// Geometry commands from parts in tile units: points, lines, or rings
// (closed or not; a ring is closed with ClosePath). Coordinates must already
// be whole numbers. A point that repeats the last one is dropped, as the
// format requires, and a part that is too short to draw goes with it.
export function commandsOf(type, parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  if (type === 1) {
    if (!parts.length) return out;
    out.push(command(1, parts.length));
    for (const [x, y] of parts) { out.push(zigzag(x - cx), zigzag(y - cy)); cx = x; cy = y; }
    return out;
  }
  for (const part of parts) {
    const points = [];
    for (const p of part) {
      const last = points[points.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
    }
    if (type === 3 && points.length > 1) {
      const [f, l] = [points[0], points[points.length - 1]];
      if (f[0] === l[0] && f[1] === l[1]) points.pop();
    }
    if (points.length < (type === 3 ? 3 : 2)) continue;
    out.push(command(1, 1), zigzag(points[0][0] - cx), zigzag(points[0][1] - cy));
    cx = points[0][0]; cy = points[0][1];
    out.push(command(2, points.length - 1));
    for (const [x, y] of points.slice(1)) { out.push(zigzag(x - cx), zigzag(y - cy)); cx = x; cy = y; }
    if (type === 3) out.push(command(7, 1));
  }
  return out;
}

// [{ name, extent, features: [{ type, properties, geometry }] }] → a tile.
// Properties that are null or undefined are left out, as ST_AsMVT does.
export function encodeTile(layers) {
  const tile = new Writer();
  for (const { name, extent = 4096, features } of layers) {
    if (!features.length) continue;
    const layer = new Writer();
    layer.key(15, 0); layer.varint(2);
    layer.string(1, name);
    const keys = new Map();
    const values = new Map();
    const keyOf = (k) => { if (!keys.has(k)) keys.set(k, keys.size); return keys.get(k); };
    const valueOf = (v) => {
      const id = `${typeof v}:${v}`;
      if (!values.has(id)) values.set(id, { index: values.size, v });
      return values.get(id).index;
    };
    for (const f of features) {
      const feature = new Writer();
      const tags = [];
      for (const [k, v] of Object.entries(f.properties)) {
        if (v === null || v === undefined) continue;
        tags.push(keyOf(k), valueOf(v));
      }
      if (tags.length) feature.packed(2, tags);
      feature.key(3, 0); feature.varint(f.type);
      feature.packed(4, f.geometry);
      layer.bytes(2, feature.done());
    }
    for (const k of keys.keys()) layer.string(3, k);
    for (const { v } of values.values()) layer.bytes(4, valueBytes(v));
    layer.key(5, 0); layer.varint(extent);
    tile.bytes(3, layer.done());
  }
  return Buffer.from(tile.done());
}
