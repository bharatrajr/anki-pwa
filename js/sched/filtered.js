// Filtered decks (Anki's custom study and cram): cards matching a search are moved into a
// temporary deck and return home when answered (rescheduling on) or when the deck is
// emptied. With rescheduling off ("preview"/cram), answers don't change scheduling.

import { searchCards, cardRetrievability } from '../search/search.js';
import { makeDeck } from '../db/collection.js';
import { newId, seededRandom } from '../util/hash.js';

export const CUSTOM_STUDY_NAME = 'Custom Study Session';
const SORT_BASE = -100000;

export const ORDERS = {
  random: 'Random',
  due: 'Order due',
  added: 'Order added',
  retrievability: 'Lowest retrievability first',
  lapses: 'Most lapses',
  ivl: 'Shortest interval',
};

/** Create (or replace the search of) a filtered deck and fill it. Returns {deck, count}. */
export async function createFiltered(col, { name = CUSTOM_STUDY_NAME, search, limit = 100, order = 'random', resched = true }) {
  let deck = col.deckByName(name);
  if (deck && !deck.dyn) throw new Error(`A normal deck called “${name}” already exists.`);
  if (deck) await col.returnCardsHome(deck.id);
  else {
    deck = { ...makeDeck(newId(), name), dyn: 1 };
    // Parents of a filtered deck must be normal decks.
    const parent = name.split('::').slice(0, -1).join('::');
    if (parent) await col.addDeck(parent);
  }
  Object.assign(deck, { dyn: 1, terms: { search, limit, order }, resched });
  await col.saveDeck(deck);
  const count = await fillFiltered(col, deck);
  return { deck, count };
}

export async function rebuildFiltered(col, did) {
  const deck = col.decks.get(did);
  if (!deck?.dyn) return 0;
  await col.returnCardsHome(did);
  return fillFiltered(col, deck);
}

export async function emptyFiltered(col, did) {
  return col.returnCardsHome(did);
}

async function fillFiltered(col, deck) {
  const { search, limit, order } = deck.terms || {};
  const timing = col.timing();
  const found = (await searchCards(col, search || '', { timing }))
    .map((x) => x.card)
    .filter((c) => c.queue >= 0 && !c.odid && !col.decks.get(c.did)?.dyn);
  sortCards(found, order, timing, col);
  const picked = found.slice(0, Math.max(1, Math.min(limit || 100, 99999)));
  const now = Date.now();
  picked.forEach((c, i) => {
    c.odid = c.did;
    c.odue = c.due;
    c.did = deck.id;
    if (c.queue !== 1) c.due = SORT_BASE + i;
    c.mod = now;
  });
  await col.putMany('cards', picked);
  col.emit('cards');
  return picked.length;
}

function sortCards(cards, order, timing, col) {
  const key = {
    due: (c) => (c.type === 0 ? 1e9 + c.due : c.queue === 1 ? (c.due * 1000 - timing.now) / 86400000 : c.due - timing.today),
    added: (c) => c.nid * 10 + c.ord,
    retrievability: (c) => cardRetrievability(c, timing, col) ?? 2,
    lapses: (c) => -c.lapses,
    ivl: (c) => (c.type === 0 ? 1e9 : c.ivl),
  }[order];
  if (key) { cards.sort((a, b) => key(a) - key(b) || a.id - b.id); return; }
  const rand = seededRandom(Date.now() >>> 0);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}

/** Search for custom-study presets, limited to a deck. */
export function customStudySearch(deckName, kind, { days = 1, tags = '', state = 'due' } = {}) {
  const d = `deck:"${deckName.replace(/"/g, '\\"')}"`;
  const tagPart = tags.trim() ? `(${tags.trim().split(/\s+/).map((t) => `tag:"${t}"`).join(' or ')})` : '';
  switch (kind) {
    case 'forgotten': return `${d} rated:${days}:1`;
    case 'ahead': return `${d} is:review -is:learn prop:due<=${days} prop:due>0`;
    case 'preview': return `${d} is:new added:${days}`;
    case 'weak': return `${d} is:review prop:r<0.9`;
    case 'tags': {
      const st = { new: 'is:new', due: 'is:due', review: 'is:review', all: '' }[state] ?? '';
      return [d, st, tagPart].filter(Boolean).join(' ');
    }
    default: return d;
  }
}
