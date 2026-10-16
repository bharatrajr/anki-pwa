// Help: how studying works, keyboard shortcuts, installing, and backups.

import { h } from './components.js';

export async function render(app) {
  app.setTitle('Help');
  app.setBack('/settings');
  const keys = [
    ['Space / Enter', 'Show answer (on the answer side: Good)'],
    ['1 2 3 4', 'Again · Hard · Good · Easy'],
    ['U', 'Undo (several levels)'],
    ['E', 'Edit the note'],
    ['R', 'Replay audio'],
    ['S', 'Search the question on Google'],
    ['I', 'Card info'],
    ['-', 'Bury card'],
    ['@', 'Suspend card'],
    ['Ctrl+1 … Ctrl+7', 'Flag (red, orange, green, blue, pink, turquoise, purple); Ctrl+0 clears'],
    ['Ctrl+Enter', 'Add / save in the editor'],
    ['Ctrl+Shift+C', 'Cloze around the selection (add Alt to reuse the same number)'],
  ];
  const section = (title, ...kids) => h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface', style: { padding: '12px 14px' } }, ...kids));
  app.main.append(
    section('Studying',
      h('p', { style: { marginTop: 0 } }, 'Open a deck and tap Study now. Read the question, recall the answer, then tap the card (or Show answer). Rate honestly:'),
      h('ul', {},
        h('li', {}, h('b', { class: 'r-again' }, 'Again'), ' – you forgot. The card comes back soon.'),
        h('li', {}, h('b', { class: 'r-hard' }, 'Hard'), ' – you remembered with real effort.'),
        h('li', {}, h('b', { class: 'r-good' }, 'Good'), ' – you remembered. This should be your usual answer.'),
        h('li', {}, h('b', { class: 'r-easy' }, 'Easy'), ' – too easy; see it much later.')),
      h('p', {}, 'The small text on each button is when you will see the card next. Scheduling uses FSRS by default (the same algorithm as current Anki); you can switch a deck to SM-2 in its options.'),
      h('p', { style: { marginBottom: 0 } }, 'The Search chip copies the question (with cloze answers left out) and opens a Google search.')),
    section('Keyboard shortcuts',
      h('table', { class: 'info' }, h('tbody', {}, keys.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, h('kbd', {}, k)), h('td', {}, v)))))),
    section('Install as an app',
      h('p', { style: { marginTop: 0 } }, h('b', {}, 'Android (Chrome): '), 'tap Install on the Decks screen, or the ⋮ menu → Install app / Add to Home screen.'),
      h('p', {}, h('b', {}, 'iPhone / iPad (Safari): '), 'tap the Share button, then “Add to Home Screen”. Installing matters on iPhone: Safari can delete data of sites you have not opened for a while, but not of installed apps.'),
      h('p', { style: { marginBottom: 0 } }, 'After the first visit the app works fully offline.')),
    section('Backups',
      h('p', { style: { margin: 0 } }, 'Your cards live only on this device. Use Backup → Download backup (or Share to Drive) every week, and before clearing browser data or changing phones.')),
    section('Anki compatibility',
      h('p', { style: { margin: 0 } }, 'Decks, note types, templates and scheduling follow Anki’s own formats so that files can move between this app and Anki desktop, AnkiDroid and AnkiMobile. There is no AnkiWeb sync: moving files is the way to sync.'))
  );
}
