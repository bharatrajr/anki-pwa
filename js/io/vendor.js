// Lazy loading of the vendored libraries (sql.js, JSZip, fzstd). They are only needed
// for Anki import/export, so the app shell stays small. Tests inject Node versions
// with setVendor().

const base = new URL('../../vendor/', import.meta.url);
const injected = {};
let sqlPromise = null;
let zipPromise = null;

export function setVendor(libs) { Object.assign(injected, libs); }

function loadScript(src, globalName) {
  if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (globalThis[globalName] ? resolve(globalThis[globalName]) : reject(new Error(`${globalName} did not load`)));
    s.onerror = () => reject(new Error(`Could not load ${src}. Open the app once while online so it can be cached.`));
    document.head.append(s);
  });
}

/** The sql.js module (with .Database). */
export function getSql() {
  if (injected.SQL) return Promise.resolve(injected.SQL);
  sqlPromise ||= loadScript(new URL('sql-wasm.js', base).href, 'initSqlJs')
    .then((init) => init({ locateFile: (f) => new URL(f, base).href }))
    .catch((e) => { sqlPromise = null; throw e; });
  return sqlPromise;
}

/** The JSZip constructor. */
export function getZip() {
  if (injected.JSZip) return Promise.resolve(injected.JSZip);
  zipPromise ||= loadScript(new URL('jszip.min.js', base).href, 'JSZip').catch((e) => { zipPromise = null; throw e; });
  return zipPromise;
}

/** Decompress a zstd frame. */
export async function zstdDecompress(bytes) {
  const mod = injected.fzstd || (await import('../../vendor/fzstd.mjs'));
  return mod.decompress(bytes);
}

export function isZstd(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}
