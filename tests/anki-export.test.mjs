// Exporting .apkg / .colpkg / .txt / .csv, checked by reading the files back.
// Set ANKI_OUT=<dir> to also write the files, then check them with real Anki:
//   ANKI_OUT=/tmp/out npm test && python tests/anki/check_export.py /tmp/out
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshCol, fixture, expected } from './helpers.mjs';
import { readAnkiPackage } from '../js/io/anki-read.js';
import { mergePackage } from '../js/io/anki-import.js';
import { exportPackage, exportNotesText, exportCsv } from '../js/io/anki-export.js';
import { parseAnkiText, parseDelimited, importRows, suggestMapping } from '../js/io/text-import.js';
import { nextCard, answerCard } from '../js/sched/queue.js';

const OUT = process.env.ANKI_OUT;
const save = async (name, blob) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), new Uint8Array(await blob.arrayBuffer()));
};

async function studiedCollection() {
  const col = await freshCol();
  await mergePackage(col, await readAnkiPackage(fixture('modern.apkg'), { filename: 'modern.apkg' }));
  const deck = await col.addDeck('Telugu::Phrases');
  await col.addNote({ ntid: col.notetypeByName('Basic').id, fields: ['thank you', 'dhanyavaadaalu'], did: deck.id, tags: ['pwa'] });
  await col.putMedia('pwa.png', new Blob([fixture('../fixtures/expected.json').slice(0, 10)], { type: 'image/png' }));
  await col.addNote({ ntid: col.notetypeByName('Cloze').id, fields: ['{{c1::Namaste}} <img src="pwa.png">', ''], did: deck.id });
  for (let i = 0; i < 3; i++) {
    const next = await nextCard(col, deck.id);
    if (next) await answerCard(col, next.card, 3);
  }
  return { col, deck };
}

test('apkg export with progress round-trips through the reader', async () => {
  const { col, deck } = await studiedCollection();
  const { blob, counts } = await exportPackage(col, { withScheduling: true, withMedia: true });
  await save('pwa-all.apkg', blob);
  assert.equal(counts.notes, expected.notes + 2);
  const pkg = await readAnkiPackage(blob, { filename: 'x.apkg' });
  assert.equal(pkg.notes.length, expected.notes + 2);
  assert.equal(pkg.revlog.length, (await col.allRevlog()).length);
  assert.ok(pkg.mediaNames.includes('pwa.png') && pkg.mediaNames.includes('dot.png'));
  const ours = await col.allCards();
  for (const c of pkg.cards) {
    const o = ours.find((x) => x.id === c.id);
    for (const k of ['type', 'queue', 'due', 'ivl', 'reps', 'lapses', 'flags']) assert.equal(c[k], o[k], `${k} of card ${c.id}`);
    if (o.stability) assert.ok(Math.abs(c.stability - o.stability) < 0.001);
  }
  assert.ok(pkg.decks.some((d) => d.name === 'Telugu::Phrases'));
  assert.equal(pkg.presets.find((p) => p.name === 'Telugu preset').newPerDay, 15);
  assert.ok(pkg.notes.find((n) => n.fields[0] === 'thank you').tags.includes('pwa'));
  void deck;
});

test('apkg export of one deck without progress', async () => {
  const { col, deck } = await studiedCollection();
  const { blob } = await exportPackage(col, { did: deck.id, withScheduling: false, withMedia: true });
  await save('pwa-phrases-noprogress.apkg', blob);
  const pkg = await readAnkiPackage(blob, { filename: 'x.apkg' });
  assert.equal(pkg.notes.length, 2);
  assert.equal(pkg.revlog.length, 0);
  assert.ok(pkg.cards.every((c) => c.type === 0 && c.queue === 0));
  assert.deepEqual(pkg.mediaNames, ['pwa.png']);
});

test('colpkg export contains the whole collection', async () => {
  const { col } = await studiedCollection();
  const { blob } = await exportPackage(col, { full: true });
  await save('pwa.colpkg', blob);
  const pkg = await readAnkiPackage(blob, { filename: 'x.colpkg' });
  assert.equal(pkg.kind, 'colpkg');
  assert.equal(pkg.notes.length, await col.noteCount());
  assert.equal(pkg.crt, col.col.crt);
});

test('plain text and CSV export, and text re-import', async () => {
  const { col } = await studiedCollection();
  const { blob } = await exportNotesText(col, {});
  await save('pwa-notes.txt', blob);
  const text = await blob.text();
  const parsed = parseAnkiText(text);
  assert.equal(parsed.header.html, true);
  assert.equal(parsed.header.guidCol, 0);
  assert.equal(parsed.rows.length, expected.notes + 2);
  // Re-importing into the same collection matches every note by GUID.
  const basic = col.notetypeByName('Basic');
  const mapping = suggestMapping(parsed.columns, parsed.rows[0].length, basic, parsed.header);
  assert.equal(mapping[0], 'guid');
  const r = await importRows(col, parsed.rows, { mapping, ntid: basic.id, html: true, dupes: 'update' });
  assert.equal(r.added, 0);
  assert.equal(await col.noteCount(), expected.notes + 2);

  const csv = await exportCsv(col, {});
  const rows = parseDelimited((await csv.blob.text()).replace(/^﻿/, ''), ',');
  assert.deepEqual(rows[0].slice(0, 4), ['GUID', 'Deck', 'Note type', 'Tags']);
  assert.equal(rows.length, expected.notes + 3);
});
