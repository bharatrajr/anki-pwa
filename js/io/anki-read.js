// Reading Anki packages (.apkg decks, .colpkg collections) into the app's own record
// shapes. Supports the current format (collection.anki21b: zstd-compressed SQLite with
// schema 18, protobuf configs, zstd media and a protobuf media list) and the legacy
// formats (collection.anki21 / collection.anki2: schema 11 with JSON configs and a
// JSON media list).

import { getSql, getZip, zstdDecompress, isZstd } from './vendor.js';
import { Pb, f32 } from './protobuf.js';
import { KIND_CLOZE, KIND_STANDARD } from '../model/notetypes.js';
import { fieldChecksum, sortFieldText } from '../model/cards.js';
import { withDefaults, DEFAULT_PRESET } from '../sched/scheduler.js';
import { normaliseTags, guessMime } from '../db/collection.js';

const PKG_LEGACY_1 = 1, PKG_LEGACY_2 = 2, PKG_LATEST = 3;

/**
 * Open an Anki package. `input` is a File/Blob/ArrayBuffer/Uint8Array.
 * Returns a package object (see bottom of readCollection) plus getMedia(name) → Blob.
 */
export async function readAnkiPackage(input, { filename = '' } = {}) {
  const JSZip = await getZip();
  let zip;
  try { zip = await JSZip.loadAsync(input instanceof Blob ? await input.arrayBuffer() : input); }
  catch { throw new Error('This file is not an Anki package (it is not a zip file).'); }

  let version = PKG_LEGACY_1;
  const metaFile = zip.file('meta');
  if (metaFile) version = new Pb(await metaFile.async('uint8array')).int(1, PKG_LEGACY_1) || PKG_LEGACY_1;

  let dbName = null;
  for (const n of ['collection.anki21b', 'collection.anki21', 'collection.anki2']) if (zip.file(n)) { dbName = n; break; }
  if (!dbName) throw new Error('No Anki collection inside this file.');
  if (dbName === 'collection.anki21b' && version < PKG_LATEST) version = PKG_LATEST;
  let dbBytes = await zip.file(dbName).async('uint8array');
  if (isZstd(dbBytes)) dbBytes = await zstdDecompress(dbBytes);

  // Media list: name → zip entry.
  const media = new Map();
  const mediaFile = zip.file('media');
  if (mediaFile) {
    let raw = await mediaFile.async('uint8array');
    if (isZstd(raw)) raw = await zstdDecompress(raw);
    if (raw[0] === 0x7b /* { */) {
      const map = JSON.parse(new TextDecoder().decode(raw));
      for (const [entry, name] of Object.entries(map)) media.set(name, entry);
    } else {
      new Pb(raw).msgs(1).forEach((e, i) => {
        const entry = e.has(255) ? String(e.uint(255)) : String(i);
        media.set(e.str(1), entry);
      });
    }
  }

  const SQL = await getSql();
  const db = new SQL.Database(dbBytes);
  let pkg;
  try { pkg = readCollection(db); }
  finally { db.close(); }

  const isColpkg = /\.colpkg$/i.test(filename);
  return {
    ...pkg,
    kind: isColpkg ? 'colpkg' : 'apkg',
    version,
    mediaNames: [...media.keys()],
    async getMedia(name) {
      const entry = media.get(name);
      const f = entry !== undefined && zip.file(entry);
      if (!f) return null;
      let bytes = await f.async('uint8array');
      if (version >= PKG_LATEST && isZstd(bytes)) bytes = await zstdDecompress(bytes);
      return new Blob([bytes], { type: guessMime(name) });
    },
  };
}

function rows(db, sql) {
  const out = [];
  const st = db.prepare(sql);
  try { while (st.step()) out.push(st.getAsObject()); }
  finally { st.free(); }
  return out;
}

function tableExists(db, name) {
  return rows(db, `select name from sqlite_master where type='table' and name='${name}'`).length > 0;
}

/** Read every table into app-shaped records. */
export function readCollection(db) {
  const colRow = rows(db, 'select * from col')[0];
  if (!colRow) throw new Error('The collection inside this file is empty or damaged.');
  const modern = tableExists(db, 'notetypes') && rows(db, 'select count() as n from notetypes')[0].n > 0;
  let conf = {};
  try { conf = colRow.conf ? JSON.parse(colRow.conf) : {}; } catch {}
  if (tableExists(db, 'config')) {
    for (const r of rows(db, 'select KEY as k, val from config')) {
      try { conf[r.k] = JSON.parse(new TextDecoder().decode(r.val)); } catch {}
    }
  }

  const notetypes = modern ? modernNotetypes(db) : Object.entries(JSON.parse(colRow.models || '{}')).map(([key, m]) => legacyNotetype(m, key));
  const { decks, filtered } = modern ? modernDecks(db) : legacyDecks(JSON.parse(colRow.decks || '{}'));
  const fsrsOn = conf.fsrs;
  const presets = (modern ? modernPresets(db) : Object.entries(JSON.parse(colRow.dconf || '{}')).map(([key, c]) => legacyPreset(c, key)))
    .map((p) => ({ ...p, scheduler: fsrsOn === false ? 'sm2' : 'fsrs' }));

  const ntById = new Map(notetypes.map((n) => [n.id, n]));
  const notes = rows(db, 'select id, guid, mid, mod, tags, flds, flags, data from notes').map((r) => {
    const nt = ntById.get(r.mid);
    const note = {
      id: r.id, guid: String(r.guid), ntid: r.mid, mod: r.mod * 1000,
      fields: String(r.flds).split('\x1f'), tags: normaliseTags(String(r.tags || '')), flags: r.flags || 0, data: r.data || '',
    };
    if (nt) {
      while (note.fields.length < nt.fields.length) note.fields.push('');
      note.csum = fieldChecksum(note.fields[0] || '');
      note.sfld = sortFieldText(nt, note);
    }
    return note;
  });

  const revlog = rows(db, 'select id, cid, ease, ivl, lastIvl, factor, time, type from revlog').map((r) => ({ ...r, usn: -1 }));
  const lastRev = new Map();
  for (const r of revlog) if (r.type !== 4 && (!lastRev.has(r.cid) || r.id > lastRev.get(r.cid))) lastRev.set(r.cid, r.id);

  const cards = rows(db, 'select * from cards').map((r) => {
    let data = {};
    try { data = r.data ? JSON.parse(r.data) : {}; } catch {}
    const card = {
      id: r.id, nid: r.nid, did: r.did, ord: r.ord, mod: r.mod * 1000, type: r.type, queue: r.queue, due: r.due,
      ivl: r.ivl, factor: r.factor, reps: r.reps, lapses: r.lapses, left: r.left, odue: r.odue, odid: r.odid,
      flags: r.flags & 7, data: '',
      stability: Number(data.s) || 0, difficulty: Number(data.d) || 0,
      lastReview: data.lrt ? data.lrt * 1000 : lastRev.get(r.id) || 0,
    };
    // Cards in filtered decks go back to their home deck (filtered decks are not imported).
    if (card.odid) {
      card.did = card.odid;
      if (card.odue) card.due = card.odue;
      card.odid = 0; card.odue = 0;
      if (card.queue === 4) card.queue = 1; // v3 preview queue
    }
    if (card.queue === 4) card.queue = 1;
    return card;
  });

  return { crt: colRow.crt, conf, fsrs: fsrsOn, notetypes, decks, filteredDeckIds: filtered, presets, notes, cards, revlog };
}

// ---------- legacy (schema 11, JSON) ----------

// Ids in the legacy JSON can be strings (genanki writes note type ids that way, and Anki
// accepts them), so they are converted to numbers to match notes.mid / cards.did.
const toId = (v, key) => Number(v ?? key) || Number(key) || 0;

function legacyNotetype(m, key) {
  return {
    id: toId(m.id, key), name: m.name, kind: m.type === 1 ? KIND_CLOZE : KIND_STANDARD, sortf: m.sortf || 0, mod: (m.mod || 0) * 1000,
    css: m.css || '',
    fields: (m.flds || []).map((f, i) => ({ name: f.name, ord: i, sticky: !!f.sticky, rtl: !!f.rtl, font: f.font || 'Arial', size: f.size || 20, description: f.description || '' })),
    templates: (m.tmpls || []).map((t, i) => ({ name: t.name, ord: i, qfmt: t.qfmt || '', afmt: t.afmt || '', bqfmt: t.bqfmt || '', bafmt: t.bafmt || '', did: t.did || null })),
    latexPre: m.latexPre, latexPost: m.latexPost, latexsvg: !!m.latexsvg, originalStockKind: m.originalStockKind || 0,
  };
}

function legacyDecks(obj) {
  const decks = [], filtered = [];
  for (const [key, d] of Object.entries(obj)) {
    const id = toId(d.id, key);
    if (d.dyn) { filtered.push(id); continue; }
    decks.push({ id, name: String(d.name).replace(/\x1f/g, '::'), presetId: Number(d.conf) || 1, desc: d.desc || '', collapsed: !!d.collapsed, mod: (d.mod || 0) * 1000, dyn: 0 });
  }
  return { decks, filtered };
}

function legacyPreset(c, key) {
  const n = c.new || {}, r = c.rev || {}, l = c.lapse || {};
  const params = [c.fsrsParams6, c.fsrsParams5, c.fsrsWeights].find((a) => Array.isArray(a) && a.length >= 17) || null;
  return sanePreset({
    id: toId(c.id, key), name: c.name,
    learnSteps: n.delays, relearnSteps: l.delays,
    gradIvl: n.ints?.[0], easyIvl: n.ints?.[1], startingEase: n.initialFactor ? n.initialFactor / 1000 : undefined,
    newPerDay: n.perDay, revPerDay: r.perDay, buryNew: n.bury, buryRev: r.bury, buryInterday: c.buryInterdayLearning,
    newOrder: n.order === 0 ? 'random' : 'due',
    easyBonus: r.ease4, ivlMod: r.ivlFct, maxIvl: r.maxIvl, hardMult: r.hardFactor,
    lapseMult: l.mult, minLapseIvl: l.minInt, leechThreshold: l.leechFails, leechAction: l.leechAction === 0 ? 'suspend' : 'tag',
    retention: c.desiredRetention, fsrsParams: params,
  });
}

// ---------- modern (schema 18, protobuf) ----------

function modernNotetypes(db) {
  const fields = new Map(), tmpls = new Map();
  for (const r of rows(db, 'select ntid, ord, name, config from fields')) {
    const c = new Pb(r.config);
    if (!fields.has(r.ntid)) fields.set(r.ntid, []);
    fields.get(r.ntid).push({ name: r.name, ord: r.ord, sticky: c.bool(1), rtl: c.bool(2), font: c.str(3) || 'Arial', size: c.uint(4) || 20, description: c.str(5) });
  }
  for (const r of rows(db, 'select ntid, ord, name, config from templates')) {
    const c = new Pb(r.config);
    if (!tmpls.has(r.ntid)) tmpls.set(r.ntid, []);
    tmpls.get(r.ntid).push({ name: r.name, ord: r.ord, qfmt: c.str(1), afmt: c.str(2), bqfmt: c.str(3), bafmt: c.str(4), did: c.int(5) || null });
  }
  return rows(db, 'select id, name, mtime_secs, config from notetypes').map((r) => {
    const c = new Pb(r.config);
    return {
      id: r.id, name: r.name, kind: c.uint(1) === 1 ? KIND_CLOZE : KIND_STANDARD, sortf: c.uint(2), mod: r.mtime_secs * 1000,
      css: c.str(3),
      fields: (fields.get(r.id) || []).sort((a, b) => a.ord - b.ord),
      templates: (tmpls.get(r.id) || []).sort((a, b) => a.ord - b.ord),
      latexPre: c.str(5), latexPost: c.str(6), latexsvg: c.bool(7), originalStockKind: c.uint(9),
    };
  });
}

function modernDecks(db) {
  const decks = [], filtered = [];
  for (const r of rows(db, 'select id, name, mtime_secs, common, kind from decks')) {
    const kind = new Pb(r.kind);
    if (kind.has(2)) { filtered.push(r.id); continue; }
    const normal = kind.msg(1) || new Pb();
    const common = new Pb(r.common);
    decks.push({
      id: r.id, name: String(r.name).replace(/\x1f/g, '::'), presetId: normal.int(1) || 1, desc: normal.str(4),
      collapsed: common.bool(1), mod: r.mtime_secs * 1000, dyn: 0,
    });
  }
  return { decks, filtered };
}

function modernPresets(db) {
  return rows(db, 'select id, name, config from deck_config').map((r) => {
    const c = new Pb(r.config);
    const params = [6, 5, 3].map((f) => c.floats(f)).find((a) => a.length >= 17) || null;
    return sanePreset({
      id: r.id, name: r.name,
      learnSteps: c.floats(1).map((x) => f32(x)), relearnSteps: c.floats(2).map((x) => f32(x)),
      newPerDay: c.uint(9), revPerDay: c.uint(10),
      startingEase: f32(c.float(11)), easyBonus: f32(c.float(12)), hardMult: f32(c.float(13)), lapseMult: f32(c.float(14)), ivlMod: f32(c.float(15)),
      maxIvl: c.uint(16), minLapseIvl: c.uint(17), gradIvl: c.uint(18), easyIvl: c.uint(19),
      newOrder: c.uint(20) === 1 ? 'random' : 'due',
      leechAction: c.uint(21) === 0 ? 'suspend' : 'tag', leechThreshold: c.uint(22),
      buryNew: c.bool(27), buryRev: c.bool(28), buryInterday: c.bool(29),
      retention: f32(c.float(37), 4),
      fsrsParams: params ? params.map((x) => f32(x)) : null,
    });
  });
}

/** Keep only plausible values; anything missing or out of range falls back to the default. */
function sanePreset(p) {
  const d = DEFAULT_PRESET;
  const num = (v, lo, hi, def) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : def);
  const steps = (s, def) => (Array.isArray(s) && s.every((x) => typeof x === 'number' && x > 0) ? s.map(Number) : def);
  return withDefaults({
    id: p.id, name: String(p.name || 'Imported'),
    learnSteps: steps(p.learnSteps, d.learnSteps), relearnSteps: steps(p.relearnSteps, d.relearnSteps),
    newPerDay: num(p.newPerDay, 0, 99999, d.newPerDay), revPerDay: num(p.revPerDay, 0, 999999, d.revPerDay),
    startingEase: num(p.startingEase, 1.31, 10, d.startingEase), easyBonus: num(p.easyBonus, 1, 10, d.easyBonus),
    hardMult: num(p.hardMult, 0.5, 3, d.hardMult), lapseMult: num(p.lapseMult, 0, 1, d.lapseMult), ivlMod: num(p.ivlMod, 0.1, 10, d.ivlMod),
    maxIvl: num(p.maxIvl, 1, 36500, d.maxIvl), minLapseIvl: num(p.minLapseIvl, 1, 36500, d.minLapseIvl),
    gradIvl: num(p.gradIvl, 1, 36500, d.gradIvl), easyIvl: num(p.easyIvl, 1, 36500, d.easyIvl),
    newOrder: p.newOrder || 'due', leechAction: p.leechAction || 'tag', leechThreshold: num(p.leechThreshold, 1, 999, d.leechThreshold),
    buryNew: !!p.buryNew, buryRev: !!p.buryRev, buryInterday: !!p.buryInterday,
    retention: num(p.retention, 0.7, 0.99, d.retention),
    fsrsParams: Array.isArray(p.fsrsParams) && [17, 19, 21].includes(p.fsrsParams.length) && p.fsrsParams.some((x) => x !== 0) ? p.fsrsParams : null,
  });
}
