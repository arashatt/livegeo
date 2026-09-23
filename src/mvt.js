// mvt.js — just enough of a Mapbox Vector Tile reader: a layer's features,
// with their properties and, for points, where they are in the tile. What
// the district name needs (district.js), without a dependency.
//
// A tile is protocol buffers: layers, each with its own key and value tables,
// and features that point into them. Anything this does not need is skipped
// by its wire type, so a tile with more in it than expected still reads.

function reader(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= buf.length) throw new Error('mvt: truncated');
      const b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
      if (shift > 63) throw new Error('mvt: bad varint');
    }
  };
  const bytes = () => {
    const n = varint();
    if (pos + n > buf.length) throw new Error('mvt: truncated');
    const out = buf.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  return {
    done: () => pos >= buf.length,
    field() { const key = varint(); return { no: Math.floor(key / 8), type: key % 8 }; },
    varint,
    bytes,
    // Packed repeated uint32: tags and geometry. One unpacked value is read as
    // a list of one, which a lenient encoder may send.
    uints(type) {
      if (type === 0) return [varint()];
      const inner = reader(bytes());
      const out = [];
      while (!inner.done()) out.push(inner.varint());
      return out;
    },
    skip(type) {
      if (type === 0) varint();
      else if (type === 1) pos += 8;
      else if (type === 2) bytes();
      else if (type === 5) pos += 4;
      else throw new Error(`mvt: wire type ${type}`);
    },
    double() { const v = buf.readDoubleLE(pos); pos += 8; return v; },
    float() { const v = buf.readFloatLE(pos); pos += 4; return v; },
  };
}

function value(buf) {
  const r = reader(buf);
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 1 && type === 2) return r.bytes().toString('utf8');
    if (no === 2 && type === 5) return r.float();
    if (no === 3 && type === 1) return r.double();
    if ((no === 4 || no === 5) && type === 0) return r.varint();
    if (no === 6 && type === 0) { const n = r.varint(); return n % 2 ? -(n + 1) / 2 : n / 2; }
    if (no === 7 && type === 0) return Boolean(r.varint());
    r.skip(type);
  }
  return null;
}

const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

// The positions a point feature's MoveTo commands give, in tile units (0 to
// the layer's extent). Lines and polygons are not needed and not decoded.
function pointsOf(geometry) {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < geometry.length;) {
    const command = geometry[i] & 7;
    const count = Math.floor(geometry[i] / 8);
    i++;
    if (command !== 1) break;
    for (let k = 0; k < count && i + 1 < geometry.length; k++) {
      x += zigzag(geometry[i++]);
      y += zigzag(geometry[i++]);
      out.push([x, y]);
    }
  }
  return out;
}

export const POINT = 1;

function readLayerBody(buf) {
  const r = reader(buf);
  const layer = { name: '', extent: 4096, keys: [], values: [], raw: [] };
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 1 && type === 2) layer.name = r.bytes().toString('utf8');
    else if (no === 2 && type === 2) layer.raw.push(r.bytes());
    else if (no === 3 && type === 2) layer.keys.push(r.bytes().toString('utf8'));
    else if (no === 4 && type === 2) layer.values.push(value(r.bytes()));
    else if (no === 5 && type === 0) layer.extent = r.varint() || 4096;
    else r.skip(type);
  }
  return layer;
}

function featuresOf(layer) {
  return layer.raw.map((buf) => {
    const r = reader(buf);
    const properties = {};
    let type = 0;
    let geometry = [];
    while (!r.done()) {
      const { no, type: wire } = r.field();
      if (no === 2) {
        const tags = r.uints(wire);
        for (let i = 0; i + 1 < tags.length; i += 2) {
          const key = layer.keys[tags[i]];
          if (key !== undefined && tags[i + 1] < layer.values.length) properties[key] = layer.values[tags[i + 1]];
        }
      } else if (no === 3 && wire === 0) type = r.varint();
      else if (no === 4) geometry = r.uints(wire);
      else r.skip(wire);
    }
    return { type, properties, points: type === POINT ? pointsOf(geometry) : [] };
  });
}

function asBuffer(buf) {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return Buffer.from(buf);
}

// One layer of a tile, or null when the tile has no such layer. Throws on a
// tile that is not one, which the caller treats as an empty answer.
export function readLayer(buf, name) {
  const r = reader(asBuffer(buf));
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 3 && type === 2) {
      const layer = readLayerBody(r.bytes());
      if (layer.name === name) return { name, extent: layer.extent, features: featuresOf(layer) };
    } else r.skip(type);
  }
  return null;
}

// Every layer, by name: for tests, which check what a tile says.
export function decodeTile(buf) {
  const r = reader(asBuffer(buf));
  const layers = {};
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 3 && type === 2) {
      const layer = readLayerBody(r.bytes());
      layers[layer.name] = featuresOf(layer);
    } else r.skip(type);
  }
  return layers;
}
