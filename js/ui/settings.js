// App settings: theme, font size, day rollover, global limits, storage status.

import { h, toast, confirmDialog } from './components.js';
import { isIOS, isStandalone } from '../util/platform.js';

export async function render(app) {
  const col = app.col;
  const s = col.settings;
  app.setTitle('Settings');

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
    section('Storage',
      h('div', { class: 'list-row', style: { padding: '8px 0' } }, h('span', { class: 'spacer' }, 'Storage'), h('span', { class: 'muted small' }, storageText)),
      h('div', { class: 'list-row', style: { padding: '8px 0' } }, h('span', { class: 'spacer' }, 'Protected from automatic clearing'),
        h('span', { class: 'small', style: { color: persisted ? 'var(--good)' : 'var(--hard)' } }, persisted ? 'Yes' : persisted === false ? 'No' : 'Unknown')),
      !persisted ? h('p', { class: 'hint-text' }, isIOS() && !isStandalone()
        ? 'On iPhone, Safari may delete site data after a few weeks without use. Add AnkiPWA to your Home Screen and keep regular backups.'
        : 'The browser may clear this data when space runs low. Installing the app and keeping backups protects your cards.') : null,
      number('Remind me to back up every (days)', s.backupReminderDays, { min: 1, max: 90 }, async (v) => { s.backupReminderDays = v; await save(); }),
      h('div', { class: 'row', style: { padding: '8px 0 12px' } }, h('a', { class: 'btn', href: '#/backup' }, 'Backup & restore'))),
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
