// Importing a read Anki package (see anki-read.js) into the collection.
//   replace: the package becomes the whole collection (Anki's .colpkg behaviour).
//   merge:   notes are matched by GUID (Anki's .apkg behaviour). New notes, cards, decks,
//            note types, presets, review history and media are added; existing notes are
//            updated when the file's copy is newer (configurable); existing cards keep
//            their progress unless the file's card was changed more recently.

import { DEFAULT_DECK_ID, DEFAULT_PRESET_ID, makeDeck, normaliseTags } from '../db/collection.js';
import { STORES } from '../db/schema.js';
import { fieldChecksum, sortFieldText } from '../model/cards.js';
import { newId, bumpIdFloor, sha1Hex } from '../util/hash.js';
import { localDayIndex, newCollectionCrt } from '../util/time.js';
import { withDefaults } from '../sched/scheduler.js';

const SCHED_FIELDS = ['type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'flags', 'stability', 'difficulty', 'lastReview', 'mod'];

/** Short counts shown before importing. */
export function packageSummary(pkg) {
  const reviewed = pkg.cards.filter((c) => c.type !== 0).length;
  return {
    notes: pkg.notes.length, cards: pkg.cards.length, revlog: pkg.revlog.length, media: pkg.mediaNames.length,
    decks: pkg.decks.filter((d) => !(d.id === DEFAULT_DECK_ID && !pkg.cards.some((c) => c.did === d.id))).map((d) => d.name).sort(),
    reviewed, notetypes: pkg.notetypes.map((n) => n.name),
  };
}

/** Replace the whole collection with the package. */
export async function replaceWithPackage(col, pkg, { onProgress } = {}) {
  const now = Date.now();
  const crt = pkg.crt || newCollectionCrt(now, col.settings.rolloverHour);
  const decks = pkg.decks.map((d) => ({ ...makeDeck(d.id, d.name, d.presetId), ...d }));
  if (!decks.some((d) => d.id === DEFAULT_DECK_ID)) decks.push(makeDeck(DEFAULT_DECK_ID, 'Default'));
  const presets = pkg.presets.map((p) => withDefaults(p));
  if (!presets.some((p) => p.id === DEFAULT_PRESET_ID)) presets.push(withDefaults({ id: DEFAULT_PRESET_ID, name: 'Default' }));
  const presetIds = new Set(presets.map((p) => p.id));
  for (const d of decks) if (!presetIds.has(d.presetId)) d.presetId = DEFAULT_PRESET_ID;
  const deckIds = new Set(decks.map((d) => d.id));
  const ntIds = new Set(pkg.notetypes.map((n) => n.id));
  const notes = pkg.notes.filter((n) => ntIds.has(n.ntid));
  const noteIds = new Set(notes.map((n) => n.id));
  const cards = pkg.cards.filter((c) => noteIds.has(c.nid)).map((c) => (deckIds.has(c.did) ? c : { ...c, did: DEFAULT_DECK_ID }));
  const cardIds = new Set(cards.map((c) => c.id));
  const maxPos = cards.reduce((m, c) => (c.type === 0 && c.due > m ? c.due : m), 0);
  const nextPos = Math.max(Number(pkg.conf?.nextPos) || 0, maxPos + 1);
  const data = {
    meta: [
      { key: 'col', value: { crt, nextPos, created: now, mod: now, schemaVersion: 1, lastBackup: col.col.lastBackup || 0 } },
      { key: 'settings', value: col.settings },
    ],
    notetypes: pkg.notetypes, decks, presets, notes, cards,
    revlog: pkg.revlog.filter((r) => cardIds.has(r.cid)),
    media: [],
  };
  for (const s of STORES) data[s] ||= [];
  onProgress?.('Saving cards…');
  await col.replaceAll(data);
  for (const x of [...pkg.notetypes, ...decks, ...presets, ...notes, ...cards]) bumpIdFloor(x.id);
  const media = await importMedia(col, pkg, new Set(pkg.mediaNames), onProgress, { overwrite: true });
  return { mode: 'replace', notesAdded: notes.length, cardsAdded: cards.length, revlogAdded: data.revlog.length, mediaAdded: media.added, notesUpdated: 0, notesSkipped: 0, cardsUpdated: 0, notesMissingType: pkg.notes.length - notes.length };
}

/**
 * Merge a package into the collection.
 * opts.updateNotes: 'newer' | 'always' | 'never'
 * opts.withScheduling: false imports every card as new and skips review history
 * opts.updateScheduling: also update progress of existing cards when the file's card is newer
 */
export async function mergePackage(col, pkg, opts = {}) {
  const { updateNotes = 'newer', withScheduling = true, updateScheduling = true, onProgress } = opts;
  const now = Date.now();
  const result = { mode: 'merge', notesAdded: 0, notesUpdated: 0, notesSkipped: 0, cardsAdded: 0, cardsUpdated: 0, revlogAdded: 0, mediaAdded: 0, decksAdded: 0, notesMissingType: 0 };

  // ---- note types ----
  const ntMap = new Map(); // pkg ntid → our ntid
  for (const nt of pkg.notetypes) {
    const sameShape = (o) => o.kind === nt.kind && o.fields.length === nt.fields.length && o.fields.every((f, i) => f.name === nt.fields[i].name) && o.templates.length === nt.templates.length;
    let ours = col.notetypes.get(nt.id);
    if (ours && !sameShape(ours)) ours = null;
    if (!ours) ours = [...col.notetypes.values()].find((o) => o.name === nt.name && sameShape(o)) || null;
    if (ours) {
      if (nt.mod > (ours.mod || 0) && updateNotes !== 'never') {
        ours.templates = nt.templates.map((t, i) => ({ ...ours.templates[i], ...t, did: null }));
        ours.css = nt.css;
        await col.saveNotetype(ours);
      }
      ntMap.set(nt.id, ours.id);
      continue;
    }
    const id = col.notetypes.has(nt.id) ? newId() : nt.id;
    let name = nt.name;
    for (let i = 2; col.notetypeByName(name); i++) name = `${nt.name} (${i})`;
    const copy = { ...nt, id, name, templates: nt.templates.map((t) => ({ ...t, did: null })) };
    bumpIdFloor(id);
    await col.saveNotetype(copy);
    ntMap.set(nt.id, id);
  }

  // ---- presets ----
  const presetMap = new Map();
  for (const p of pkg.presets) {
    if (p.id === DEFAULT_PRESET_ID) { presetMap.set(p.id, DEFAULT_PRESET_ID); continue; }
    const same = [...col.presets.values()].find((o) => o.name === p.name);
    if (same) { presetMap.set(p.id, same.id); continue; }
    const id = col.presets.has(p.id) ? newId() : p.id;
    bumpIdFloor(id);
    await col.savePreset({ ...p, id });
    presetMap.set(p.id, id);
  }

  // ---- decks ----
  const deckMap = new Map();
  const pkgDecks = [...pkg.decks].sort((a, b) => a.name.split('::').length - b.name.split('::').length);
  for (const d of pkgDecks) {
    const existing = col.deckByName(d.name);
    if (existing && !existing.dyn) { deckMap.set(d.id, existing.id); continue; }
    const name = existing ? `${d.name} (imported)` : d.name;
    const deck = await col.addDeck(name, presetMap.get(d.presetId) || DEFAULT_PRESET_ID);
    if (d.desc && !deck.desc) { deck.desc = d.desc; await col.saveDeck(deck); }
    deckMap.set(d.id, deck.id);
    result.decksAdded++;
  }
  const targetDeck = (did) => deckMap.get(did) || DEFAULT_DECK_ID;

  // ---- media names (rename on clash) ----
  onProgress?.('Checking media…');
  const renames = new Map();
  for (const name of pkg.mediaNames) {
    const existing = await col.getMedia(name);
    if (!existing) continue;
    const blob = await pkg.getMedia(name);
    if (!blob || blob.size === existing.size) continue; // assume identical
    const hash = sha1Hex(new Uint8Array(await blob.arrayBuffer())).slice(0, 8);
    const dot = name.lastIndexOf('.');
    renames.set(name, dot > 0 ? `${name.slice(0, dot)}-${hash}${name.slice(dot)}` : `${name}-${hash}`);
  }
  const renameRefs = (s) => {
    if (!renames.size) return s;
    for (const [from, to] of renames) s = s.split(from).join(to);
    return s;
  };

  // ---- notes ----
  onProgress?.('Matching notes…');
  const existingNotes = new Map(); // guid → note
  const existingIds = new Set();
  for (const n of await col.allNotes()) { existingNotes.set(n.guid, n); existingIds.add(n.id); }
  const noteMap = new Map(); // pkg nid → {id, existing: bool}
  const notesOut = [];
  for (const n of pkg.notes) {
    const ntid = ntMap.get(n.ntid);
    if (!ntid) { result.notesMissingType++; continue; }
    const nt = col.notetypes.get(ntid);
    const ours = existingNotes.get(n.guid);
    if (ours) {
      noteMap.set(n.id, { id: ours.id, existing: true });
      const newer = n.mod > (ours.mod || 0);
      if (ours.ntid === ntid && (updateNotes === 'always' || (updateNotes === 'newer' && newer))) {
        const changed = { ...ours, fields: n.fields.map(renameRefs), tags: normaliseTags(n.tags), mod: Math.max(n.mod, ours.mod || 0) };
        changed.csum = fieldChecksum(changed.fields[0] || '');
        changed.sfld = sortFieldText(nt, changed);
        notesOut.push(changed);
        result.notesUpdated++;
      } else result.notesSkipped++;
      continue;
    }
    const id = existingIds.has(n.id) ? newId(now) : n.id;
    existingIds.add(id);
    bumpIdFloor(id);
    let tags = n.tags;
    if (!withScheduling) tags = tags.filter((t) => !/^(leech|marked)$/i.test(t));
    const note = { ...n, id, ntid, fields: n.fields.map(renameRefs), tags };
    note.csum = fieldChecksum(note.fields[0] || '');
    note.sfld = sortFieldText(nt, note);
    notesOut.push(note);
    noteMap.set(n.id, { id, existing: false });
    result.notesAdded++;
  }

  // ---- cards ----
  onProgress?.('Matching cards…');
  const dayShift = localDayIndex(pkg.crt * 1000, col.settings.rolloverHour) - localDayIndex(col.col.crt * 1000, col.settings.rolloverHour);
  const existingCards = new Map(); // `${nid}:${ord}` → card
  const existingCardIds = new Set();
  for (const c of await col.allCards()) { existingCards.set(`${c.nid}:${c.ord}`, c); existingCardIds.add(c.id); }
  const newCardsSorted = pkg.cards.filter((c) => c.type === 0).sort((a, b) => a.due - b.due);
  const posMap = new Map();
  {
    let pos = col.col.nextPos;
    let last = null;
    for (const c of newCardsSorted) {
      if (last !== null && c.due !== last) pos++;
      posMap.set(c.id, pos);
      last = c.due;
    }
    if (newCardsSorted.length) col.col.nextPos = pos + 1;
  }
  const notePos = new Map();
  const cardMap = new Map(); // pkg cid → our cid (for revlog)
  const cardsOut = [];
  for (const c of pkg.cards) {
    const nm = noteMap.get(c.nid);
    if (!nm) continue;
    const converted = convertCard(c, dayShift, posMap);
    if (!withScheduling) {
      if (!notePos.has(c.nid)) notePos.set(c.nid, col.col.nextPos++);
      Object.assign(converted, { type: 0, queue: 0, due: notePos.get(c.nid), ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, flags: 0, stability: 0, difficulty: 0, lastReview: 0 });
    }
    if (nm.existing) {
      const ours = existingCards.get(`${nm.id}:${c.ord}`);
      if (ours) {
        cardMap.set(c.id, ours.id);
        if (withScheduling && updateScheduling && c.mod > (ours.mod || 0) && !ours.odid) {
          const upd = { ...ours };
          for (const k of SCHED_FIELDS) upd[k] = converted[k];
          cardsOut.push(upd);
          result.cardsUpdated++;
        }
        continue;
      }
    }
    const id = existingCardIds.has(c.id) ? newId(now) : c.id;
    existingCardIds.add(id);
    bumpIdFloor(id);
    cardsOut.push({ ...converted, id, nid: nm.id, did: targetDeck(c.did) });
    cardMap.set(c.id, id);
    result.cardsAdded++;
  }

  // ---- review history ----
  const revOut = [];
  if (withScheduling) {
    const have = new Set((await col.allRevlog()).map((r) => r.id));
    for (const r of pkg.revlog) {
      const cid = cardMap.get(r.cid);
      if (!cid || have.has(r.id)) continue;
      revOut.push({ ...r, cid });
      result.revlogAdded++;
    }
  }

  onProgress?.('Saving…');
  await col.writeNotesAndCards({ notes: notesOut, cards: cardsOut, revlog: revOut });

  // ---- media ----
  const wanted = new Set(pkg.mediaNames);
  const media = await importMedia(col, pkg, wanted, onProgress, { renames });
  result.mediaAdded = media.added;
  col.emit('all');
  return result;
}

/** Card from the package, with review days moved onto this collection's day numbering. */
function convertCard(c, dayShift, posMap) {
  const out = { ...c };
  const dayBased = (c.queue === 2 || c.queue === 3) || (c.queue < 0 && (c.type === 2 || (c.type === 3 && c.due < 1_000_000_000) || (c.type === 1 && c.due < 1_000_000_000)));
  if (c.type === 0) out.due = posMap.get(c.id) ?? c.due;
  else if (dayBased) out.due = c.due + dayShift;
  return out;
}

async function importMedia(col, pkg, names, onProgress, { renames = new Map(), overwrite = false } = {}) {
  let added = 0, i = 0;
  for (const name of names) {
    i++;
    if (i % 20 === 0) onProgress?.(`Media ${i} of ${names.size}…`);
    const target = renames.get(name) || name;
    if (!overwrite && !renames.has(name) && (await col.getMedia(target))) continue;
    const blob = await pkg.getMedia(name);
    if (!blob) continue;
    await col.putMedia(target, blob);
    added++;
  }
  return { added };
}
