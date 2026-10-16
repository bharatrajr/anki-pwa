// Template and cloze rendering, compared with Anki's documented output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, typeDiff } from '../js/render/template.js';
import { renderCloze, clozeNumbers, clozeOnly, parseCloze } from '../js/render/cloze.js';
import { stockNotetypes } from '../js/model/notetypes.js';
import { cardOrdsForNote, fieldChecksum } from '../js/model/cards.js';
import { renderCard, sanitizeHtml, speakableText, prepareMediaHtml } from '../js/render/card.js';
import { stripHtml, mediaRefs } from '../js/render/html.js';

const nt = Object.fromEntries(stockNotetypes().map((n) => [n.stock, n]));

test('field substitution, FrontSide and answer separator', () => {
  const t = nt.basic.templates[0];
  const fields = { Front: 'Capital of France?', Back: 'Paris' };
  const q = renderTemplate(t.qfmt, { fields, side: 'q', cardOrd: 0 }).html;
  assert.equal(q, 'Capital of France?');
  const a = renderTemplate(t.afmt, { fields, side: 'a', cardOrd: 0, frontSide: q }).html;
  assert.equal(a, 'Capital of France?\n\n<hr id=answer>\n\nParis');
});

test('conditionals {{#F}} and {{^F}}', () => {
  const src = '{{#Extra}}<div>{{Extra}}</div>{{/Extra}}{{^Extra}}none{{/Extra}}';
  assert.equal(renderTemplate(src, { fields: { Extra: 'x' }, side: 'q' }).html, '<div>x</div>');
  assert.equal(renderTemplate(src, { fields: { Extra: '' }, side: 'q' }).html, 'none');
  assert.equal(renderTemplate(src, { fields: { Extra: '<br>' }, side: 'q' }).html, 'none', '<br> counts as empty like Anki');
});

test('text: and hint: filters, unknown field error', () => {
  assert.equal(renderTemplate('{{text:F}}', { fields: { F: '<b>a</b> &amp; b' }, side: 'q' }).html, 'a &amp; b');
  const hint = renderTemplate('{{hint:F}}', { fields: { F: 'clue' }, side: 'q' }).html;
  assert.match(hint, /Show hint/);
  assert.match(hint, /clue/);
  assert.equal(renderTemplate('{{hint:F}}', { fields: { F: '' }, side: 'q' }).html, '');
  assert.match(renderTemplate('{{Nope}}', { fields: {}, side: 'q' }).html, /unknown field Nope/);
});

test('special fields Tags, Deck, Subdeck, Card, Type', () => {
  const ctx = { fields: {}, side: 'q', tags: ['a', 'b'], deckName: 'Lang::Telugu', cardName: 'Card 1', notetypeName: 'Basic' };
  assert.equal(renderTemplate('{{Tags}}|{{Deck}}|{{Subdeck}}|{{Card}}|{{Type}}', ctx).html, 'a b|Lang::Telugu|Telugu|Card 1|Basic');
});

test('type-in-the-answer: input on front, diff on back', () => {
  const t = nt['basic-typing'].templates[0];
  const fields = { Front: 'Capital?', Back: 'Paris' };
  const q = renderTemplate(t.qfmt, { fields, side: 'q', cardOrd: 0 });
  assert.match(q.html, /<input type="text" id="typeans"/);
  assert.equal(q.typeAnswer.expected, 'Paris');
  const a = renderTemplate(t.afmt, { fields, side: 'a', cardOrd: 0, typed: 'Pariss' });
  assert.match(a.html, /typeBad/);
  assert.match(typeDiff('Paris', 'Paris'), /typeGood">Paris/);
});

test('cloze parsing: numbers, hints, nesting, unclosed', () => {
  const text = '{{c1::Canberra::city}} is the capital of {{c2::Australia}}; {{c1::again}}';
  assert.deepEqual([...clozeNumbers(text)].sort(), [1, 2]);
  assert.equal(renderCloze(text, 1, 'q'),
    '<span class="cloze" data-cloze="Canberra" data-ordinal="1">[city]</span> is the capital of <span class="cloze-inactive" data-ordinal="2">Australia</span>; <span class="cloze" data-cloze="again" data-ordinal="1">[...]</span>');
  assert.equal(renderCloze(text, 2, 'a'),
    '<span class="cloze-inactive" data-ordinal="1">Canberra</span> is the capital of <span class="cloze" data-ordinal="2">Australia</span>; <span class="cloze-inactive" data-ordinal="1">again</span>');
  assert.equal(clozeOnly(text, 1), 'Canberra, again');
  // nested
  const nested = '{{c1::outer {{c2::inner}} text}}';
  assert.deepEqual([...clozeNumbers(nested)].sort(), [1, 2]);
  assert.match(renderCloze(nested, 2, 'q'), /outer <span class="cloze" data-cloze="inner" data-ordinal="2">\[\.\.\.\]<\/span> text/);
  // unclosed stays as text
  assert.equal(stripHtml(renderCloze('a {{c1::b', 1, 'q')), 'a {{c1::b');
  assert.equal(parseCloze('plain').length, 1);
});

test('cloze note types make one card per cloze number', () => {
  const note = { fields: ['{{c1::a}} {{c3::b}} {{c3::c}}', ''] };
  assert.deepEqual(cardOrdsForNote(nt.cloze, note), [0, 2]);
});

test('standard note types skip templates with an empty front', () => {
  assert.deepEqual(cardOrdsForNote(nt['basic-reversed'], { fields: ['front', 'back'] }), [0, 1]);
  assert.deepEqual(cardOrdsForNote(nt['basic-reversed'], { fields: ['front', ''] }), [0]);
  assert.deepEqual(cardOrdsForNote(nt.basic, { fields: ['', 'x'] }), []);
  assert.deepEqual(cardOrdsForNote(nt['basic-typing'], { fields: ['q', 'a'] }), [0]);
});

test('note checksum matches Anki (first 8 hex digits of SHA-1 of stripped field)', () => {
  // sha1("hello") = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d → 0xaaf4c61d
  assert.equal(fieldChecksum('hello'), 0xaaf4c61d);
  assert.equal(fieldChecksum('<b>hello</b>'), 0xaaf4c61d, 'HTML is stripped first');
  // Images keep their file name (strip_html_preserving_media_filenames)
  assert.equal(fieldChecksum('<img src="a.jpg">'), fieldChecksum(' a.jpg '));
});

test('renderCard: cloze TTS text says "blank", search text hides answers', () => {
  const note = { fields: ['The {{c1::Godavari}} flows through {{c2::Telangana}}.', 'extra'], tags: [] };
  const r = renderCard({ card: { ord: 0, flags: 0 }, note, notetype: nt.cloze });
  assert.match(r.qText, /The blank flows through Telangana\./);
  assert.ok(!r.searchText.includes('Godavari'));
  assert.match(r.searchText, /flows through Telangana/);
  assert.match(r.a, /Godavari/);
  assert.match(r.aText, /Godavari/);
});

test('renderCard: basic answer text excludes the question', () => {
  const note = { fields: ['Q text', 'A text'], tags: [] };
  const r = renderCard({ card: { ord: 0, flags: 0 }, note, notetype: nt.basic });
  assert.equal(r.qText, 'Q text');
  assert.equal(r.aText, 'A text');
  assert.equal(r.searchText, 'Q text');
});

test('sanitizer removes scripts, handlers and javascript: URLs', () => {
  const dirty = '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:evil()">l</a><img src=x onerror=alert(1)><iframe src="//e"></iframe>';
  const clean = sanitizeHtml(dirty);
  assert.ok(!/script|onclick|onerror|javascript:|iframe/i.test(clean), clean);
  assert.match(clean, /<p>hi<\/p>/);
});

test('media: sound tags become buttons, local images are resolved later', () => {
  const html = prepareMediaHtml('[sound:a.mp3]<img src="pic.jpg"><img src="https://x/y.png">');
  assert.match(html, /data-sound="a.mp3"/);
  assert.match(html, /<img data-media="pic.jpg">/);
  assert.match(html, /src="https:\/\/x\/y.png"/);
  assert.deepEqual(mediaRefs('[sound:a.mp3]<img src="b.png"><img src="http://x/c.png">').sort(), ['a.mp3', 'b.png']);
  assert.equal(speakableText('Hello [sound:a.mp3]<br>World'), 'Hello. World');
});
