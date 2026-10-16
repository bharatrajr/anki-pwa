// Collection + queue + backup, on an in-memory IndexedDB (fake-indexeddb).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Collection } from '../js/db/collection.js';
import { nextCard, answerCard, undo, deckCounts, buryCards, suspendCards, forgetCards, setDueDate, Q } from '../js/sched/queue.js';
import { buildBackup, parseBackup } from '../js/io/backup.js';

let n = 0;
async function freshCol() { return Collection.open(new IDBFactory(), `t${n++}`); }

test('new collection has stock note types, Default deck and preset', async () => {
  const col = await freshCol();
  assert.deepEqual([...col.notetypes.values()].map((t) => t.name).sort(), ['Basic', 'Basic (and reversed card)', 'Basic (type in the answer)', 'Cloze']);
  assert.equal(col.decks.get(1).name, 'Default');
  assert.equal(col.presetFor(1).scheduler, 'fsrs');
});

test('nested decks are created with their parents', async () => {
  const col = await freshCol();
  const d = await col.addDeck('Telugu :: Grammar::Verbs');
  assert.equal(d.name, 'Telugu::Grammar::Verbs');
  assert.ok(col.deckByName('Telugu') && col.deckByName('Telugu::Grammar'));
  assert.equal(col.deckSubtreeIds(col.deckByName('Telugu').id).length, 3);
  await col.renameDeck(col.deckByName('Telugu').id, 'Lang::Telugu');
  assert.ok(col.deckByName('Lang::Telugu::Grammar::Verbs'));
});

test('add notes, study, daily limits, undo', async () => {
  const col = await freshCol();
  const deck = await col.addDeck('Test');
  const basic = col.notetypeByName('Basic (and reversed card)');
  const { cards } = await col.addNote({ ntid: basic.id, fields: ['dog', 'kukka'], did: deck.id });
  assert.equal(cards.length, 2);
  const cloze = col.notetypeByName('Cloze');
  await col.addNote({ ntid: cloze.id, fields: ['{{c1::Hyderabad}} is in {{c2::Telangana}}', ''], did: deck.id });
  let counts = await deckCounts(col, deck.id);
  assert.deepEqual(counts, { n: 4, l: 0, r: 0 });

  const first = await nextCard(col, deck.id);
  assert.equal(first.kind, 'n');
  const entry = await answerCard(col, first.card, 3);
  const after = await col.getCard(first.card.id);
  assert.equal(after.queue, Q.LRN);
  assert.equal((await col.revlogForCard(first.card.id)).length, 1);
  // Sibling buried (stock preset buries new siblings).
  const sib = (await col.cardsOfNote(first.card.nid)).find((c) => c.id !== first.card.id);
  assert.equal(sib.queue, Q.SIB_BURIED);
  counts = await deckCounts(col, deck.id);
  assert.equal(counts.n, 2);
  assert.equal(counts.l, 1, 'learning card due within learn-ahead window');

  await undo(col, entry);
  assert.equal((await col.getCard(first.card.id)).queue, Q.NEW);
  assert.equal((await col.getCard(sib.id)).queue, Q.NEW);
  assert.equal((await col.revlogForCard(first.card.id)).length, 0);
  assert.deepEqual(await deckCounts(col, deck.id), { n: 4, l: 0, r: 0 });

  // Daily new limit.
  const p = col.presetFor(deck.id);
  await col.savePreset({ ...p, newPerDay: 1 });
  assert.equal((await deckCounts(col, deck.id)).n, 1);
  const c1 = await nextCard(col, deck.id);
  await answerCard(col, c1.card, 4); // Easy → review tomorrow
  assert.equal((await deckCounts(col, deck.id)).n, 0);
  assert.equal(await nextCard(col, deck.id), null);
  await col.addExtraToday(deck.id, 'n', 2);
  assert.ok((await deckCounts(col, deck.id)).n > 0);
});

test('card actions: bury, suspend toggle, reset, set due date', async () => {
  const col = await freshCol();
  const nt = col.notetypeByName('Basic');
  const { cards: [card] } = await col.addNote({ ntid: nt.id, fields: ['a', 'b'] });
  await buryCards(col, [card]);
  assert.equal((await col.getCard(card.id)).queue, Q.USER_BURIED);
  await col.unburyAll();
  assert.equal((await col.getCard(card.id)).queue, Q.NEW);
  await suspendCards(col, [await col.getCard(card.id)]);
  assert.equal((await col.getCard(card.id)).queue, Q.SUSP);
  await suspendCards(col, [await col.getCard(card.id)]);
  assert.equal((await col.getCard(card.id)).queue, Q.NEW);
  await setDueDate(col, [await col.getCard(card.id)], '3');
  const due = await col.getCard(card.id);
  assert.equal(due.type, 2);
  assert.equal(due.due, col.timing().today + 3);
  await forgetCards(col, [due]);
  const reset = await col.getCard(card.id);
  assert.equal(reset.type, 0);
  assert.equal(reset.reps, 0);
});

test('editing a note adds cards for new clozes', async () => {
  const col = await freshCol();
  const nt = col.notetypeByName('Cloze');
  const { note } = await col.addNote({ ntid: nt.id, fields: ['{{c1::a}}', ''] });
  note.fields[0] = '{{c1::a}} {{c2::b}}';
  const { added } = await col.updateNote(note);
  assert.equal(added.length, 1);
  assert.equal(added[0].ord, 1);
});

test('backup round-trip is lossless (including media and revlog)', async () => {
  const col = await freshCol();
  const nt = col.notetypeByName('Basic');
  await col.addDeck('X::Y');
  const { cards: [card] } = await col.addNote({ ntid: nt.id, fields: ['<img src="pic.png">', 'b'], tags: ['t1'] });
  await col.putMedia('pic.png', new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' }));
  await answerCard(col, card, 3);
  const backup = await buildBackup(col);
  const json = JSON.stringify(backup);
  const parsed = parseBackup(json);
  const col2 = await freshCol();
  await col2.replaceAll(parsed.data);
  for (const store of ['notes', 'cards', 'revlog', 'decks', 'notetypes', 'presets']) {
    assert.deepEqual(await col2.getAll(store), await col.getAll(store), store);
  }
  const m = await col2.getMedia('pic.png');
  assert.deepEqual([...new Uint8Array(await m.blob.arrayBuffer())], [137, 80, 78, 71, 1, 2, 3]);
  assert.equal(col2.col.crt, col.col.crt);
  assert.throws(() => parseBackup('{"format":"other"}'), /not an AnkiPWA backup/);
});

test('50,000 cards: due counts stay fast via the [did,queue,due] index', async () => {
  const col = await freshCol();
  const deck = await col.addDeck('Big');
  const today = col.timing().today;
  const cards = [];
  for (let i = 0; i < 50000; i++) {
    const rev = i % 2 === 0;
    cards.push({ id: 1e12 + i, nid: 1e12 + i, did: deck.id, ord: 0, type: rev ? 2 : 0, queue: rev ? 2 : 0, due: rev ? today - (i % 30) + 15 : i, ivl: rev ? 10 : 0, factor: 2500, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, stability: 0, difficulty: 0, lastReview: 0, mod: 0 });
  }
  await col.putMany('cards', cards);
  const t0 = performance.now();
  const c = await deckCounts(col, deck.id);
  const next = await nextCard(col, deck.id);
  const ms = performance.now() - t0;
  assert.equal(c.n, 20);
  assert.equal(c.r, 200);
  assert.ok(next);
  assert.ok(ms < 1500, `took ${ms}ms`);
});

test('service worker precaches every app module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const file of walk(join(root, 'js'))) {
    const rel = './' + file.slice(root.length).replace(/\\/g, '/');
    assert.ok(sw.includes(`'${rel}'`), `sw.js SHELL is missing ${rel}`);
  }
});
