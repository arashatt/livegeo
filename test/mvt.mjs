// A small Mapbox Vector Tile reader for tests: layer names, and each
// feature's properties. Enough to check what a tile says, without a
// dependency. Geometry is left encoded.

function reader(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
    }
  };
  return {
    done: () => pos >= buf.length,
    field() { const key = varint(); return { no: Math.floor(key / 8), type: key % 8 }; },
    varint,
    bytes() { const n = varint(); const out = buf.subarray(pos, pos + n); pos += n; return out; },
    skip(type) {
      if (type === 0) varint();
      else if (type === 1) pos += 8;
      else if (type === 2) { const n = varint(); pos += n; }
      else if (type === 5) pos += 4;
      else throw new Error(`wire type ${type}`);
    },
    double() { const v = buf.readDoubleLE(pos); pos += 8; return v; },
    float() { const v = buf.readFloatLE(pos); pos += 4; return v; },
  };
}

function value(buf) {
  const r = reader(buf);
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 1) return r.bytes().toString('utf8');
    if (no === 2) return r.float();
    if (no === 3) return r.double();
    if (no === 4 || no === 5) return r.varint();
    if (no === 6) { const n = r.varint(); return n % 2 ? -(n + 1) / 2 : n / 2; }
    if (no === 7) return Boolean(r.varint());
    r.skip(type);
  }
  return null;
}

function layer(buf) {
  const r = reader(buf);
  const out = { name: '', keys: [], values: [], raw: [] };
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 1) out.name = r.bytes().toString('utf8');
    else if (no === 2) out.raw.push(r.bytes());
    else if (no === 3) out.keys.push(r.bytes().toString('utf8'));
    else if (no === 4) out.values.push(value(r.bytes()));
    else r.skip(type);
  }
  out.features = out.raw.map((f) => {
    const fr = reader(f);
    const props = {};
    let geomType = 0;
    while (!fr.done()) {
      const { no, type } = fr.field();
      if (no === 2) {
        const tags = reader(fr.bytes());
        while (!tags.done()) { const k = tags.varint(); const v = tags.varint(); props[out.keys[k]] = out.values[v]; }
      } else if (no === 3) geomType = fr.varint();
      else fr.skip(type);
    }
    return { type: geomType, properties: props };
  });
  delete out.raw;
  return out;
}

export function decodeTile(buf) {
  const r = reader(Buffer.from(buf));
  const layers = {};
  while (!r.done()) {
    const { no, type } = r.field();
    if (no === 3) { const l = layer(r.bytes()); layers[l.name] = l.features; } else r.skip(type);
  }
  return layers;
}
