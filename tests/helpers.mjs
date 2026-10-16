// Shared test setup: in-memory IndexedDB and the vendored libraries loaded in Node.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Collection } from '../js/db/collection.js';
import { setVendor } from '../js/io/vendor.js';
import * as fzstd from '../vendor/fzstd.mjs';

const require = createRequire(import.meta.url);
const vendorDir = fileURLToPath(new URL('../vendor/', import.meta.url));
// The vendored files are UMD scripts; the package is "type": "module", so load them as CommonJS by hand.
function loadUmd(file) {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__filename', '__dirname', readFileSync(vendorDir + file, 'utf8'))(module, module.exports, require, vendorDir + file, vendorDir);
  return module.exports;
}
const initSqlJs = loadUmd('sql-wasm.js');
const JSZip = loadUmd('jszip.min.js');
const SQL = await initSqlJs({ locateFile: (f) => vendorDir + f });
setVendor({ SQL, JSZip, fzstd });

let n = 0;
export function freshCol() { return Collection.open(new IDBFactory(), `t${n++}`); }
export function fixture(name) { return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))); }
export const expected = JSON.parse(readFileSync(new URL('./fixtures/expected.json', import.meta.url), 'utf8'));
export { SQL, JSZip };
