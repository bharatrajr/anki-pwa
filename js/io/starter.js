// Optional starter decks bundled with the app. Offered once on first run (empty collection);
// each can also be added later from the deck list or the import screen, and deleted like any deck.

import { readAnkiPackage } from './anki-read.js';
import { mergePackage } from './anki-import.js';

export const STARTERS = [
  {
    id: 'cgl',
    url: './decks/cgl-mains.apkg',
    name: 'SSC CGL GS Audio',
    blurb: '1,890 SSC CGL general studies cards: History, Polity, Geography, Economy, Science, Static GK and Computer.',
  },
  {
    id: 'spoken-english',
    url: './decks/spoken-english.apkg',
    name: 'Spoken English',
    blurb: '414 Telugu → English speaking cards in three levels: daily sentences, common mistakes, idioms and short speeches.',
  },
];

/** Whether the first-run question was already asked (answered either way). */
export function starterOffered(col) { return !!col.col.starterOffered; }

export async function markStarterOffered(col) {
  if (col.col.starterOffered) return;
  col.col.starterOffered = true;
  await col.saveCol();
}

/** Download (or read from the offline cache) and merge one starter deck. Cards start as new. */
export async function addStarterDeck(col, starter, { onProgress } = {}) {
  onProgress?.(`Loading ${starter.name}…`);
  const res = await fetch(starter.url);
  if (!res.ok) throw new Error(`Could not load ${starter.name} (${res.status}).`);
  const pkg = await readAnkiPackage(await res.blob(), { filename: starter.url.split('/').pop() });
  const r = await mergePackage(col, pkg, { withScheduling: false, updateScheduling: false, updateNotes: 'never', onProgress });
  await markStarterOffered(col);
  return r;
}
