// App settings: theme, font size, day rollover, global limits, storage status.

import { h, toast, confirmDialog } from './components.js';
import { isIOS, isStandalone } from '../util/platform.js';
import { getVoices, speak, ttsSupported, recognitionSupported, wakeLockSupported } from '../speech/speech.js';

export async function render(app) {
  const col = app.col;
  const s = col.settings;
  app.setTitle('Settings');
  app.setBack('/');

  const save = async () => { await col.saveSettings(); app.applyTheme(); };
  const section = (title, ...kids) => h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface', style: { padding: '4px 14px' } }, ...kids));
  const select = (label, value, options, onChange) => {
    const el = h('select', { class: 'input' }, options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === String(value) }, t)));
    el.addEventListener('change', () => onChange(el.value));
    return h('label', { class: 'field' }, h('span', {}, label), el);
  };
  const toggle = (label, checked, onChange, hint) => {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch' }, h('span', {}, label, hint ? h('span', { class: 'hint-text', style: { display: 'block' } }, hint) : null), input);
  };
  const number = (label, value, { min, max }, onChange, hint) => {
    const input = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), value: String(value), inputmode: 'numeric' });
    input.addEventListener('change', () => { const v = parseInt(input.value, 10); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); });
    return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('p', { class: 'hint-text' }, hint) : null);
  };

  const fsOut = h('output', {}, `${Math.round(s.fontScale * 100)}%`);
  const fs = h('input', { type: 'range', min: '0.8', max: '1.6', step: '0.05', value: String(s.fontScale), style: { width: '100%', minHeight: '44px', accentColor: 'var(--accent)' }, 'aria-label': 'Font size' });
  fs.addEventListener('input', () => { s.fontScale = parseFloat(fs.value); fsOut.textContent = `${Math.round(s.fontScale * 100)}%`; app.applyTheme(); });
  fs.addEventListener('change', save);

  let storageText = 'Unknown';
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      storageText = `${(est.usage / 1048576).toFixed(1)} MB used`;
    } catch {}
  }
  const persisted = app.storagePersisted;
  const g = s.globalLimits;

  // Speech: voice picker filled once the browser has loaded its voices.
  const voiceSel = h('select', { class: 'input', 'aria-label': 'Voice' }, h('option', { value: '' }, 'Automatic (card language or device default)'));
  voiceSel.addEventListener('change', async () => { s.tts.voiceURI = voiceSel.value; await save(); });
  getVoices().then((voices) => {
    const sorted = [...voices].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    for (const v of sorted) voiceSel.append(h('option', { value: v.voiceURI, selected: v.voiceURI === s.tts.voiceURI }, `${v.name} (${v.lang})${v.localService ? '' : ' · online'}`));
  });
  const rateOut = h('output', {}, `${s.tts.rate.toFixed(2)}×`);
  const rate = h('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: String(s.tts.rate), style: { width: '100%', minHeight: '44px', accentColor: 'var(--accent)' }, 'aria-label': 'Speaking rate' });
  rate.addEventListener('input', () => { s.tts.rate = parseFloat(rate.value); rateOut.textContent = `${s.tts.rate.toFixed(2)}×`; });
  rate.addEventListener('change', save);
  const speechSection = section('Speech',
    toggle('Play card audio automatically', s.tts.autoplay !== false, async (v) => { s.tts.autoplay = v; await save(); }, 'Sound files and {{tts}} in the card play when it is shown, like Anki. Tap ▶ on a card to replay.'),
    ttsSupported ? [
      toggle('Read cards aloud', s.tts.enabled, async (v) => { s.tts.enabled = v; await save(); }, 'For cards without their own audio: reads the question, then the answer. Cloze gaps are read as “blank”. Also a 🔊 button on the review screen.'),
      toggle('Also read the answer', s.tts.readAnswer, async (v) => { s.tts.readAnswer = v; await save(); }),
      h('label', { class: 'field' }, h('span', {}, 'Voice'), voiceSel, h('p', { class: 'hint-text' }, 'Used for English and other Latin-script text. Telugu, Hindi, Tamil, Japanese and other scripts get a voice for their language automatically, as do templates with {{tts te_IN:Field}}.')),
      h('div', { class: 'field' }, h('span', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' } }, 'Speaking rate', rateOut), rate),
      h('div', { class: 'row', style: { padding: '0 0 8px' } }, h('button', { class: 'btn', type: 'button', onclick: () => speak('This is how cards will sound.', { voiceURI: s.tts.voiceURI, rate: s.tts.rate }) }, 'Test voice')),
      number('Hands-free: show the answer after (seconds)', s.tts.autoRevealSecs, { min: 0, max: 60 }, async (v) => { s.tts.autoRevealSecs = v; await save(); }, '0 = off. Counts from when the question has been read.'),
    ] : h('p', { class: 'hint-text' }, 'This browser cannot read text aloud.'),
    recognitionSupported ? [
      toggle('Answer by voice', s.voice.enabled, async (v) => { s.voice.enabled = v; await save(); }, 'Say “show” to flip, then “again”, “hard”, “good” or “easy” (or one to four). “Undo” and “repeat” work too. Needs internet and microphone permission.'),
      select('Voice command language', s.voice.lang, [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)']], async (v) => { s.voice.lang = v; await save(); }),
    ] : h('p', { class: 'hint-text' }, isIOS() ? 'Voice answers are not available on iPhone and iPad (Safari does not support speech recognition reliably, especially in installed apps). Tap the buttons instead.' : 'Voice answers are not supported in this browser. Chrome on Android supports them.'),
    wakeLockSupported ? toggle('Keep the screen on while reading aloud or listening', s.keepAwake, async (v) => { s.keepAwake = v; await save(); }) : null);

  app.main.append(
    section('Appearance',
      select('Theme', s.theme, [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], async (v) => { s.theme = v; await save(); }),
      h('div', { class: 'field' }, h('span', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' } }, 'Text size', fsOut), fs),
      toggle('Show next interval on answer buttons', s.showIntervals, async (v) => { s.showIntervals = v; await save(); })),
    section('Studying',
      number('Next day starts at (hour, 0–23)', s.rolloverHour, { min: 0, max: 23 }, async (v) => { s.rolloverHour = v; await save(); }, 'Like Anki, a “day” starts at this hour, so late-night reviews count for the same day. Anki’s default is 4.'),
      number('Learn ahead limit (minutes)', s.learnAheadMins, { min: 0, max: 240 }, async (v) => { s.learnAheadMins = v; await save(); }, 'When nothing else is due, show learning cards due within this many minutes.'),
      select('New cards and reviews', s.newReviewMix, [['mix', 'Mix new cards with reviews'], ['after', 'Show new cards after reviews'], ['before', 'Show new cards before reviews']], async (v) => { s.newReviewMix = v; await save(); }),
      toggle('One daily limit across all decks', g.enabled, async (v) => { g.enabled = v; await save(); }, 'In addition to each deck’s own limits.'),
      number('All decks: new cards per day', g.newPerDay, { min: 0, max: 9999 }, async (v) => { g.newPerDay = v; await save(); }),
      number('All decks: reviews per day', g.revPerDay, { min: 0, max: 99999 }, async (v) => { g.revPerDay = v; await save(); })),
    speechSection,
    section('Storage',
      h('div', { class: 'list-row', style: { padding: '8px 0' } }, h('span', { class: 'spacer' }, 'Storage'), h('span', { class: 'muted small' }, storageText)),
      h('div', { class: 'list-row', style: { padding: '8px 0' } }, h('span', { class: 'spacer' }, 'Protected from automatic clearing'),
        h('span', { class: 'small', style: { color: persisted ? 'var(--good)' : 'var(--hard)' } }, persisted ? 'Yes' : persisted === false ? 'No' : 'Unknown')),
      !persisted ? h('p', { class: 'hint-text' }, isIOS() && !isStandalone()
        ? 'On iPhone, Safari may delete site data after a few weeks without use. Add AnkiPWA to your Home Screen and keep regular backups.'
        : 'The browser may clear this data when space runs low. Installing the app and keeping backups protects your cards.') : null,
      number('Remind me to back up every (days)', s.backupReminderDays, { min: 1, max: 90 }, async (v) => { s.backupReminderDays = v; await save(); }),
      h('div', { class: 'row', style: { padding: '8px 0 12px' } }, h('a', { class: 'btn', href: '#/backup' }, 'Backup, import & export'))),
    section('About',
      h('div', { class: 'list-row', style: { padding: '8px 0' } }, h('span', { class: 'spacer' }, 'Version'), h('span', { class: 'muted small' }, app.version)),
      h('div', { class: 'row', style: { padding: '8px 0' } }, h('a', { class: 'btn', href: '#/help' }, 'Help & shortcuts'),
        app.installPrompt ? h('button', { class: 'btn', type: 'button', onclick: async () => { app.installPrompt.prompt(); await app.installPrompt.userChoice; app.installPrompt = null; } }, 'Install app') : null),
      h('p', { class: 'hint-text' }, 'AnkiPWA is an independent app and is not affiliated with Anki or AnkiWeb. Your cards stay on this device; nothing is uploaded.'),
      h('div', { class: 'row', style: { padding: '8px 0 12px' } }, h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog('Erase everything?', 'All decks, cards, review history, media and settings on this device will be deleted. Download a backup first if you want to keep them.', { ok: 'Erase', danger: true }))) return;
        await col.replaceAll({});
        toast('All data erased');
        app.applyTheme();
        app.go('/');
      } }, 'Erase all data')))
  );
}
