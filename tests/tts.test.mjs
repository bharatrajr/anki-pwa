// TTS and card audio: {{tts}} tags, AnkiDroid <tts> tags, FrontSide not replayed,
// read-aloud text without the question repeated, and per-script voices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, prepareMediaHtml } from '../js/render/card.js';
import { avRefs } from '../js/render/html.js';
import { splitByScript, pickVoice } from '../js/speech/speech.js';

const field = (name, ord) => ({ name, ord });
function make(qfmt, afmt, fields = ['dog', 'kukka']) {
  const notetype = { id: 1, name: 'TTS', kind: 0, css: '', fields: [field('Front', 0), field('Back', 1)], templates: [{ name: 'Card 1', ord: 0, qfmt, afmt }] };
  return renderCard({ card: { id: 1, ord: 0, flags: 0 }, note: { id: 1, fields, tags: [] }, notetype });
}
const visible = (html) => prepareMediaHtml(html).replace(/<button[^>]*>▶<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('{{tts}} is spoken once and not printed next to the field (AnkiDroid TTS deck)', () => {
  const r = make('{{Front}}{{tts en_US:Front}}', '{{FrontSide}}<hr id=answer>{{Back}}{{tts te_IN:Back}}');
  assert.equal(visible(r.q), 'dog', 'question shows the word once');
  assert.deepEqual(r.qAv, [{ kind: 'tts', text: 'dog', lang: 'en-US', speed: 1 }]);
  assert.deepEqual(r.aAv, [{ kind: 'tts', text: 'kukka', lang: 'te-IN', speed: 1 }], 'answer plays only its own TTS, not the question again');
  assert.equal(visible(r.a), 'dog kukka');
  assert.match(prepareMediaHtml(r.q), /data-tts="dog"/, 'a play button replays it');
});

test('speed option and tts-only templates', () => {
  const r = make('{{tts en_US speed=1.5:Front}}', '{{tts en_US:Back}}');
  assert.equal(r.qAv[0].speed, 1.5);
  assert.equal(visible(r.q), '');
  assert.equal(r.aAv.length, 1);
});

test('sound files: the answer does not replay the question audio', () => {
  const r = make('{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}', ['dog [sound:dog.mp3]', 'kukka [sound:kukka.mp3]']);
  assert.deepEqual(r.qAv, [{ kind: 'sound', file: 'dog.mp3' }]);
  assert.deepEqual(r.aAv, [{ kind: 'sound', file: 'kukka.mp3' }]);
  assert.equal((prepareMediaHtml(r.a).match(/data-sound=/g) || []).length, 2, 'both still have replay buttons');
});

test('read aloud: no <hr id=answer> does not read the question twice', () => {
  const r = make('{{Front}}', '{{FrontSide}}<br>{{Back}}');
  assert.equal(r.qText, 'dog');
  assert.equal(r.aText, 'kukka');
  const r2 = make('{{Front}}', '{{Front}}<hr id=answer>{{Back}}');
  assert.equal(r2.aText, 'kukka');
});

test('AnkiDroid <tts voice> tags are spoken once and stay visible', () => {
  const r = make('<tts service="android" voice="en_US">{{Front}}</tts>', '{{FrontSide}}<hr id=answer><tts service="android" voice="te_IN">{{Back}}</tts>');
  assert.deepEqual(r.qAv, [{ kind: 'tts', text: 'dog', lang: 'en-US', speed: 1 }]);
  assert.deepEqual(r.aAv, [{ kind: 'tts', text: 'kukka', lang: 'te-IN', speed: 1 }]);
  assert.equal(visible(r.q), 'dog');
});

test('cloze in {{tts}}: the gap is read as "blank"', () => {
  const notetype = { id: 2, name: 'C', kind: 1, css: '', fields: [field('Text', 0)], templates: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}{{tts en_US:cloze:Text}}', afmt: '{{cloze:Text}}' }] };
  const r = renderCard({ card: { id: 1, ord: 0, flags: 0 }, note: { id: 1, fields: ['{{c1::Paris}} is in France'], tags: [] }, notetype });
  assert.equal(r.qAv[0].text, 'blank is in France');
});

test('avRefs keeps sound and TTS order', () => {
  const items = avRefs('[sound:a.mp3] x [anki:tts lang=ja_JP]猫[/anki:tts] [sound:b.mp3] [sound-front:c.mp3]');
  assert.deepEqual(items.map((i) => i.kind + ':' + (i.file || i.text)), ['sound:a.mp3', 'tts:猫', 'sound:b.mp3']);
});

test('mixed-script text gets a voice per language', () => {
  assert.deepEqual(splitByScript('dog — కుక్క (kukka)'), [{ text: 'dog —', lang: null }, { text: 'కుక్క', lang: 'te-IN' }, { text: 'kukka', lang: null }]);
  assert.deepEqual(splitByScript('नमस्ते'), [{ text: 'नमस्ते', lang: 'hi-IN' }]);
  assert.equal(splitByScript('猫が好き')[0].lang, 'ja-JP', 'kanji with kana is Japanese');
  assert.equal(splitByScript('我爱你')[0].lang, 'zh-CN');
  assert.deepEqual(splitByScript('Hello, world!'), [{ text: 'Hello, world!', lang: null }]);
});

test('voice choice: chosen voice for its language, a matching voice otherwise', () => {
  const voices = [
    { voiceURI: 'en', lang: 'en-US', localService: true },
    { voiceURI: 'te-net', lang: 'te-IN', localService: false },
    { voiceURI: 'te', lang: 'te_IN', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en', null).voiceURI, 'en');
  assert.equal(pickVoice(voices, 'en', 'en-GB').voiceURI, 'en');
  assert.equal(pickVoice(voices, 'en', 'te-IN').voiceURI, 'te', 'offline voice preferred');
  assert.equal(pickVoice(voices, 'en', 'ta-IN'), null, 'no voice: let the engine choose by language');
});
