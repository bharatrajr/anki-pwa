// Minimal protobuf decoder for the messages inside modern Anki files (.anki21b):
// note type / field / template / deck / deck-config blobs, media lists and package
// metadata. Only reading is needed; exports use the legacy JSON schema.

const dec = new TextDecoder();

export class Pb {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.fields = new Map(); // field number → [{wt, v}]
    if (!bytes) return;
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 0;
    const varint = () => {
      let result = 0n, shift = 0n;
      for (;;) {
        if (i >= b.length) throw new Error('Truncated protobuf');
        const byte = b[i++];
        result |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) return result;
        shift += 7n;
      }
    };
    while (i < b.length) {
      const key = Number(varint());
      const fno = key >>> 3, wt = key & 7;
      let v;
      if (wt === 0) v = varint();
      else if (wt === 1) { v = dv.getFloat64(i, true); i += 8; }
      else if (wt === 2) { const len = Number(varint()); v = b.subarray(i, i + len); i += len; }
      else if (wt === 5) { v = dv.getFloat32(i, true); i += 4; }
      else throw new Error(`Unsupported protobuf wire type ${wt}`);
      if (!this.fields.has(fno)) this.fields.set(fno, []);
      this.fields.get(fno).push({ wt, v });
    }
  }
  has(f) { return this.fields.has(f); }
  last(f) { const a = this.fields.get(f); return a ? a[a.length - 1] : null; }
  /** Signed 64-bit integer as a Number. */
  int(f, def = 0) { const x = this.last(f); return x && x.wt === 0 ? Number(BigInt.asIntN(64, x.v)) : def; }
  uint(f, def = 0) { const x = this.last(f); return x && x.wt === 0 ? Number(BigInt.asUintN(64, x.v)) : def; }
  bool(f, def = false) { const x = this.last(f); return x && x.wt === 0 ? x.v !== 0n : def; }
  float(f, def = 0) { const x = this.last(f); return x && (x.wt === 5 || x.wt === 1) ? x.v : def; }
  str(f, def = '') { const x = this.last(f); return x && x.wt === 2 ? dec.decode(x.v) : def; }
  bytes(f) { const x = this.last(f); return x && x.wt === 2 ? x.v : null; }
  msg(f) { const x = this.last(f); return x && x.wt === 2 ? new Pb(x.v) : null; }
  msgs(f) { return (this.fields.get(f) || []).filter((x) => x.wt === 2).map((x) => new Pb(x.v)); }
  /** repeated float, packed or not. */
  floats(f) {
    const out = [];
    for (const x of this.fields.get(f) || []) {
      if (x.wt === 5) out.push(x.v);
      else if (x.wt === 2) {
        const dv = new DataView(x.v.buffer, x.v.byteOffset, x.v.byteLength);
        for (let j = 0; j + 4 <= x.v.length; j += 4) out.push(dv.getFloat32(j, true));
      }
    }
    return out;
  }
}

/** Round a float32 to a sensible number of digits (0.9 instead of 0.8999999761581421). */
export function f32(x, digits = 6) {
  return Number.isFinite(x) ? Number(x.toPrecision(digits)) : x;
}
