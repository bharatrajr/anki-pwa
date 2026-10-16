// Exporting to Anki: .apkg (a deck or everything, with or without progress and media),
// .colpkg (the whole collection), Anki "Notes in Plain Text" (.txt) and CSV.
//
// Packages use Anki's "support older Anki versions" layout (meta v2 + collection.anki21,
// SQLite schema 11 with JSON configs, JSON media list, uncompressed media). Anki desktop,
// AnkiDroid and AnkiMobile all import it; FSRS memory state travels in cards.data.

import { getSql, getZip } from './vendor.js';
import { DEFAULT_DECK_ID, DEFAULT_PRESET_ID, homeCard } from '../db/collection.js';
import { KIND_CLOZE } from '../model/notetypes.js';
import { mediaRefs, stripHtml } from '../render/html.js';
import { normaliseParams } from '../sched/fsrs.js';

const SCHEMA = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL, ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL);
CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const LATEX_POST = '\\end{document}';
const secs = (ms) => Math.floor((ms || 0) / 1000);

/**
 * Gather what to export. did = null exports everything.
 * Returns { decks, cards, notes, notetypes, presets, revlog }.
 */
export async function collectExport(col, { did = null, withScheduling = true } = {}) {
  const deckIds = did ? new Set(col.deckSubtreeIds(did)) : null;
  let cards = (await col.allCards()).map(homeCard);
  if (deckIds) cards = cards.filter((c) => deckIds.has(c.did));
  const nids = new Set(cards.map((c) => c.nid));
  const notes = (await col.allNotes()).filter((n) => nids.has(n.id));
  const ntids = new Set(notes.map((n) => n.ntid));
  const notetypes = [...col.notetypes.values()].filter((n) => ntids.has(n.id));
  // Decks: the exported ones plus their parents and Default (Anki expects it).
  const keep = new Set([DEFAULT_DECK_ID]);
  for (const c of cards) { keep.add(c.did); for (const p of col.parentDeckIds(c.did)) keep.add(p); }
  if (did) { keep.add(did); for (const p of col.parentDeckIds(did)) keep.add(p); for (const id of deckIds) keep.add(id); }
  const decks = [...col.decks.values()].filter((d) => keep.has(d.id) && !d.dyn);
  const presetIds = new Set([DEFAULT_PRESET_ID, ...decks.map((d) => d.presetId)]);
  const presets = [...col.presets.values()].filter((p) => presetIds.has(p.id));
  const cids = new Set(cards.map((c) => c.id));
  const revlog = withScheduling ? (await col.allRevlog()).filter((r) => cids.has(r.cid)) : [];
  return { decks, cards, notes, notetypes, presets, revlog };
}

// ---------- JSON for the schema-11 col row ----------

export function notetypeJson(nt, now) {
  const fieldNames = nt.fields.map((f) => f.name);
  const req = nt.kind === KIND_CLOZE
    ? [[0, 'any', [0]]]
    : nt.templates.map((t) => [t.ord, 'any', fieldNames.map((n, i) => (t.qfmt.includes(n) ? i : -1)).filter((i) => i >= 0)]);
  return {
    id: nt.id, name: nt.name, type: nt.kind === KIND_CLOZE ? 1 : 0, mod: secs(nt.mod || now), usn: -1, sortf: nt.sortf || 0, did: DEFAULT_DECK_ID,
    tmpls: nt.templates.map((t) => ({ name: t.name, ord: t.ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: t.bqfmt || '', bafmt: t.bafmt || '', did: null, bfont: '', bsize: 0 })),
    flds: nt.fields.map((f, i) => ({ name: f.name, ord: i, sticky: !!f.sticky, rtl: !!f.rtl, font: f.font || 'Arial', size: f.size || 20, description: f.description || '', plainText: false, collapsed: false, excludeFromSearch: false })),
    css: nt.css || '', latexPre: nt.latexPre || LATEX_PRE, latexPost: nt.latexPost || LATEX_POST, latexsvg: !!nt.latexsvg,
    req, originalStockKind: nt.originalStockKind || 0, tags: [], vers: [],
  };
}

export function deckJson(d) {
  return {
    id: d.id, mod: secs(d.mod), name: d.name, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    collapsed: !!d.collapsed, browserCollapsed: !!d.collapsed, desc: d.desc || '', dyn: 0, conf: d.presetId || DEFAULT_PRESET_ID,
    extendNew: 0, extendRev: 0,
  };
}

export function presetJson(p) {
  const params = p.fsrsParams ? normaliseParams(p.fsrsParams) : [];
  return {
    id: p.id, mod: 0, name: p.name, usn: -1, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { bury: !!p.buryNew, delays: p.learnSteps, initialFactor: Math.round(p.startingEase * 1000), ints: [p.gradIvl, p.easyIvl, 0], order: p.newOrder === 'random' ? 0 : 1, perDay: p.newPerDay },
    rev: { bury: !!p.buryRev, ease4: p.easyBonus, ivlFct: p.ivlMod, maxIvl: p.maxIvl, perDay: p.revPerDay, hardFactor: p.hardMult },
    lapse: { delays: p.relearnSteps, leechAction: p.leechAction === 'suspend' ? 0 : 1, leechFails: p.leechThreshold, minInt: p.minLapseIvl, mult: p.lapseMult },
    buryInterdayLearning: !!p.buryInterday, newMix: 0, newPerDayMinimum: 0, interdayLearningMix: 0, reviewOrder: 0, newSortOrder: 0, newGatherPriority: 0,
    fsrsWeights: [], fsrsParams5: [], fsrsParams6: params.length === 21 ? params : [], desiredRetention: p.retention,
  };
}

/** Build the schema-11 SQLite file. Returns Uint8Array. */
export async function buildCollectionDb(col, data, { withScheduling = true } = {}) {
  const SQL = await getSql();
  const db = new SQL.Database();
  try {
    db.run(SCHEMA);
    const now = Date.now();
    const models = {}, decks = {}, dconf = {};
    for (const nt of data.notetypes) models[nt.id] = notetypeJson(nt, now);
    for (const d of data.decks) decks[d.id] = deckJson(d);
    for (const p of data.presets) dconf[p.id] = presetJson(p);
    const fsrs = (col.presets.get(DEFAULT_PRESET_ID)?.scheduler || 'fsrs') === 'fsrs';
    const conf = {
      activeDecks: [DEFAULT_DECK_ID], curDeck: DEFAULT_DECK_ID, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true,
      curModel: data.notetypes[0]?.id ?? null, nextPos: col.col.nextPos, sortType: 'noteFld', sortBackwards: false, addToCur: true,
      dayLearnFirst: false, schedVer: 2, sched2021: true, rollover: col.settings.rolloverHour, fsrs,
      creationOffset: new Date(col.col.crt * 1000).getTimezoneOffset(),
    };
    db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)',
      [col.col.crt, now, now, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}']);

    const ntById = new Map(data.notetypes.map((n) => [n.id, n]));
    const insNote = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, ?)');
    for (const n of data.notes) {
      let tags = n.tags;
      if (!withScheduling) tags = tags.filter((t) => !/^(leech|marked)$/i.test(t));
      const nt = ntById.get(n.ntid);
      const fields = nt ? nt.fields.map((_, i) => n.fields[i] ?? '') : n.fields;
      insNote.run([n.id, n.guid, n.ntid, secs(n.mod), tags.length ? ` ${tags.join(' ')} ` : '', fields.join('\x1f'), n.sfld ?? stripHtml(fields[0] || ''), n.csum >>> 0, n.data || '']);
    }
    insNote.free();

    const insCard = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)');
    const noteOrder = [...new Set(data.cards.map((c) => c.nid))].sort((a, b) => a - b);
    const notePos = new Map(noteOrder.map((nid, i) => [nid, i + 1]));
    for (const c of data.cards) {
      if (withScheduling) {
        const extra = {};
        if (c.stability) { extra.s = round(c.stability, 4); extra.d = round(c.difficulty, 4); }
        if (c.lastReview) extra.lrt = secs(c.lastReview);
        insCard.run([c.id, c.nid, c.did, c.ord, secs(c.mod), c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.flags & 7, Object.keys(extra).length ? JSON.stringify(extra) : '']);
      } else {
        const due = c.type === 0 ? c.due : notePos.get(c.nid);
        insCard.run([c.id, c.nid, c.did, c.ord, secs(c.mod), 0, 0, due, 0, 0, 0, 0, 0, 0, '']);
      }
    }
    insCard.free();

    if (withScheduling) {
      const insRev = db.prepare('INSERT OR IGNORE INTO revlog VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)');
      for (const r of data.revlog) insRev.run([r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type]);
      insRev.free();
    }
    return db.export();
  } finally {
    db.close();
  }
}

function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }

/** Media files used by the exported notes (and "_"-prefixed files used by templates/CSS). */
export function referencedMedia(data) {
  const names = new Set();
  for (const n of data.notes) for (const f of n.fields) for (const m of mediaRefs(f)) names.add(m);
  for (const nt of data.notetypes) {
    const src = [nt.css, ...nt.templates.flatMap((t) => [t.qfmt, t.afmt])].join('\n');
    for (const m of src.matchAll(/["'(]\s*(_[^"')\s]+)/g)) names.add(m[1]);
  }
  return names;
}

/**
 * Build an .apkg (or .colpkg when `full`). Returns a Blob.
 * opts: { did, withScheduling, withMedia, full, onProgress }
 */
export async function exportPackage(col, opts = {}) {
  const { did = null, withScheduling = true, withMedia = true, full = false, onProgress } = opts;
  onProgress?.('Collecting cards…');
  const data = await collectExport(col, { did: full ? null : did, withScheduling: full || withScheduling });
  if (full) {
    data.decks = [...col.decks.values()].filter((d) => !d.dyn);
    data.presets = [...col.presets.values()];
    data.notetypes = [...col.notetypes.values()];
  }
  onProgress?.('Writing collection…');
  const dbBytes = await buildCollectionDb(col, data, { withScheduling: full || withScheduling });
  const JSZip = await getZip();
  const zip = new JSZip();
  zip.file('meta', new Uint8Array([0x08, 0x02])); // PackageMetadata { version: LEGACY_2 }
  zip.file('collection.anki21', dbBytes);
  zip.file('collection.anki2', dbBytes); // for very old importers that only look for this name
  const mediaMap = {};
  if (withMedia || full) {
    const names = full ? (await col.getAll('media')).map((m) => m.name) : [...referencedMedia(data)];
    let i = 0;
    for (const name of names) {
      const rec = await col.getMedia(name);
      if (!rec) continue;
      if (i % 20 === 0) onProgress?.(`Adding media ${i + 1} of ${names.length}…`);
      zip.file(String(i), new Uint8Array(await rec.blob.arrayBuffer()), { compression: /^(image\/(jpeg|png|gif|webp)|audio|video)/.test(rec.mime) ? 'STORE' : 'DEFLATE' });
      mediaMap[i] = name;
      i++;
    }
  }
  zip.file('media', JSON.stringify(mediaMap));
  onProgress?.('Compressing…');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  return { blob, counts: { notes: data.notes.length, cards: data.cards.length, revlog: (full || withScheduling) ? data.revlog.length : 0, media: Object.keys(mediaMap).length } };
}

// ---------- text formats ----------

function quoteField(s, sep) {
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function plain(s) {
  return stripHtml(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n')).replace(/\n+$/, '');
}

/**
 * Anki "Notes in Plain Text": header lines then one note per line.
 * opts: { did, html, tags, deck, notetype, guid }
 */
export async function exportNotesText(col, opts = {}) {
  const { did = null, html = true, tags = true, deck = true, notetype = true, guid = true } = opts;
  const data = await collectExport(col, { did, withScheduling: false });
  const sep = '\t';
  const deckOf = new Map();
  for (const c of data.cards) if (!deckOf.has(c.nid) || c.ord === 0) deckOf.set(c.nid, c.did);
  const ntById = new Map(data.notetypes.map((n) => [n.id, n]));
  const header = ['#separator:tab', `#html:${html}`];
  let colNo = 1;
  if (guid) header.push(`#guid column:${colNo++}`);
  if (notetype) header.push(`#notetype column:${colNo++}`);
  if (deck) header.push(`#deck column:${colNo++}`);
  const maxFields = Math.max(0, ...data.notes.map((n) => ntById.get(n.ntid)?.fields.length || n.fields.length));
  if (tags) header.push(`#tags column:${colNo + maxFields}`);
  const lines = data.notes.sort((a, b) => a.id - b.id).map((n) => {
    const nt = ntById.get(n.ntid);
    const cols = [];
    if (guid) cols.push(n.guid);
    if (notetype) cols.push(nt?.name || '');
    if (deck) cols.push(col.decks.get(deckOf.get(n.id))?.name || '');
    const fields = n.fields.map((f) => (html ? f : plain(f)));
    while (fields.length < maxFields) fields.push('');
    cols.push(...fields);
    if (tags) cols.push(n.tags.join(' '));
    return cols.map((v) => quoteField(v, sep)).join(sep);
  });
  return { blob: new Blob([header.join('\n') + '\n' + lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), counts: { notes: data.notes.length } };
}

/** CSV with a header row: GUID, Deck, Note type, Tags, then the fields. */
export async function exportCsv(col, opts = {}) {
  const { did = null, html = false } = opts;
  const data = await collectExport(col, { did, withScheduling: false });
  const ntById = new Map(data.notetypes.map((n) => [n.id, n]));
  const deckOf = new Map();
  for (const c of data.cards) if (!deckOf.has(c.nid) || c.ord === 0) deckOf.set(c.nid, c.did);
  const maxFields = Math.max(1, ...data.notes.map((n) => ntById.get(n.ntid)?.fields.length || n.fields.length));
  const oneType = data.notetypes.length === 1 ? data.notetypes[0] : null;
  const fieldHeads = Array.from({ length: maxFields }, (_, i) => oneType?.fields[i]?.name || `Field ${i + 1}`);
  const rows = [['GUID', 'Deck', 'Note type', 'Tags', ...fieldHeads]];
  for (const n of data.notes.sort((a, b) => a.id - b.id)) {
    const fields = n.fields.map((f) => (html ? f : plain(f)));
    while (fields.length < maxFields) fields.push('');
    rows.push([n.guid, col.decks.get(deckOf.get(n.id))?.name || '', ntById.get(n.ntid)?.name || '', n.tags.join(' '), ...fields]);
  }
  const text = rows.map((r) => r.map((v) => quoteField(String(v), ',')).join(',')).join('\r\n') + '\r\n';
  return { blob: new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }), counts: { notes: data.notes.length } };
}

export function exportFilename(col, { did, ext }) {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const base = did ? col.decks.get(did)?.name.replace(/::/g, ' - ').replace(/[\\/:*?"<>|]/g, '_') : ext === 'colpkg' ? 'collection' : 'All decks';
  return `${base} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
}
