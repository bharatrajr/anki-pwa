// Deck list: nested decks with due counts (new · learning · review).

import { h, menuSheet, promptDialog, confirmDialog, toast, sheet } from './components.js';
import { allDeckCounts } from '../sched/queue.js';
import { DEFAULT_DECK_ID } from '../db/collection.js';
import { rebuildFiltered, emptyFiltered } from '../sched/filtered.js';
import { isIOS, isStandalone } from '../util/platform.js';
import { STARTER, starterOffered, markStarterOffered, addStarterDeck } from '../io/starter.js';

export async function render(app) {
  const col = app.col;
  app.setTitle('Decks');
  app.setActions(
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Create deck', title: 'Create deck', onclick: () => createDeck(app) },
      h('span', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/></svg>' })),
    h('a', { class: 'icon-btn', href: '#/help', 'aria-label': 'Help', title: 'Help' }, '?'),
    h('a', { class: 'icon-btn nav-narrow', href: '#/settings', 'aria-label': 'Settings', title: 'Settings' }, '⚙')
  );

  await col.rolloverIfNeeded();
  const counts = await allDeckCounts(col);
  const cardTotal = await col.cardCount();
  const banners = h('div');
  app.main.append(banners);
  renderBanners(app, banners, cardTotal);

  const decks = [...col.decks.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  // Hide the empty Default deck once other decks exist (like Anki).
  const defaultEmpty = decks.length > 1 && (await col.count('cards', IDBKeyRange.bound([DEFAULT_DECK_ID, -Infinity, -Infinity], [DEFAULT_DECK_ID, Infinity, Infinity]), 'did_queue_due')) === 0;
  const visible = decks.filter((d) => !(d.id === DEFAULT_DECK_ID && defaultEmpty && !d.name.includes('::')));

  if (cardTotal === 0 && visible.length <= 1) {
    app.main.append(
      h('div', { class: 'empty card-surface' },
        h('h2', {}, 'No cards yet'),
        h('p', {}, 'Add your first card, import a deck from Anki (.apkg, .colpkg), a spreadsheet or Quizlet, or restore a backup.'),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
          h('button', { class: 'btn primary', type: 'button', onclick: () => installStarter(app) }, `Add ${STARTER.name} deck`),
          h('a', { class: 'btn', href: '#/add' }, 'Add a card'),
          h('a', { class: 'btn', href: '#/import' }, 'Import a deck'),
          h('a', { class: 'btn', href: '#/backup' }, 'Restore backup')))
    );
    if (!starterOffered(col)) offerStarter(app);
    return;
  }

  const list = h('ul', { class: 'decks card-surface', role: 'tree', 'aria-label': 'Decks' });
  const childrenOf = (name) => visible.filter((d) => d.name.startsWith(name + '::') && !d.name.slice(name.length + 2).includes('::'));
  const roots = visible.filter((d) => !d.name.includes('::') || !visible.some((p) => d.name.startsWith(p.name + '::') && p.name.split('::').length === d.name.split('::').length - 1));

  const addRow = (deck, depth) => {
    const kids = childrenOf(deck.name);
    const c = counts.get(deck.id) || { n: 0, l: 0, r: 0 };
    const short = deck.name.split('::').pop();
    const num = (v, cls, label) => h('span', { class: v ? cls : 'zero', 'aria-label': `${v} ${label}` }, String(v));
    const row = h('li', { class: 'deck-row', role: 'treeitem', 'aria-expanded': kids.length ? String(!deck.collapsed) : null, style: { paddingLeft: `${depth * 18}px` } },
      h('button', {
        class: `twisty${kids.length ? '' : ' none'}`, type: 'button', 'aria-label': deck.collapsed ? `Expand ${short}` : `Collapse ${short}`,
        onclick: async () => { deck.collapsed = !deck.collapsed; await col.saveDeck(deck); render2(); },
      }, kids.length ? (deck.collapsed ? '▶' : '▼') : ''),
      h('a', { class: `deck-name${deck.dyn ? ' filtered' : ''}`, href: `#/deck/${deck.id}` }, h('span', {}, short)),
      h('span', { class: 'counts' }, num(c.n, 'n', 'new'), num(c.l, 'l', 'learning'), num(c.r, 'r', 'to review')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Options for ${short}`, onclick: () => deckMenu(app, deck) }, '⋮')
    );
    list.append(row);
    if (!deck.collapsed) for (const k of kids) addRow(k, depth + 1);
  };
  const render2 = () => { list.replaceChildren(); for (const r of roots) addRow(r, 0); };
  render2();

  app.main.append(
    h('div', { class: 'row small muted', style: { justifyContent: 'flex-end', gap: '14px', margin: '0 6px 6px' } },
      h('span', { style: { color: 'var(--new)' } }, 'New'), h('span', { style: { color: 'var(--learn)' } }, 'Learning'), h('span', { style: { color: 'var(--review)' } }, 'Review')),
    list,
    h('p', { class: 'small muted', style: { textAlign: 'center', marginTop: '16px' } }, `${cardTotal} cards`)
  );
}

function renderBanners(app, el, cardTotal) {
  const col = app.col;
  // Weekly backup reminder.
  const last = col.col.lastBackup || 0;
  const days = (Date.now() - last) / 86400000;
  if (cardTotal > 0 && days >= (col.settings.backupReminderDays || 7)) {
    el.append(h('div', { class: 'banner', role: 'note' },
      h('span', { class: 'spacer' }, last ? `Last backup ${Math.floor(days)} days ago.` : 'You have not backed up yet.'),
      h('a', { class: 'btn', href: '#/backup' }, 'Back up')));
  }
  // Install.
  const showInstall = () => {
    if (isStandalone() || el.querySelector('[data-install]')) return;
    if (app.installPrompt) {
      el.append(h('div', { class: 'banner', 'data-install': '' },
        h('span', { class: 'spacer' }, 'Install AnkiPWA for offline use and a full-screen app.'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { app.installPrompt.prompt(); await app.installPrompt.userChoice; app.installPrompt = null; el.querySelector('[data-install]')?.remove(); } }, 'Install')));
    } else if (isIOS() && !sessionStorageGet('iosHintDismissed')) {
      const b = h('div', { class: 'banner', 'data-install': '' },
        h('span', { class: 'spacer' }, 'Install on iPhone: tap Share ', h('span', { 'aria-hidden': 'true', style: { display: 'inline-flex', verticalAlign: '-3px' }, html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>' }), ' then “Add to Home Screen”. Installing also protects your cards from Safari clearing storage.'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => { sessionStorageSet('iosHintDismissed', '1'); b.remove(); } }, '✕'));
      el.append(b);
    }
  };
  showInstall();
  document.addEventListener('installable', showInstall, { once: true });
}

// First run: ask once whether to add the bundled starter deck.
async function offerStarter(app) {
  const yes = await sheet('Add a starter deck?', (close) => h('div', {},
    h('p', { style: { marginTop: 0 } }, h('b', {}, STARTER.name), ' — ', STARTER.blurb),
    h('p', { class: 'small muted' }, 'Optional. You can delete it later from the deck’s ⋮ menu, or add it any time from this screen or Import.'),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Start empty'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => close(true) }, 'Add deck'))));
  if (yes) await installStarter(app);
  else await markStarterOffered(app.col);
}

export async function installStarter(app) {
  toast('Adding the deck…', { ms: 60000 });
  try {
    const r = await addStarterDeck(app.col);
    toast(`Added ${r.cardsAdded} cards`);
  } catch (e) {
    console.error(e);
    toast(String(e.message || e), { ms: 6000 });
    return;
  }
  app.go('/');
}

function sessionStorageGet(k) { try { return localStorage.getItem(`ankipwa.${k}`); } catch { return null; } }
function sessionStorageSet(k, v) { try { localStorage.setItem(`ankipwa.${k}`, v); } catch {} }

async function createDeck(app, parent = '') {
  const name = await promptDialog('Create deck', { label: 'Deck name', value: parent ? `${parent}::` : '', hint: 'Use :: for subdecks, e.g. Telugu::Grammar', ok: 'Create' });
  if (!name?.trim()) return;
  await app.col.addDeck(name);
  app.go('/');
}

async function deckMenu(app, deck) {
  const col = app.col;
  if (deck.dyn) {
    await menuSheet(deck.name, [
      { label: 'Study', icon: '▶', onClick: () => app.go(`/review/${deck.id}`) },
      { label: 'Rebuild', icon: '↻', onClick: async () => { const n = await rebuildFiltered(col, deck.id); toast(`Rebuilt: ${n} cards`); app.go('/'); } },
      { label: 'Empty', icon: '⤴', onClick: async () => { await emptyFiltered(col, deck.id); toast('Cards returned to their decks'); app.go('/'); } },
      { label: 'Delete', icon: '🗑', onClick: async () => { await col.deleteDeck(deck.id); toast('Filtered deck deleted; its cards went back to their decks'); app.go('/'); } },
    ]);
    return;
  }
  await menuSheet(deck.name, [
    { label: 'Study', icon: '▶', onClick: () => app.go(`/review/${deck.id}`) },
    { label: 'Add card here', icon: '+', onClick: () => app.go(`/add?did=${deck.id}`) },
    { label: 'Options', icon: '⚙', onClick: () => app.go(`/options/${deck.id}`) },
    { label: 'Browse cards', icon: '🔍', onClick: () => app.go(`/browse?q=${encodeURIComponent(`deck:"${deck.name}"`)}`) },
    { label: 'Statistics', icon: '📊', onClick: () => app.go(`/stats?did=${deck.id}`) },
    { label: 'Export', icon: '⇪', onClick: () => app.go(`/export?did=${deck.id}`) },
    { label: 'Add subdeck', icon: '📁', onClick: () => createDeck(app, deck.name) },
    { label: 'Rename', icon: '✎', onClick: async () => {
      const name = await promptDialog('Rename deck', { label: 'Deck name', value: deck.name, ok: 'Rename' });
      if (!name?.trim()) return;
      try { await col.renameDeck(deck.id, name); app.go('/'); } catch (e) { toast(e.message); }
    } },
    deck.id === DEFAULT_DECK_ID ? null : { label: 'Delete', icon: '🗑', onClick: async () => {
      let n = 0;
      for (const id of col.deckSubtreeIds(deck.id)) n += await col.count('cards', IDBKeyRange.bound([id, -Infinity, -Infinity], [id, Infinity, Infinity]), 'did_queue_due');
      const ok = await confirmDialog('Delete deck?', `“${deck.name}”, its subdecks and ${n} card${n === 1 ? '' : 's'} will be deleted. Make a backup first if you might want them back.`, { ok: 'Delete', danger: true });
      if (!ok) return;
      await col.deleteDeck(deck.id);
      toast('Deck deleted');
      app.go('/');
    } },
  ]);
}
