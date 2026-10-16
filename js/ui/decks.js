// Deck list: nested decks with due counts (new · learning · review).

import { h, menuSheet, promptDialog, confirmDialog, toast } from './components.js';
import { allDeckCounts } from '../sched/queue.js';
import { DEFAULT_DECK_ID } from '../db/collection.js';
import { isIOS, isStandalone } from '../util/platform.js';

export async function render(app) {
  const col = app.col;
  app.setTitle('Decks');
  app.setActions(
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Create deck', title: 'Create deck', onclick: () => createDeck(app) },
      h('span', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/></svg>' })),
    h('a', { class: 'icon-btn', href: '#/help', 'aria-label': 'Help', title: 'Help' }, '?')
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
        h('p', {}, 'Add your first card, or restore a backup. Importing Anki .apkg files arrives in the next update.'),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
          h('a', { class: 'btn primary', href: '#/add' }, 'Add a card'),
          h('a', { class: 'btn', href: '#/backup' }, 'Restore backup')))
    );
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
      h('a', { class: 'deck-name', href: `#/deck/${deck.id}` }, h('span', {}, short)),
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
        h('span', { class: 'spacer' }, 'Install on iPhone: tap Share ', h('span', { 'aria-hidden': 'true' }, '⎋'), ' then “Add to Home Screen”. Installing also protects your cards from Safari clearing storage.'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => { sessionStorageSet('iosHintDismissed', '1'); b.remove(); } }, '✕'));
      el.append(b);
    }
  };
  showInstall();
  document.addEventListener('installable', showInstall, { once: true });
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
  await menuSheet(deck.name, [
    { label: 'Study', icon: '▶', onClick: () => app.go(`/review/${deck.id}`) },
    { label: 'Add card here', icon: '+', onClick: () => app.go(`/add?did=${deck.id}`) },
    { label: 'Options', icon: '⚙', onClick: () => app.go(`/options/${deck.id}`) },
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
