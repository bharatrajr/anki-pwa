// Search syntax, filtered decks (custom study / preview) and statistics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCol } from './helpers.mjs';
import { parseQuery, searchCards, globToRegex } from '../js/search/search.js';
import { createFiltered, emptyFiltered, customStudySearch } from '../js/sched/filtered.js';
import { nextCard, answerCard, deckCounts, undo, setDueDate, suspendCards, Q } from '../js/sched/queue.js';
import { computeStats } from '../js/stats/stats.js';

async function sample() {
  const col = await freshCol();
  const words = await col.addDeck('Telugu::Words');
  const gram = await col.addDeck('Telugu::Grammar');
  const other = await col.addDeck('French');
  const basic = col.notetypeByName('Basic');
  const cloze = col.notetypeByName('Cloze');
  await col.addNote({ ntid: basic.id, fields: ['dog', 'kukka'], did: words.id, tags: ['animals', 'core::nouns'] });
  await col.addNote({ ntid: basic.id, fields: ['<b>water</b>', 'neeru'], did: words.id, tags: ['nature'] });
  await col.addNote({ ntid: cloze.id, fields: ['{{c1::Hyderabad}} is in {{c2::Telangana}}', ''], did: gram.id });
  await col.addNote({ ntid: basic.id, fields: ['chien', 'dog'], did: other.id, tags: ['animals'] });
  return { col, words, gram, other };
}
const q = async (col, s) => (await searchCards(col, s)).map((x) => x.note.fields[0]).sort();

test('query parser: groups, negation, or, quotes, keys', () => {
  assert.deepEqual(parseQuery('a -b'), { op: 'and', items: [{ op: 'term', key: '', value: 'a' }, { op: 'not', item: { op: 'term', key: '', value: 'b' } }] });
  assert.equal(parseQuery('a or b').op, 'or');
  assert.deepEqual(parseQuery('deck:"My Deck"'), { op: 'term', key: 'deck', value: 'My Deck' });
  assert.equal(parseQuery('(a or b) c').items[0].op, 'or');
  assert.ok(globToRegex('d*g').test('doooog'));
  assert.ok(globToRegex('d_g').test('dog') && !globToRegex('d_g').test('doog'));
});

test('search terms', async () => {
  const { col } = await sample();
  assert.deepEqual(await q(col, 'dog'), ['chien', 'dog']);
  assert.deepEqual(await q(col, 'water'), ['<b>water</b>'], 'HTML is ignored when matching');
  assert.deepEqual(await q(col, 'deck:Telugu -deck:Telugu::Grammar'), ['<b>water</b>', 'dog']);
  assert.deepEqual(await q(col, 'tag:core'), ['dog'], 'parent tag matches child tags');
  assert.deepEqual(await q(col, 'tag:animals deck:french'), ['chien']);
  assert.deepEqual(await q(col, 'tag:none'), ['{{c1::Hyderabad}} is in {{c2::Telangana}}', '{{c1::Hyderabad}} is in {{c2::Telangana}}']);
  assert.equal((await q(col, 'note:Cloze card:2')).length, 1);
  assert.deepEqual(await q(col, 'Back:neeru'), ['<b>water</b>']);
  assert.deepEqual(await q(col, '(dog or neeru) -tag:nature'), ['chien', 'dog']);
  assert.equal((await q(col, 'is:new')).length, 5);
  assert.equal((await q(col, 'added:1')).length, 5);
  assert.equal((await q(col, 'is:due')).length, 0);
});

test('state, prop and rated searches after studying', async () => {
  const { col, words } = await sample();
  const first = await nextCard(col, words.id);
  await answerCard(col, first.card, 1);
  const cards = (await col.allCards()).filter((c) => c.type === 0);
  await setDueDate(col, [cards[0]], '5!');
  assert.equal((await q(col, 'is:learn')).length, 1);
  assert.equal((await q(col, 'rated:1:1')).length, 1);
  assert.equal((await q(col, 'rated:1:3')).length, 0);
  assert.equal((await q(col, 'introduced:1')).length, 1);
  assert.equal((await q(col, 'prop:ivl=5')).length, 1);
  assert.equal((await q(col, 'prop:due>3')).length, 1);
  await suspendCards(col, [cards[1]]);
  assert.equal((await q(col, 'is:suspended')).length, 1);
});

test('custom study: filtered deck with rescheduling, then empty', async () => {
  const { col, words } = await sample();
  const { deck, count } = await createFiltered(col, { search: customStudySearch('Telugu', 'tags', { state: 'new' }), limit: 10, order: 'added' });
  assert.equal(count, 4);
  assert.equal(deck.dyn, 1);
  assert.equal((await deckCounts(col, words.id)).n, 0, 'cards left the home deck');
  assert.equal((await deckCounts(col, deck.id)).n, 4);
  const next = await nextCard(col, deck.id);
  const entry = await answerCard(col, next.card, 4); // Easy → graduates → goes home
  const after = await col.getCard(next.card.id);
  assert.equal(after.did, next.card.odid);
  assert.equal(after.odid, 0);
  assert.equal(after.type, 2);
  await undo(col, entry);
  assert.equal((await col.getCard(next.card.id)).did, deck.id);
  // A Good answer keeps an intraday learning card in the filtered deck.
  const n2 = await nextCard(col, deck.id);
  await answerCard(col, n2.card, 3);
  const l = await col.getCard(n2.card.id);
  assert.equal(l.queue, Q.LRN);
  assert.equal(l.did, deck.id);
  await emptyFiltered(col, deck.id);
  const all = await col.allCards();
  assert.ok(all.every((c) => !c.odid && !col.decks.get(c.did).dyn));
  assert.equal(all.find((c) => c.id === n2.card.id).queue, Q.LRN, 'learning progress kept after emptying');
  await col.deleteDeck(deck.id);
  assert.equal(await col.cardCount(), 5, 'deleting a filtered deck keeps its cards');
});

test('preview (no rescheduling) leaves scheduling alone', async () => {
  const { col } = await sample();
  const { deck } = await createFiltered(col, { name: 'Preview', search: 'is:new', limit: 50, resched: false });
  const next = await nextCard(col, deck.id);
  await answerCard(col, next.card, 1);
  assert.equal((await col.getCard(next.card.id)).did, deck.id, 'Again keeps it in the session');
  const again = await col.getCard(next.card.id);
  await answerCard(col, again, 3);
  const home = await col.getCard(next.card.id);
  assert.equal(home.type, 0);
  assert.equal(home.odid, 0);
  assert.equal(home.due, next.card.odue);
  assert.equal((await col.allRevlog()).length, 0);
});

test('statistics', async () => {
  const { col, words } = await sample();
  for (let i = 0; i < 3; i++) { const n = await nextCard(col, words.id); if (n) await answerCard(col, n.card, i === 0 ? 1 : 4); }
  const s = await computeStats(col);
  assert.equal(s.today.count, 3);
  assert.equal(s.today.again, 1);
  assert.equal(s.today.newCards, 2, 'the deck has two cards; the third answer is the learning card again');
  assert.equal(s.streak, 1);
  assert.equal(s.counts.total, 5);
  assert.equal(s.counts.young, 2);
  assert.equal(s.forecast.reduce((a, d) => a + d.young + d.mature + d.learn, 0), 2);
  const scoped = await computeStats(col, col.deckByName('French').id);
  assert.equal(scoped.today.count, 0);
  assert.equal(scoped.counts.new, 1);
});
