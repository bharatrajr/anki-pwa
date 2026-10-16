// Building study queues and answering cards on top of the collection.
// Ordering follows Anki's v3 defaults: intraday learning first (when due), then
// reviews and interday learning mixed with new cards, then learn-ahead.

import { nextStates, isLeech, RATING } from './scheduler.js';
import { iterate, txDone } from '../db/idb.js';
import { newId } from '../util/hash.js';

const Q = { SUSP: -1, SIB_BURIED: -2, USER_BURIED: -3, NEW: 0, LRN: 1, REV: 2, DAY_LRN: 3 };
export { Q };

const range = (did, queue, lo, hi) => IDBKeyRange.bound([did, queue, lo], [did, queue, hi]);

/** Due counts for one deck subtree, with daily limits applied: {n, l, r}. */
export async function deckCounts(col, did, timing = col.timing()) {
  const ids = col.deckSubtreeIds(did);
  const learnAheadSecs = Math.floor(timing.now / 1000) + col.settings.learnAheadMins * 60;
  let n = 0, l = 0, r = 0;
  for (const id of ids) {
    const nRem = Math.min(col.remainingToday(id, 'n'), col.globalRemaining('n'));
    const rRem = Math.min(col.remainingToday(id, 'r'), col.globalRemaining('r'));
    const newCount = await col.count('cards', range(id, Q.NEW, -Infinity, Infinity), 'did_queue_due');
    const revCount = await col.count('cards', range(id, Q.REV, -Infinity, timing.today), 'did_queue_due');
    const dayLrn = await col.count('cards', range(id, Q.DAY_LRN, -Infinity, timing.today), 'did_queue_due');
    l += await col.count('cards', range(id, Q.LRN, -Infinity, learnAheadSecs), 'did_queue_due');
    n += Math.min(newCount, nRem);
    r += Math.min(revCount + dayLrn, rRem);
  }
  // The selected deck's own limits cap the whole subtree, like Anki's parent limits.
  n = Math.min(n, col.remainingToday(did, 'n'), col.globalRemaining('n'));
  r = Math.min(r, col.remainingToday(did, 'r'), col.globalRemaining('r'));
  return { n, l, r };
}

/** Counts for every deck (for the deck list). Map did → {n,l,r}. */
export async function allDeckCounts(col) {
  const timing = col.timing();
  const out = new Map();
  for (const d of col.decks.values()) out.set(d.id, await deckCounts(col, d.id, timing));
  return out;
}

/**
 * Pick the next card to study in a deck subtree, or null.
 * opts.exclude: Set of card ids to skip (e.g. the card just answered while it is
 * still inside the learn-ahead window and other cards are waiting).
 */
export async function nextCard(col, did, opts = {}) {
  await col.rolloverIfNeeded();
  const timing = col.timing();
  const ids = col.deckSubtreeIds(did);
  const nowSec = Math.floor(timing.now / 1000);
  const exclude = opts.exclude || new Set();
  const pickOne = async (queue, lo, hi, filter) => {
    let best = null;
    for (const id of ids) {
      const cards = await col.getAll('cards', range(id, queue, lo, hi), 'did_queue_due');
      for (const c of cards) {
        if (exclude.has(c.id) || (filter && !filter(c))) continue;
        if (!best || c.due < best.due || (c.due === best.due && c.id < best.id)) best = c;
        break; // sorted by due within a deck
      }
    }
    return best;
  };

  // 1. Intraday learning that is due now.
  const lrn = await pickOne(Q.LRN, -Infinity, nowSec);
  if (lrn) return { card: lrn, kind: 'l' };

  const counts = await deckCounts(col, did, timing);
  const allowNew = (c) => col.remainingToday(c.did, 'n') > 0;
  const allowRev = (c) => col.remainingToday(c.did, 'r') > 0;

  // 2. Reviews / interday learning, mixed with new cards (new spread evenly).
  const reviewsLeft = counts.r;
  const newLeft = counts.n;
  const doneR = col.doneToday(did, 'r');
  const doneN = col.doneToday(did, 'n');
  let preferNew = false;
  if (newLeft > 0 && reviewsLeft > 0) {
    const mix = col.settings.newReviewMix;
    if (mix === 'before') preferNew = true;
    else if (mix === 'after') preferNew = false;
    else {
      // Show one new card after every `gap` reviews.
      const gap = Math.max(1, Math.floor((reviewsLeft + doneR) / Math.max(1, newLeft + doneN)));
      preferNew = (doneR + doneN) % (gap + 1) === gap;
    }
  } else if (newLeft > 0) preferNew = true;

  const getReview = async () => {
    if (reviewsLeft <= 0) return null;
    const dl = await pickOne(Q.DAY_LRN, -Infinity, timing.today, allowRev);
    if (dl) return { card: dl, kind: 'l' };
    const rv = await pickOne(Q.REV, -Infinity, timing.today, allowRev);
    return rv ? { card: rv, kind: 'r' } : null;
  };
  const getNew = async () => {
    if (newLeft <= 0) return null;
    const nc = await pickOne(Q.NEW, -Infinity, Infinity, allowNew);
    return nc ? { card: nc, kind: 'n' } : null;
  };
  const first = preferNew ? await getNew() : await getReview();
  if (first) return first;
  const second = preferNew ? await getReview() : await getNew();
  if (second) return second;

  // 3. Learn ahead: learning cards due within the learn-ahead window.
  const ahead = await pickOne(Q.LRN, -Infinity, nowSec + col.settings.learnAheadMins * 60);
  if (ahead) return { card: ahead, kind: 'l' };
  if (exclude.size) {
    // Only the excluded card is left: show it rather than end the session.
    const again = await pickOne(Q.LRN, -Infinity, nowSec + col.settings.learnAheadMins * 60, () => true);
    if (again) return { card: again, kind: 'l' };
  }
  return null;
}

/** Earliest upcoming intraday learning card time in a subtree (epoch s) or null. */
export async function nextLearningDue(col, did) {
  let min = null;
  for (const id of col.deckSubtreeIds(did)) {
    const cards = await col.getAll('cards', range(id, Q.LRN, -Infinity, Infinity), 'did_queue_due');
    if (cards.length && (min === null || cards[0].due < min)) min = cards[0].due;
  }
  return min;
}

export function schedContext(col, card, timing = col.timing()) {
  return { ...timing, preset: col.presetFor(card.odid || card.did) };
}

/** The four possible outcomes, for button labels. */
export function previewOutcomes(col, card) {
  return nextStates(card, schedContext(col, card));
}

/**
 * Answer a card. Returns an undo entry.
 * Writes the card, a revlog row, daily counts, sibling burying and leech handling.
 */
export async function answerCard(col, card, rating, { timeMs = 0 } = {}) {
  const ctx = schedContext(col, card);
  const outcome = nextStates(card, ctx)[rating - 1];
  const p = ctx.preset;
  const before = { ...card };
  const updated = { ...outcome.card, mod: Date.now() };
  const wasNew = card.type === 0;
  const kind = wasNew ? 'n' : card.type === 2 || card.queue === 3 ? 'r' : null;

  let note = null, noteBefore = null;
  if (outcome.leech) {
    note = await col.getNote(card.nid);
    noteBefore = { ...note, tags: [...note.tags] };
    if (!note.tags.some((t) => t.toLowerCase() === 'leech')) note.tags.push('leech');
    note.mod = Date.now();
    if (p.leechAction === 'suspend') updated.queue = Q.SUSP;
  }

  // Bury siblings (Anki: new siblings if buryNew, review siblings if buryRev,
  // interday learning siblings if buryInterday).
  const siblingsBefore = [];
  const siblingsAfter = [];
  if (p.buryNew || p.buryRev || p.buryInterday) {
    for (const s of await col.cardsOfNote(card.nid)) {
      if (s.id === card.id) continue;
      const bury =
        (p.buryNew && s.queue === Q.NEW) ||
        (p.buryRev && s.queue === Q.REV && s.due <= ctx.today) ||
        (p.buryInterday && s.queue === Q.DAY_LRN && s.due <= ctx.today);
      if (bury) {
        siblingsBefore.push({ ...s });
        siblingsAfter.push({ ...s, queue: Q.SIB_BURIED, mod: Date.now() });
      }
    }
  }

  const rev = { id: newId(), usn: -1, ...outcome.revlog, time: Math.min(Math.round(timeMs), 60000) };
  const dayBefore = JSON.parse(JSON.stringify(col.dayCounts));
  const t = col.tx(['cards', 'revlog', 'notes', 'meta'], 'readwrite');
  t.objectStore('cards').put(updated);
  for (const s of siblingsAfter) t.objectStore('cards').put(s);
  t.objectStore('revlog').put(rev);
  if (note) t.objectStore('notes').put(note);
  if (kind) {
    const d = (col.dayCounts.decks[card.did] ||= { n: 0, r: 0 });
    d[kind] += 1;
    t.objectStore('meta').put({ key: 'dayCounts', value: col.dayCounts });
  }
  await txDone(t);
  col.emit('review');
  return {
    kind: 'answer', cardBefore: before, cardAfter: updated, revlogId: rev.id, siblingsBefore, noteBefore,
    dayBefore, leech: outcome.leech, rating,
  };
}

/** Undo an entry produced by answerCard or a card action. */
export async function undo(col, entry) {
  const t = col.tx(['cards', 'revlog', 'notes', 'meta'], 'readwrite');
  if (entry.cardBefore) t.objectStore('cards').put(entry.cardBefore);
  for (const c of entry.cardsBefore || []) t.objectStore('cards').put(c);
  for (const s of entry.siblingsBefore || []) t.objectStore('cards').put(s);
  if (entry.revlogId) t.objectStore('revlog').delete(entry.revlogId);
  if (entry.noteBefore) t.objectStore('notes').put(entry.noteBefore);
  if (entry.dayBefore) {
    col.dayCounts = entry.dayBefore;
    t.objectStore('meta').put({ key: 'dayCounts', value: col.dayCounts });
  }
  await txDone(t);
  col.emit('review');
}

/** Multi-level undo stack (kept in memory for the session). */
export class UndoStack {
  constructor(limit = 50) { this.items = []; this.limit = limit; }
  push(e) { this.items.push(e); if (this.items.length > this.limit) this.items.shift(); }
  pop() { return this.items.pop(); }
  get size() { return this.items.length; }
  peekLabel() {
    const e = this.items[this.items.length - 1];
    return e ? e.label || 'Answer' : '';
  }
}

// ---------- card actions (each returns an undo entry) ----------

async function modifyCards(col, cards, fn, label) {
  const before = cards.map((c) => ({ ...c }));
  const now = Date.now();
  const after = cards.map((c) => ({ ...fn({ ...c }), mod: now }));
  await col.putMany('cards', after);
  col.emit('cards');
  return { kind: 'action', label, cardsBefore: before };
}

export function suspendCards(col, cards) {
  const allSusp = cards.every((c) => c.queue === Q.SUSP);
  return modifyCards(col, cards, (c) => {
    c.queue = allSusp ? restoreQueueOf(c) : Q.SUSP;
    return c;
  }, allSusp ? 'Unsuspend' : 'Suspend');
}

export function buryCards(col, cards) {
  return modifyCards(col, cards, (c) => { if (c.queue >= 0) c.queue = Q.USER_BURIED; return c; }, 'Bury');
}

export function flagCards(col, cards, flag) {
  return modifyCards(col, cards, (c) => { c.flags = (c.flags & ~7) | (flag & 7); return c; }, 'Flag');
}

/** Reset to new, at the end of the new queue (Anki "Forget"). */
export async function forgetCards(col, cards, { resetCounts = true } = {}) {
  const pos = col.col.nextPos;
  const entry = await modifyCards(col, cards, (c, i) => {
    Object.assign(c, { type: 0, queue: 0, due: pos, ivl: 0, left: 0, stability: 0, difficulty: 0, lastReview: 0, factor: 0 });
    if (resetCounts) { c.reps = 0; c.lapses = 0; }
    return c;
  }, 'Reset');
  col.col.nextPos += 1;
  await col.saveCol();
  return entry;
}

/** Set due date: days may be "0", "5", "3-7"; a trailing "!" also sets the interval. */
export async function setDueDate(col, cards, spec) {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*(!)?\s*$/.exec(spec || '');
  if (!m) throw new Error('Enter days like 0, 5, or 3-7 (add ! to also set the interval).');
  const lo = +m[1], hi = m[2] ? +m[2] : lo;
  const setIvl = !!m[3];
  const { today } = col.timing();
  return modifyCards(col, cards, (c) => {
    const days = lo + Math.floor(Math.random() * (Math.max(hi, lo) - lo + 1));
    if (c.type === 0 || c.type === 1 || c.type === 3) { c.type = 2; c.left = 0; if (!c.factor) c.factor = 2500; }
    if (setIvl || !c.ivl) c.ivl = Math.max(1, days);
    c.queue = Q.REV;
    c.due = today + days;
    return c;
  }, 'Set due date');
}

/** Reposition new cards starting at `start` (step `step`). */
export async function repositionNew(col, cards, start = 1, step = 1) {
  const newOnes = cards.filter((c) => c.type === 0).sort((a, b) => a.due - b.due);
  let pos = start;
  const entry = await modifyCards(col, newOnes, (c) => { c.due = pos; pos += step; return c; }, 'Reposition');
  if (pos > col.col.nextPos) { col.col.nextPos = pos; await col.saveCol(); }
  return entry;
}

export function restoreQueueOf(c) {
  if (c.type === 0) return Q.NEW;
  if (c.type === 2) return Q.REV;
  return c.due > 1_000_000_000 ? Q.LRN : Q.DAY_LRN;
}

export { RATING, isLeech, iterate };
