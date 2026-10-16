// Importing real Anki packages (made by the official Anki library, see tests/anki/make_fixtures.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCol, fixture, expected } from './helpers.mjs';
import { readAnkiPackage } from '../js/io/anki-read.js';
import { mergePackage, replaceWithPackage, packageSummary } from '../js/io/anki-import.js';
import { deckCounts, nextCard, answerCard } from '../js/sched/queue.js';

for (const file of ['modern.apkg', 'legacy.apkg', 'modern.colpkg', 'legacy.colpkg']) {
  test(`read ${file}`, async () => {
    const pkg = await readAnkiPackage(fixture(file), { filename: file });
    assert.equal(pkg.notes.length, expected.notes);
    assert.equal(pkg.cards.length, expected.cards);
    assert.equal(pkg.revlog.length, expected.revlog);
    assert.deepEqual(pkg.mediaNames.sort(), expected.media);
    for (const d of ['Telugu', 'Telugu::Grammar', 'Telugu::Words']) assert.ok(pkg.decks.some((x) => x.name === d), d);
    const preset = pkg.presets.find((p) => p.name === expected.preset.name);
    assert.ok(preset, 'custom preset');
    for (const k of ['newPerDay', 'revPerDay', 'learnSteps', 'relearnSteps', 'leechThreshold', 'retention']) assert.deepEqual(preset[k], expected.preset[k], k);
    assert.equal(pkg.decks.find((d) => d.name === 'Telugu::Words').presetId, preset.id);
    const cloze = pkg.notetypes.find((n) => n.name === 'Cloze');
    assert.equal(cloze.kind, 1);
    assert.match(cloze.templates[0].qfmt, /\{\{cloze:Text\}\}/);
    const png = await pkg.getMedia('dot.png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const reviewed = pkg.cards.filter((c) => c.type === 2);
    assert.deepEqual(reviewed.map((c) => c.id).sort(), expected.reviewCards.sort());
    assert.ok(reviewed.every((c) => c.stability > 0 && c.difficulty > 0 && c.lastReview > 0), 'FSRS memory state');
    assert.equal(pkg.cards.find((c) => c.id === expected.suspended).queue, -1);
    assert.equal(pkg.cards.find((c) => c.id === expected.flagged).flags, 3);
    assert.equal(pkg.notes.find((n) => n.fields[0] === 'water').guid, expected.guids.water);
    assert.ok(packageSummary(pkg).decks.includes('Telugu::Words'));
  });
}

test('merge an .apkg, then merge it again (no duplicates)', async () => {
  const col = await freshCol();
  const pkg = await readAnkiPackage(fixture('modern.apkg'), { filename: 'modern.apkg' });
  const r = await mergePackage(col, pkg);
  assert.equal(r.notesAdded, expected.notes);
  assert.equal(r.cardsAdded, expected.cards);
  assert.equal(r.revlogAdded, expected.revlog);
  assert.equal(r.mediaAdded, 2);
  assert.equal(await col.noteCount(), expected.notes);
  const words = col.deckByName('Telugu::Words');
  assert.ok(words);
  assert.equal(col.presetFor(words.id).name, 'Telugu preset');
  // Reviewed cards are due on the same calendar day as in Anki.
  const card = await col.getCard(expected.reviewCards[0]);
  const ankiDue = pkg.cards.find((c) => c.id === card.id).due;
  const ms = (crt, day) => crt * 1000 + day * 86400000;
  assert.ok(Math.abs(ms(col.col.crt, card.due) - ms(pkg.crt, ankiDue)) < 2 * 86400000);
  // New cards are studyable.
  const c = await deckCounts(col, col.deckByName('Telugu::Grammar').id);
  assert.ok(c.n > 0);
  const next = await nextCard(col, col.deckByName('Telugu').id);
  assert.ok(next);
  await answerCard(col, next.card, 3);

  const again = await mergePackage(col, await readAnkiPackage(fixture('modern.apkg'), { filename: 'modern.apkg' }));
  assert.equal(again.notesAdded, 0);
  assert.equal(again.cardsAdded, 0);
  assert.equal(again.revlogAdded, 0);
  assert.equal(await col.noteCount(), expected.notes);
  // The card we just answered is newer here: its progress is kept.
  assert.ok((await col.getCard(next.card.id)).reps >= 1);
});

test('genanki deck (note type id stored as a string) is studyable after import', async () => {
  for (const mode of ['merge', 'replace']) {
    const col = await freshCol();
    const pkg = await readAnkiPackage(fixture('genanki.apkg'), { filename: 'genanki.apkg' });
    const r = mode === 'merge' ? await mergePackage(col, pkg) : await replaceWithPackage(col, pkg);
    assert.equal(r.notesAdded, 5, mode);
    assert.equal(r.notesMissingType, 0, mode);
    const deck = col.deckByName('Country Capitals');
    assert.equal((await deckCounts(col, deck.id)).n, 5, mode);
    const next = await nextCard(col, deck.id);
    assert.ok(next, mode);
    assert.ok(col.notetypes.get((await col.getNote(next.card.nid)).ntid), `${mode}: note type found`);
  }
});

test('a note type saved under a string id by v0.2.0 is repaired on open', async () => {
  const col = await freshCol();
  const basic = col.notetypeByName('Basic');
  const bad = { ...basic, id: '1607392319', name: 'Simple Model' };
  await col.put('notetypes', bad);
  const { note } = await col.addNote({ ntid: basic.id, fields: ['x', 'y'] });
  await col.put('notes', { ...note, ntid: '1607392319' });
  col.notetypes.clear(); col.decks.clear(); col.presets.clear();
  await col.load();
  assert.ok(col.notetypes.get(1607392319));
  assert.ok(![...col.notetypes.keys()].some((k) => typeof k === 'string'));
  assert.equal((await col.getNote(note.id)).ntid, 1607392319);
});

test('merge without scheduling imports everything as new', async () => {
  const col = await freshCol();
  const pkg = await readAnkiPackage(fixture('legacy.apkg'), { filename: 'legacy.apkg' });
  const r = await mergePackage(col, pkg, { withScheduling: false });
  assert.equal(r.revlogAdded, 0);
  const cards = await col.allCards();
  assert.ok(cards.every((c) => c.type === 0 && c.queue === 0));
});

test('replace with a .colpkg keeps ids, days and media', async () => {
  const col = await freshCol();
  await col.addNote({ ntid: col.notetypeByName('Basic').id, fields: ['old', 'note'] });
  const pkg = await readAnkiPackage(fixture('legacy.colpkg'), { filename: 'legacy.colpkg' });
  const r = await replaceWithPackage(col, pkg);
  assert.equal(r.notesAdded, expected.notes);
  assert.equal(await col.noteCount(), expected.notes);
  assert.equal(col.col.crt, expected.crt);
  assert.ok(await col.getMedia('hello.mp3'));
  assert.equal((await col.getCard(expected.suspended)).queue, -1);
  assert.ok(col.deckByName('Telugu::Grammar'));
  assert.ok(col.decks.get(1));
});
