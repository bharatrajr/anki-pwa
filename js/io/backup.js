// Lossless full backup: every IndexedDB store, with media blobs as base64.

import { STORES } from '../db/schema.js';

export const BACKUP_FORMAT = 'anki-pwa-backup';
export const BACKUP_VERSION = 1;

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: type || 'application/octet-stream' });
}

/** Build the backup object. */
export async function buildBackup(col) {
  const data = {};
  for (const s of STORES) {
    const rows = await col.getAll(s);
    if (s === 'media') {
      data[s] = [];
      for (const r of rows) data[s].push({ name: r.name, mime: r.mime, size: r.size, b64: await blobToBase64(r.blob) });
    } else data[s] = rows;
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, created: Date.now(), app: 'AnkiPWA', data };
}

export async function backupBlob(col) {
  const obj = await buildBackup(col);
  return new Blob([JSON.stringify(obj)], { type: 'application/json' });
}

export function backupFilename(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `ankipwa-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** Parse and validate a backup file's text; returns store data ready for replaceAll. */
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (!obj || obj.format !== BACKUP_FORMAT || !obj.data) throw new Error('This is not an AnkiPWA backup file.');
  if (obj.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  const data = {};
  for (const s of STORES) data[s] = Array.isArray(obj.data[s]) ? obj.data[s] : [];
  data.media = data.media.map((m) => ({ name: m.name, mime: m.mime, size: m.size, blob: base64ToBlob(m.b64, m.mime) }));
  if (!data.meta.some((m) => m.key === 'col')) throw new Error('The backup is missing collection data.');
  return { data, created: obj.created, counts: Object.fromEntries(STORES.map((s) => [s, data[s].length])) };
}
