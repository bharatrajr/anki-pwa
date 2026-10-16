// The collection: everything the app stores, on top of IndexedDB.
// Mirrors Anki's concepts (notes, note types, cards, decks, deck presets, revlog, media)
// so that .apkg import/export is a field-by-field mapping.

import { openDB, reqP, txDone, iterate } from './idb.js';
import { DB_NAME, MIGRATIONS, STORES } from './schema.js';
import { stockNotetypes, fieldMap, KIND_CLOZE } from '../model/notetypes.js';
import { cardOrdsForNote, fieldChecksum, sortFieldText } from '../model/cards.js';
import { guid64, newId, bumpIdFloor } from '../util/hash.js';
import { daysElapsed, newCollectionCrt, nextDayStartMs, localDayIndex } from '../util/time.js';
import { DEFAULT_PRESET, withDefaults, newCard } from '../sched/scheduler.js';

export const DEFAULT_DECK_ID = 1;
export const DEFAULT_PRESET_ID = 1;

const DEFAULT_SETTINGS = {
  theme: 'auto', // 'auto' | 'light' | 'dark'
  fontScale: 1,
  rolloverHour: 4,
  learnAheadMins: 20,
  globalLimits: { enabled: false, newPerDay: 20, revPerDay: 200 },
  newReviewMix: 'mix', // 'mix' | 'after' | 'before'
  showIntervals: true,
  showRemaining: true,
  backupReminderDays: 7,
  tts: { enabled: false, voiceURI: '', rate: 1, autoRevealSecs: 0, readAnswer: true },
  voice: { enabled: false, lang: 'en-US' },
  keepAwake: true, // while reading aloud / listening
};

export class Collection {
  constructor(db) {
    this.db = db;
    this.notetypes = new Map();
    this.decks = new Map();
    this.presets = new Map();
    this.col = null; // {crt, nextPos, ...}
    this.settings = { ...DEFAULT_SETTINGS };
    this.listeners = new Set();
  }

  static async open(idbFactory = globalThis.indexedDB, name = DB_NAME) {
    const db = await openDB(name, MIGRATIONS, idbFactory);
    const c = new Collection(db);
    await c.load();
    return c;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) try { fn(what); } catch (e) { console.error(e); } }

  // ---------- low-level ----------
  tx(stores, mode = 'readonly') { return this.db.transaction(stores, mode); }
  async get(store, key) { return reqP(this.tx(store).objectStore(store).get(key)); }
  async getAll(store, query, index) {
    const os = this.tx(store).objectStore(store);
    return reqP((index ? os.index(index) : os).getAll(query));
  }
  async put(store, value) {
    const t = this.tx(store, 'readwrite');
    t.objectStore(store).put(value);
    await txDone(t);
  }
  async putMany(store, values) {
    if (!values.length) return;
    const t = this.tx(store, 'readwrite');
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    await txDone(t);
  }
  async count(store, query, index) {
    const os = this.tx(store).objectStore(store);
    return reqP((index ? os.index(index) : os).count(query));
  }

  // ---------- load / init ----------
  async load() {
    const meta = await this.getAll('meta');
    const m = Object.fromEntries(meta.map((r) => [r.key, r.value]));
    if (!m.col) {
      await this.initEmpty();
      return this.load();
    }
    this.col = m.col;
    this.settings = deepMerge(DEFAULT_SETTINGS, m.settings || {});
    this.dayCounts = m.dayCounts || { day: -1, decks: {} };
    for (let nt of await this.getAll('notetypes')) {
      if (typeof nt.id === 'string') nt = await this.fixStringNotetypeId(nt);
      this.notetypes.set(nt.id, nt); bumpIdFloor(nt.id);
    }
    for (const d of await this.getAll('decks')) { this.decks.set(d.id, d); }
    for (const p of await this.getAll('presets')) { this.presets.set(p.id, withDefaults(p)); }
    await this.rolloverIfNeeded();
  }

  /** v0.2.0 could store a note type under a string id (from genanki decks); give it a number id. */
  async fixStringNotetypeId(nt) {
    const fixed = { ...nt, id: Number(nt.id) || newId() };
    const notes = await this.getAll('notes', IDBKeyRange.only(nt.id), 'ntid');
    const t = this.tx(['notetypes', 'notes'], 'readwrite');
    t.objectStore('notetypes').delete(nt.id);
    t.objectStore('notetypes').put(fixed);
    for (const n of notes) t.objectStore('notes').put({ ...n, ntid: fixed.id });
    await txDone(t);
    return fixed;
  }

  async initEmpty() {
    const now = Date.now();
    const t = this.tx(['meta', 'notetypes', 'decks', 'presets'], 'readwrite');
    t.objectStore('meta').put({ key: 'col', value: { crt: newCollectionCrt(now, 4), nextPos: 1, created: now, mod: now, schemaVersion: 1 } });
    t.objectStore('meta').put({ key: 'settings', value: DEFAULT_SETTINGS });
    for (const nt of stockNotetypes()) t.objectStore('notetypes').put(nt);
    t.objectStore('decks').put(makeDeck(DEFAULT_DECK_ID, 'Default'));
    t.objectStore('presets').put({ ...DEFAULT_PRESET, buryNew: true, buryRev: true, buryInterday: true });
    await txDone(t);
  }

  async saveMeta(key, value) { await this.put('meta', { key, value }); }
  async saveCol() { this.col.mod = Date.now(); await this.saveMeta('col', this.col); }
  async saveSettings() { await this.saveMeta('settings', this.settings); this.emit('settings'); }

  // ---------- timing ----------
  timing(now = Date.now()) {
    const roll = this.settings.rolloverHour;
    const crt = this.col.crt;
    return {
      now,
      today: daysElapsed(now, crt, roll),
      nextDayStart: nextDayStartMs(now, roll),
      dayOf: (ms) => localDayIndex(ms, roll) - localDayIndex(crt * 1000, roll),
      crt,
    };
  }

  /** At a new day: reset daily counts and unbury buried cards (like Anki). */
  async rolloverIfNeeded() {
    const { today } = this.timing();
    if (this.dayCounts.day === today) return false;
    this.dayCounts = { day: today, decks: {}, extra: {} };
    await this.saveMeta('dayCounts', this.dayCounts);
    await this.unburyAll();
    return true;
  }

  async unburyAll() {
    const t = this.tx('cards', 'readwrite');
    const idx = t.objectStore('cards').index('queue');
    for (const q of [-2, -3]) {
      await iterate(idx, IDBKeyRange.only(q), 'next', (card, cur) => {
        card.queue = restoreQueue(card);
        cur.update(card);
      });
    }
    await txDone(t);
  }

  // ---------- decks & presets ----------
  deckByName(name) {
    const lower = name.toLowerCase();
    for (const d of this.decks.values()) if (d.name.toLowerCase() === lower) return d;
    return null;
  }

  /** Create a deck (and any missing parents); returns the deck. */
  async addDeck(name, presetId = DEFAULT_PRESET_ID) {
    name = normaliseDeckName(name);
    const existing = this.deckByName(name);
    if (existing) return existing;
    const parts = name.split('::');
    let deck;
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('::');
      deck = this.deckByName(sub);
      if (!deck) {
        deck = makeDeck(newId(), sub, presetId);
        this.decks.set(deck.id, deck);
        await this.put('decks', deck);
      }
    }
    this.emit('decks');
    return deck;
  }

  async renameDeck(id, newName) {
    newName = normaliseDeckName(newName);
    const deck = this.decks.get(id);
    if (!deck) return;
    const other = this.deckByName(newName);
    if (other && other.id !== id) throw new Error('A deck with that name already exists.');
    const old = deck.name;
    const changed = [];
    for (const d of this.decks.values()) {
      if (d.id === id) { d.name = newName; changed.push(d); }
      else if (d.name.startsWith(old + '::')) { d.name = newName + d.name.slice(old.length); changed.push(d); }
    }
    // Make sure new parents exist.
    const parent = newName.split('::').slice(0, -1).join('::');
    if (parent) await this.addDeck(parent);
    for (const d of changed) d.mod = Date.now();
    await this.putMany('decks', changed);
    this.emit('decks');
  }

  /** Delete a deck, its subdecks and all their cards (and notes left without cards). */
  async deleteDeck(id) {
    const deck = this.decks.get(id);
    if (!deck) return;
    const ids = this.deckSubtreeIds(id);
    const cardIds = [];
    const nids = new Set();
    // Cards in filtered decks belong to their home decks: send them back, don't delete them.
    for (const did of ids) if (this.decks.get(did)?.dyn) await this.returnCardsHome(did);
    for (const did of ids) {
      if (this.decks.get(did)?.dyn) continue;
      const cards = await this.getAll('cards', IDBKeyRange.bound([did, -Infinity, -Infinity], [did, Infinity, Infinity]), 'did_queue_due');
      for (const c of cards) { cardIds.push(c.id); nids.add(c.nid); }
    }
    await this.deleteCards(cardIds);
    await this.deleteOrphanNotes([...nids]);
    const t = this.tx('decks', 'readwrite');
    for (const did of ids) if (did !== DEFAULT_DECK_ID) { t.objectStore('decks').delete(did); this.decks.delete(did); }
    await txDone(t);
    this.emit('decks');
  }

  deckSubtreeIds(id) {
    const deck = this.decks.get(id);
    if (!deck) return [];
    const prefix = deck.name + '::';
    const out = [id];
    for (const d of this.decks.values()) if (d.name.startsWith(prefix)) out.push(d.id);
    return out;
  }

  parentDeckIds(id) {
    const deck = this.decks.get(id);
    if (!deck) return [];
    const parts = deck.name.split('::');
    const out = [];
    for (let i = parts.length - 1; i >= 1; i--) {
      const p = this.deckByName(parts.slice(0, i).join('::'));
      if (p) out.push(p.id);
    }
    return out;
  }

  /** Move every card of a filtered deck back to its home deck and original due. */
  async returnCardsHome(did) {
    const cards = await this.getAll('cards', IDBKeyRange.bound([did, -Infinity, -Infinity], [did, Infinity, Infinity]), 'did_queue_due');
    const now = Date.now();
    for (const c of cards) Object.assign(c, homeCard(c), { mod: now });
    await this.putMany('cards', cards);
    this.emit('cards');
    return cards.length;
  }

  presetFor(did) {
    const deck = this.decks.get(did);
    return this.presets.get(deck?.presetId) || this.presets.get(DEFAULT_PRESET_ID) || withDefaults(DEFAULT_PRESET);
  }

  async savePreset(preset) {
    const p = withDefaults(preset);
    this.presets.set(p.id, p);
    await this.put('presets', p);
    this.emit('presets');
    return p;
  }

  async addPreset(name, base) {
    const p = withDefaults({ ...(base || DEFAULT_PRESET), id: newId(), name });
    return this.savePreset(p);
  }

  async deletePreset(id) {
    if (id === DEFAULT_PRESET_ID) return;
    const changed = [];
    for (const d of this.decks.values()) if (d.presetId === id) { d.presetId = DEFAULT_PRESET_ID; changed.push(d); }
    await this.putMany('decks', changed);
    const t = this.tx('presets', 'readwrite');
    t.objectStore('presets').delete(id);
    await txDone(t);
    this.presets.delete(id);
    this.emit('presets');
  }

  async saveDeck(deck) {
    deck.mod = Date.now();
    this.decks.set(deck.id, deck);
    await this.put('decks', deck);
    this.emit('decks');
  }

  // ---------- notes & cards ----------
  notetypeByName(name) {
    for (const nt of this.notetypes.values()) if (nt.name === name) return nt;
    return null;
  }

  async saveNotetype(nt) {
    nt.mod = Date.now();
    this.notetypes.set(nt.id, nt);
    await this.put('notetypes', nt);
  }

  /** Build (but do not store) a note and its cards; uses the next new-card position. */
  buildNote({ ntid, fields, tags = [], did = DEFAULT_DECK_ID, guid }, now = Date.now()) {
    const nt = this.notetypes.get(ntid);
    if (!nt) throw new Error('Unknown note type');
    const note = {
      id: newId(now), guid: guid || guid64(), ntid, mod: now,
      fields: nt.fields.map((_, i) => fields[i] ?? ''),
      tags: normaliseTags(tags), flags: 0, data: '',
    };
    note.csum = fieldChecksum(note.fields[0] || '');
    note.sfld = sortFieldText(nt, note);
    const ords = cardOrdsForNote(nt, note);
    if (!ords.length) throw new Error(nt.kind === KIND_CLOZE ? 'Add at least one cloze, e.g. {{c1::answer}}.' : 'The front of this card would be empty.');
    const deckOk = (id) => id && this.decks.has(id) && !this.decks.get(id).dyn;
    const cards = ords.map((ord) => newCard({ id: newId(now), nid: note.id, did: deckOk(templateDeck(nt, ord)) ? templateDeck(nt, ord) : did, ord, due: this.col.nextPos, now }));
    this.col.nextPos += 1;
    return { note, cards };
  }

  /** Create a note and its cards. Returns {note, cards}. */
  async addNote(item) {
    const now = Date.now();
    const { note, cards } = this.buildNote(item, now);
    const t = this.tx(['notes', 'cards', 'meta'], 'readwrite');
    t.objectStore('notes').add(note);
    for (const c of cards) t.objectStore('cards').add(c);
    this.col.mod = now;
    t.objectStore('meta').put({ key: 'col', value: this.col });
    await txDone(t);
    this.emit('notes');
    return { note, cards };
  }

  /** Write already-built notes/cards (and optional revlog) in chunked transactions. */
  async writeNotesAndCards({ notes = [], cards = [], revlog = [] }, chunk = 2000) {
    const parts = [['notes', notes], ['cards', cards], ['revlog', revlog]];
    for (const [store, list] of parts) {
      for (let i = 0; i < list.length; i += chunk) {
        const t = this.tx(store, 'readwrite');
        const os = t.objectStore(store);
        for (const v of list.slice(i, i + chunk)) os.put(v);
        await txDone(t);
      }
    }
    await this.saveCol();
    this.emit('notes');
  }

  async getNoteByGuid(guid) { return reqP(this.tx('notes').objectStore('notes').index('guid').get(guid)); }

  /** Save edited fields/tags; adds cards for templates/clozes that became non-empty. */
  async updateNote(note, { did } = {}) {
    const nt = this.notetypes.get(note.ntid);
    const now = Date.now();
    note.mod = now;
    note.tags = normaliseTags(note.tags);
    note.csum = fieldChecksum(note.fields[0] || '');
    note.sfld = sortFieldText(nt, note);
    const existing = await this.getAll('cards', IDBKeyRange.only(note.id), 'nid');
    const have = new Set(existing.map((c) => c.ord));
    const want = cardOrdsForNote(nt, note);
    const deckId = did || existing[0]?.did || DEFAULT_DECK_ID;
    const added = want.filter((o) => !have.has(o)).map((ord) => newCard({ id: newId(now), nid: note.id, did: deckId, ord, due: this.col.nextPos, now }));
    if (added.length) this.col.nextPos += 1;
    const t = this.tx(['notes', 'cards', 'meta'], 'readwrite');
    t.objectStore('notes').put(note);
    for (const c of added) t.objectStore('cards').add(c);
    t.objectStore('meta').put({ key: 'col', value: this.col });
    await txDone(t);
    this.emit('notes');
    return { note, added };
  }

  async getNote(id) { return this.get('notes', id); }
  async getCard(id) { return this.get('cards', id); }
  async cardsOfNote(nid) { return this.getAll('cards', IDBKeyRange.only(nid), 'nid'); }

  async putCards(cards) {
    const now = Date.now();
    for (const c of cards) c.mod = now;
    await this.putMany('cards', cards);
  }

  async deleteCards(ids) {
    if (!ids.length) return;
    const t = this.tx(['cards', 'revlog'], 'readwrite');
    const cs = t.objectStore('cards');
    const rl = t.objectStore('revlog').index('cid');
    for (const id of ids) {
      cs.delete(id);
      iterate(rl, IDBKeyRange.only(id), 'next', (_, cur) => { cur.delete(); });
    }
    await txDone(t);
  }

  async deleteNotes(nids) {
    const cardIds = [];
    for (const nid of nids) for (const c of await this.cardsOfNote(nid)) cardIds.push(c.id);
    await this.deleteCards(cardIds);
    const t = this.tx('notes', 'readwrite');
    for (const nid of nids) t.objectStore('notes').delete(nid);
    await txDone(t);
    this.emit('notes');
  }

  async deleteOrphanNotes(nids) {
    const orphans = [];
    for (const nid of nids) if ((await this.count('cards', IDBKeyRange.only(nid), 'nid')) === 0) orphans.push(nid);
    if (!orphans.length) return;
    const t = this.tx('notes', 'readwrite');
    for (const nid of orphans) t.objectStore('notes').delete(nid);
    await txDone(t);
  }

  // ---------- review log ----------
  async addRevlog(entry) {
    const rec = { id: newId(), usn: -1, time: 0, ...entry };
    await this.put('revlog', rec);
    return rec;
  }
  async revlogForCard(cid) { return this.getAll('revlog', IDBKeyRange.only(cid), 'cid'); }

  // ---------- media ----------
  async getMedia(name) { return this.get('media', name); }
  async putMedia(name, blob) {
    const rec = { name, blob, mime: blob.type || guessMime(name), size: blob.size };
    await this.put('media', rec);
    return rec;
  }
  /** Store a file under a unique name (adds -1, -2 … if a different file has that name). */
  async addMediaFile(file) {
    let name = sanitizeFilename(file.name || `pasted-${Date.now()}.png`);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const existing = await this.getMedia(name);
      if (!existing || existing.size === file.size) break;
      name = `${stem}-${i}${ext}`;
    }
    await this.putMedia(name, file);
    return name;
  }

  // ---------- daily counts ----------
  async bumpDayCount(did, kind, delta = 1) {
    await this.rolloverIfNeeded();
    const d = (this.dayCounts.decks[did] ||= { n: 0, r: 0 });
    d[kind] = Math.max(0, d[kind] + delta);
    await this.saveMeta('dayCounts', this.dayCounts);
  }
  async addExtraToday(did, kind, n) {
    await this.rolloverIfNeeded();
    const e = ((this.dayCounts.extra ||= {})[did] ||= { n: 0, r: 0 });
    e[kind] += n;
    await this.saveMeta('dayCounts', this.dayCounts);
  }
  doneToday(did, kind) {
    let total = 0;
    for (const id of this.deckSubtreeIds(did)) total += this.dayCounts.decks[id]?.[kind] || 0;
    return total;
  }
  totalDoneToday(kind) {
    return Object.values(this.dayCounts.decks).reduce((a, d) => a + (d[kind] || 0), 0);
  }
  /** Remaining new/review allowance for a deck today (its own preset, plus extras). */
  remainingToday(did, kind) {
    if (this.decks.get(did)?.dyn) return Infinity; // filtered decks ignore daily limits, like Anki
    const p = this.presetFor(did);
    const limit = kind === 'n' ? p.newPerDay : p.revPerDay;
    const extra = this.dayCounts.extra?.[did]?.[kind] || 0;
    return Math.max(0, limit + extra - this.doneToday(did, kind));
  }
  globalRemaining(kind) {
    const g = this.settings.globalLimits;
    if (!g?.enabled) return Infinity;
    const limit = kind === 'n' ? g.newPerDay : g.revPerDay;
    return Math.max(0, limit - this.totalDoneToday(kind));
  }

  // ---------- statistics helpers ----------
  async allCards() { return this.getAll('cards'); }
  async allNotes() { return this.getAll('notes'); }
  async allRevlog() { return this.getAll('revlog'); }
  async noteCount() { return this.count('notes'); }
  async cardCount() { return this.count('cards'); }

  /** Replace everything (used by full backup restore / colpkg replace). */
  async replaceAll(data) {
    const t = this.tx(STORES, 'readwrite');
    for (const s of STORES) t.objectStore(s).clear();
    for (const s of STORES) for (const v of data[s] || []) t.objectStore(s).put(v);
    await txDone(t);
    this.notetypes.clear(); this.decks.clear(); this.presets.clear();
    await this.load();
    this.emit('all');
  }

  async markBackedUp() { this.col.lastBackup = Date.now(); await this.saveCol(); }
}

// ---------- helpers ----------
export function makeDeck(id, name, presetId = DEFAULT_PRESET_ID) {
  return { id, name, presetId, desc: '', collapsed: false, mod: Date.now(), dyn: 0 };
}

export function normaliseDeckName(name) {
  const parts = String(name).split('::').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join('::') : 'Default';
}

export function normaliseTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/\s+/);
  const seen = new Map();
  for (const t of list) {
    const tag = t.trim().replace(/\s+/g, '_');
    if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  return [...seen.values()];
}

/** Queue a buried/suspended card should return to, from its type and due value. */
export function restoreQueue(card) {
  switch (card.type) {
    case 0: return 0;
    case 2: return 2;
    case 1: case 3: return card.due > 1_000_000_000 ? 1 : 3;
    default: return 0;
  }
}

/**
 * A card as it is in its home deck: for a card in a filtered deck, the original deck and
 * due (learning cards keep their current due time). Returns a new object.
 */
export function homeCard(card) {
  if (!card.odid) return { ...card };
  const c = { ...card, did: card.odid, odid: 0, odue: 0 };
  if (card.queue !== 1 && card.odue) c.due = card.odue;
  return c;
}

function templateDeck(nt, ord) {
  return nt.templates.find((t) => t.ord === ord)?.did || null;
}

export function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
}

export function guessMime(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', mp4: 'video/mp4',
  }[ext] || 'application/octet-stream';
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

export { fieldMap };
