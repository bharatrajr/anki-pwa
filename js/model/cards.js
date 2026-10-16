// Which cards a note should have (Anki's card generation rules, simplified to the
// documented behaviour): standard note types get one card per template whose front
// side is non-empty; cloze note types get one card per cloze number.

import { KIND_CLOZE, fieldMap } from './notetypes.js';
import { renderTemplate } from '../render/template.js';
import { clozeNumbers } from '../render/cloze.js';
import { stripHtml, stripHtmlPreservingMediaFilenames } from '../render/html.js';
import { sha1Bytes } from '../util/hash.js';

/** Returns the list of ords (0-based) that should exist for this note. */
export function cardOrdsForNote(notetype, note) {
  const fields = fieldMap(notetype, note);
  if (notetype.kind === KIND_CLOZE) {
    const nums = new Set();
    // Only fields used with the cloze filter in the front template count.
    const qfmt = notetype.templates[0]?.qfmt || '';
    const used = [...qfmt.matchAll(/\{\{[^}]*cloze:([^}]+)\}\}/g)].map((m) => m[1].trim());
    for (const name of used) for (const n of clozeNumbers(fields[name] || '')) nums.add(n);
    const ords = [...nums].filter((n) => n >= 1 && n <= 500).sort((a, b) => a - b).map((n) => n - 1);
    return ords.length ? ords : [0]; // Anki keeps one (empty) card for a cloze note with no clozes
  }
  const ords = [];
  const empty = {};
  for (const k of Object.keys(fields)) empty[k] = '';
  for (const t of notetype.templates) {
    const ctx = { side: 'q', cardOrd: t.ord, tags: [] };
    const filled = normalise(renderTemplate(t.qfmt, { ...ctx, fields }).html);
    const blank = normalise(renderTemplate(t.qfmt, { ...ctx, fields: empty }).html);
    if (filled && filled !== blank) ords.push(t.ord);
  }
  return ords;
}

function normalise(html) {
  // Ignore the type-answer box when deciding emptiness.
  return stripHtmlPreservingMediaFilenames(html.replace(/<input[^>]*id="typeans"[^>]*>/g, '')).replace(/\s+/g, '');
}

/** Anki's note checksum: first 4 bytes (big-endian) of SHA-1 of the stripped first field. */
export function fieldChecksum(text) {
  const b = sha1Bytes(stripHtmlPreservingMediaFilenames(text));
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/** Text used for the sort field / browser column. */
export function sortFieldText(notetype, note) {
  return stripHtmlPreservingMediaFilenames(note.fields[notetype.sortf || 0] || '').trim();
}
