// Small, dependency-free helpers: SHA-1 (sync), seeded RNG, Anki-style GUIDs, ids.

const enc = new TextEncoder();

/** Synchronous SHA-1 of a UTF-8 string. Returns Uint8Array(20). */
export function sha1Bytes(input) {
  const msg = typeof input === 'string' ? enc.encode(input) : input;
  const ml = msg.length;
  const withPad = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(withPad);
  buf.set(msg);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = ml * 8;
  dv.setUint32(withPad - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(withPad - 4, bits >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const od = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => od.setUint32(i * 4, h));
  return out;
}

export function sha1Hex(input) {
  return Array.from(sha1Bytes(input), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** mulberry32 seeded PRNG → function returning [0,1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit hash of numbers/strings (FNV-1a). */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x7c; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Anki's base91 alphabet for guid64 (anki/utils.py: _base91_extra_chars).
const BASE91 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';

/** Random 64-bit value encoded in Anki's base91, like Anki's guid64(). */
export function guid64() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) return 'a';
  let s = '';
  while (n > 0n) {
    s = BASE91[Number(n % 91n)] + s;
    n /= 91n;
  }
  return s;
}

let lastId = 0;
/** Millisecond-timestamp ids like Anki, guaranteed unique and increasing within this session. */
export function newId(now = Date.now()) {
  lastId = Math.max(now, lastId + 1);
  return lastId;
}
/** Make sure future ids are above ids already present (after import / load). */
export function bumpIdFloor(id) {
  if (id > lastId) lastId = id;
}
