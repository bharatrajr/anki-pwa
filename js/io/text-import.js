// Importing notes from text: Anki's "Notes in Plain Text" (.txt with #header lines),
// CSV/TSV with a column mapping, Quizlet exports, and JSON.

import { escapeHtml } from '../render/html.js';
import { fieldChecksum, sortFieldText } from '../model/cards.js';
import { normaliseTags, DEFAULT_DECK_ID } from '../db/collection.js';

const SEP_NAMES = { comma: ',', semicolon: ';', tab: '\t', space: ' ', pipe: '|', colon: ':' };

/** Parse delimited text with RFC-4180 quoting ("a ""b""" → a "b"). Returns rows of strings. */
export function parseDelimited(text, sep, { quotes = true } = {}) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false, fieldStart = true;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (quotes && ch === '"' && fieldStart) { inQ = true; fieldStart = false; i++; continue; }
    if (text.startsWith(sep, i)) { row.push(field); field = ''; fieldStart = true; i += sep.length; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; fieldStart = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; fieldStart = false; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Guess the separator from the first lines: tab, then semicolon/comma/pipe by consistency. */
export function detectSeparator(text) {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).slice(0, 20);
  for (const sep of ['\t', '|', ';', ',', ':']) {
    const counts = lines.map((l) => l.split(sep).length - 1);
    if (counts.length && counts.every((c) => c > 0 && c === counts[0])) return sep;
  }
  for (const sep of ['\t', ';', ',', '|']) if (lines.some((l) => l.includes(sep))) return sep;
  return '\t';
}

/**
 * Parse Anki's plain-text format. Header lines: #separator:Tab, #html:true, #tags:a b,
 * #columns:Front	Back, #notetype:Basic, #deck:Name, #notetype column:1, #deck column:2,
 * #tags column:3, #guid column:4 (columns are 1-based).
 * Returns { rows, header: {...}, columns: [names] | null }.
 */
export function parseAnkiText(text) {
  text = text.replace(/^﻿/, '');
  const header = {};
  const lines = text.split(/\r?\n/);
  let bodyStart = 0;
  for (; bodyStart < lines.length; bodyStart++) {
    const m = /^#([a-z ]+):(.*)$/i.exec(lines[bodyStart]);
    if (!m) break;
    header[m[1].trim().toLowerCase()] = m[2].trim();
  }
  let sep = header.separator;
  if (sep) sep = SEP_NAMES[sep.toLowerCase()] || sep;
  const body = lines.slice(bodyStart).join('\n');
  sep ||= detectSeparator(body);
  const rows = parseDelimited(body, sep);
  const col = (k) => (header[k] ? parseInt(header[k], 10) - 1 : -1);
  return {
    rows, sep,
    header: {
      html: header.html ? /^(true|yes|1)$/i.test(header.html) : null,
      tags: header.tags ? header.tags.split(/\s+/).filter(Boolean) : [],
      notetype: header.notetype || null, deck: header.deck || null,
      notetypeCol: col('notetype column'), deckCol: col('deck column'), tagsCol: col('tags column'), guidCol: col('guid column'),
    },
    columns: header.columns ? header.columns.split(sep) : null,
    hasHeaderLines: bodyStart > 0,
  };
}

/** Quizlet export: term/definition separator and row separator chosen when exporting. */
export function parseQuizlet(text, termSep = '\t', rowSep = '\n') {
  const rs = rowSep === '\n' ? /\r?\n/ : rowSep;
  return text.split(rs).map((r) => r.trim() ? r : null).filter(Boolean).map((r) => {
    const i = r.indexOf(termSep);
    return i < 0 ? [r.trim(), ''] : [r.slice(0, i).trim(), r.slice(i + termSep.length).trim()];
  });
}

/**
 * JSON: an array of objects, or {notes|cards: [...]}. Objects may use field names as keys
 * ({"Front": "…", "Back": "…", "tags": "a b", "deck": "X"}) or {"fields": [...]}.
 * Returns { rows, columns }.
 */
export function parseJsonNotes(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This is not valid JSON.'); }
  const list = Array.isArray(data) ? data : data?.notes || data?.cards || data?.items;
  if (!Array.isArray(list) || !list.length) throw new Error('Expected a list of notes, e.g. [{"Front": "…", "Back": "…"}].');
  const columns = [];
  const add = (k) => { if (!columns.includes(k)) columns.push(k); };
  for (const o of list) {
    if (Array.isArray(o)) { o.forEach((_, i) => add(`Field ${i + 1}`)); continue; }
    if (Array.isArray(o.fields)) { o.fields.forEach((_, i) => add(`Field ${i + 1}`)); for (const k of Object.keys(o)) if (k !== 'fields') add(k); continue; }
    for (const k of Object.keys(o)) add(k);
  }
  const rows = list.map((o) => columns.map((c) => {
    let v;
    if (Array.isArray(o)) v = o[+c.slice(6) - 1];
    else if (/^Field \d+$/.test(c) && Array.isArray(o.fields)) v = o.fields[+c.slice(6) - 1];
    else v = o[c];
    if (Array.isArray(v)) return v.join(' ');
    return v === undefined || v === null ? '' : String(v);
  }));
  return { rows, columns };
}

/**
 * Suggest a mapping of columns to targets: 'f:<index>' (field), 'tags', 'deck', 'notetype', 'guid' or ''.
 * Matches column names to field names, then fills fields left to right.
 */
export function suggestMapping(columns, ncols, notetype, header = {}) {
  const map = new Array(ncols).fill('');
  const names = notetype.fields.map((f) => f.name.toLowerCase());
  const special = { tags: 'tags', tag: 'tags', deck: 'deck', notetype: 'notetype', 'note type': 'notetype', guid: 'guid' };
  if (header.tagsCol >= 0) map[header.tagsCol] = 'tags';
  if (header.deckCol >= 0) map[header.deckCol] = 'deck';
  if (header.notetypeCol >= 0) map[header.notetypeCol] = 'notetype';
  if (header.guidCol >= 0) map[header.guidCol] = 'guid';
  const used = new Set();
  if (columns) {
    columns.forEach((c, i) => {
      if (map[i]) return;
      const k = String(c).trim().toLowerCase();
      if (special[k]) { map[i] = special[k]; return; }
      const fi = names.indexOf(k);
      if (fi >= 0 && !used.has(fi)) { map[i] = `f:${fi}`; used.add(fi); }
    });
  }
  let next = 0;
  for (let i = 0; i < ncols; i++) {
    if (map[i] || (columns && columns[i] !== undefined && special[String(columns[i]).trim().toLowerCase()])) continue;
    while (used.has(next)) next++;
    if (next >= names.length) break;
    map[i] = `f:${next}`; used.add(next); next++;
  }
  return map;
}

/** Plain text to field HTML: escape and keep line breaks. */
function toHtml(s, html) {
  if (html) return s;
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

/**
 * Import rows. opts: { mapping, ntid, did, html, tags: [], dupes: 'skip'|'update'|'add', onProgress }.
 * Returns { added, updated, skipped, cards, errors: [msg] }.
 */
export async function importRows(col, rows, opts) {
  const { mapping, html = false, dupes = 'update', onProgress } = opts;
  const baseTags = normaliseTags(opts.tags || []);
  const result = { added: 0, updated: 0, skipped: 0, cards: 0, errors: [] };
  const existing = await col.allNotes();
  const byGuid = new Map(existing.map((n) => [n.guid, n]));
  const byKey = new Map(existing.map((n) => [`${n.ntid}:${n.csum}:${n.fields[0]}`, n]));
  const newNotes = [], newCards = [], changed = [];
  const now = Date.now();
  for (const [i, row] of rows.entries()) {
    if (i % 500 === 0) onProgress?.(`Row ${i + 1} of ${rows.length}…`);
    let nt = col.notetypes.get(opts.ntid);
    let did = opts.did || DEFAULT_DECK_ID;
    let guid = null;
    let tags = [...baseTags];
    const fields = [];
    mapping.forEach((target, ci) => {
      const v = row[ci] ?? '';
      if (!target) return;
      if (target === 'tags') tags.push(...v.split(/\s+/).filter(Boolean));
      else if (target === 'guid') guid = v.trim() || null;
      else if (target === 'notetype') { const t = col.notetypeByName(v.trim()); if (t) nt = t; }
      else if (target.startsWith('f:')) fields[+target.slice(2)] = toHtml(v, html);
    });
    const deckCol = mapping.indexOf('deck');
    if (deckCol >= 0 && (row[deckCol] || '').trim()) did = (await col.addDeck(row[deckCol])).id;
    for (let f = 0; f < nt.fields.length; f++) fields[f] ??= '';
    if (!fields.some((f) => f.trim())) { result.skipped++; continue; }
    tags = normaliseTags(tags);

    let dupe = guid ? byGuid.get(guid) : null;
    if (!dupe && dupes !== 'add') {
      const key = `${nt.id}:${fieldChecksum(fields[0] || '')}:${fields[0]}`;
      dupe = byKey.get(key) || null;
    }
    if (dupe && dupes !== 'add') {
      if (dupes === 'skip' || dupe.ntid !== nt.id) { result.skipped++; continue; }
      const upd = { ...dupe, fields: fields.slice(0, nt.fields.length), tags: normaliseTags([...dupe.tags, ...tags]), mod: now };
      upd.csum = fieldChecksum(upd.fields[0] || '');
      upd.sfld = sortFieldText(nt, upd);
      changed.push(upd);
      result.updated++;
      continue;
    }
    try {
      const { note, cards } = col.buildNote({ ntid: nt.id, fields, tags, did, guid: guid || undefined }, now);
      newNotes.push(note);
      newCards.push(...cards);
      byKey.set(`${nt.id}:${note.csum}:${note.fields[0]}`, note);
      if (guid) byGuid.set(guid, note);
      result.added++;
      result.cards += cards.length;
    } catch (e) {
      result.errors.push(`Row ${i + 1}: ${e.message}`);
      result.skipped++;
    }
  }
  onProgress?.('Saving…');
  await col.writeNotesAndCards({ notes: newNotes, cards: newCards });
  // updateNote also adds cards that the new content needs (e.g. new clozes).
  for (const n of changed) await col.updateNote(n);
  return result;
}
