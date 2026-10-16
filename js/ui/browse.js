// Card browser: Anki-style search, cards or notes view, sorting, and bulk actions
// (suspend, flag, change deck, tags, reset, set due date, reposition, delete, filtered deck).

import { h, toast, menuSheet, sheet, promptDialog, confirmDialog, FLAG_NAMES } from './components.js';
import { searchCards, cardRetrievability } from '../search/search.js';
import { suspendCards, flagCards, forgetCards, setDueDate, repositionNew, buryCards } from '../sched/queue.js';
import { createFiltered, ORDERS } from '../sched/filtered.js';
import { normaliseTags } from '../db/collection.js';
import { fmtInterval, fmtDate, dayToDate } from '../util/time.js';

const PAGE = 150;
const QUICK = [
  ['Due', 'is:due'], ['New', 'is:new'], ['Learning', 'is:learn'], ['Suspended', 'is:suspended'],
  ['Flagged', '-flag:0'], ['Leeches', 'tag:leech'], ['Added today', 'added:1'], ['Studied today', 'rated:1'], ['Again today', 'rated:1:1'],
];
const SORTS = {
  sfld: ['Sort field', (a, b) => a.note.sfld.localeCompare(b.note.sfld, undefined, { numeric: true, sensitivity: 'base' })],
  due: ['Due', null],
  added: ['Created', (a, b) => a.card.id - b.card.id],
  mod: ['Edited', (a, b) => (b.note.mod || 0) - (a.note.mod || 0)],
  ivl: ['Interval', (a, b) => b.card.ivl - a.card.ivl],
  ease: ['Ease', (a, b) => (a.card.factor || 0) - (b.card.factor || 0)],
  lapses: ['Lapses', (a, b) => b.card.lapses - a.card.lapses],
  reps: ['Reviews', (a, b) => b.card.reps - a.card.reps],
  r: ['Retrievability', null],
};

export async function render(app) {
  const col = app.col;
  app.setTitle('Browse');
  const params = app.params();
  const st = {
    query: params.get('q') ?? 'deck:*',
    mode: localGet('browseMode') || 'cards',
    sort: localGet('browseSort') || 'sfld',
    results: [], shown: PAGE, selected: new Set(),
  };

  const modeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Switch cards / notes', 'aria-label': 'Switch between cards and notes' });
  modeBtn.addEventListener('click', () => { st.mode = st.mode === 'cards' ? 'notes' : 'cards'; localSet('browseMode', st.mode); run(); });
  app.setActions(modeBtn);

  const input = h('input', { class: 'input', type: 'search', value: st.query, placeholder: 'deck:French tag:verbs is:due …', 'aria-label': 'Search', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const form = h('form', { class: 'search-row', role: 'search', onsubmit: (e) => { e.preventDefault(); st.query = input.value.trim(); app.go(`/browse?q=${encodeURIComponent(st.query)}`); } },
    input, h('button', { class: 'btn primary', type: 'submit' }, 'Search'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Search help', title: 'Search help', onclick: searchHelp }, '?'));
  const chips = h('div', { class: 'chips' }, QUICK.map(([label, q]) => h('button', { class: 'chip', type: 'button', onclick: () => { input.value = q; form.requestSubmit(); } }, label)));
  const sortSel = h('select', { class: 'input compact', 'aria-label': 'Sort by' }, Object.entries(SORTS).map(([k, [label]]) => h('option', { value: k, selected: k === st.sort }, label)));
  sortSel.addEventListener('change', () => { st.sort = sortSel.value; localSet('browseSort', st.sort); sortResults(); draw(); });
  const info = h('span', { class: 'small muted spacer', 'aria-live': 'polite' });
  const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select all results' });
  selectAll.addEventListener('change', () => {
    if (selectAll.checked) for (const r of st.results) st.selected.add(key(r)); else st.selected.clear();
    draw();
  });
  const toolbar = h('div', { class: 'row browse-bar' }, h('label', { class: 'row', style: { gap: '6px' } }, selectAll, h('span', { class: 'small' }, 'All')), info, sortSel);
  const list = h('ul', { class: 'list card-surface browse-list' });
  const more = h('div', { style: { textAlign: 'center', margin: '12px 0' } });
  const actionBar = h('div', { class: 'selection-bar', hidden: true });
  app.main.append(form, chips, toolbar, list, more, actionBar);

  const key = (r) => (st.mode === 'notes' ? r.note.id : r.card.id);
  const timing = col.timing();

  async function run() {
    modeBtn.textContent = st.mode === 'cards' ? '🂠' : '📝';
    modeBtn.title = st.mode === 'cards' ? 'Showing cards (tap for notes)' : 'Showing notes (tap for cards)';
    info.textContent = 'Searching…';
    let results;
    try { results = await searchCards(col, st.query); }
    catch (e) { info.textContent = `Search error: ${e.message}`; return; }
    if (st.mode === 'notes') {
      const seen = new Map();
      for (const r of results) {
        const prev = seen.get(r.note.id);
        if (!prev || r.card.ord < prev.card.ord) seen.set(r.note.id, { ...r, count: (prev?.count || 0) + 1 });
        else prev.count++;
      }
      results = [...seen.values()];
    }
    st.results = results;
    st.selected.clear();
    st.shown = PAGE;
    sortResults();
    draw();
  }

  function sortResults() {
    const [, cmp] = SORTS[st.sort] || SORTS.sfld;
    if (st.sort === 'due') st.results.sort((a, b) => dueKey(a.card) - dueKey(b.card));
    else if (st.sort === 'r') st.results.sort((a, b) => (cardRetrievability(a.card, timing, col) ?? 2) - (cardRetrievability(b.card, timing, col) ?? 2));
    else st.results.sort(cmp);
  }
  const dueKey = (c) => (c.type === 0 ? 1e12 + c.due : c.queue === 1 ? (c.due * 1000 - timing.now) / 86400000 + timing.today : c.odid && c.odue ? c.odue : c.due) + (c.queue < 0 ? 1e13 : 0);

  function dueText(c) {
    const susp = c.queue === -1 ? ' (suspended)' : c.queue === -2 || c.queue === -3 ? ' (buried)' : '';
    if (c.type === 0) return `New #${c.odid ? c.odue : c.due}${susp}`;
    if (c.queue === 1) return `${new Date(c.due * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${susp}`;
    const day = c.odid && c.odue ? c.odue : c.due;
    return `${fmtDate(dayToDate(day, col.col.crt).getTime())}${susp}`;
  }

  function draw() {
    const n = st.results.length;
    info.textContent = `${n} ${st.mode === 'notes' ? 'note' : 'card'}${n === 1 ? '' : 's'}${st.selected.size ? ` · ${st.selected.size} selected` : ''}`;
    selectAll.checked = n > 0 && st.selected.size === n;
    selectAll.indeterminate = st.selected.size > 0 && st.selected.size < n;
    list.replaceChildren(...st.results.slice(0, st.shown).map(row));
    if (!n) list.replaceChildren(h('li', { class: 'list-row muted' }, 'No matches.'));
    more.replaceChildren(n > st.shown ? h('button', { class: 'btn', type: 'button', onclick: () => { st.shown += PAGE * 2; draw(); } }, `Show more (${n - st.shown} left)`) : '');
    drawActions();
  }

  function row(r) {
    const c = r.card, nt = col.notetypes.get(r.note.ntid);
    const deck = col.decks.get(c.did);
    const k = key(r);
    const cb = h('input', { type: 'checkbox', checked: st.selected.has(k), 'aria-label': `Select ${r.note.sfld.slice(0, 40)}` });
    cb.addEventListener('change', () => { if (cb.checked) st.selected.add(k); else st.selected.delete(k); draw(); });
    const flag = c.flags & 7;
    const meta = st.mode === 'notes'
      ? [nt?.name, `${r.count} card${r.count === 1 ? '' : 's'}`, r.note.tags.slice(0, 4).join(' ')]
      : [deck?.name.split('::').pop() + (c.odid ? ` (${col.decks.get(c.odid)?.name.split('::').pop() || ''})` : ''), dueText(c), c.ivl && c.type !== 0 ? fmtInterval(c.ivl * 86400) : null, nt?.kind === 1 ? `c${c.ord + 1}` : nt?.templates.length > 1 ? nt.templates.find((t) => t.ord === c.ord)?.name : null];
    return h('li', { class: `list-row browse-row${c.queue === -1 ? ' suspended' : ''}` },
      cb,
      h('a', { class: 'browse-main', href: `#/edit/${r.note.id}?back=${encodeURIComponent(`/browse?q=${encodeURIComponent(st.query)}`)}` },
        h('span', { class: 'browse-title' }, flag ? h('span', { class: 'flag-dot', style: { background: `var(--flag${flag})`, marginRight: '6px' } }) : null, r.note.sfld || '(empty)'),
        h('span', { class: 'small muted browse-meta' }, meta.filter(Boolean).join(' · '))));
  }

  function selectedCards() {
    return st.results.filter((r) => st.selected.has(key(r)));
  }
  async function cardsOfSelection() {
    if (st.mode === 'cards') return selectedCards().map((r) => r.card);
    const out = [];
    for (const r of selectedCards()) out.push(...(await col.cardsOfNote(r.note.id)));
    return out;
  }

  function drawActions() {
    actionBar.hidden = st.selected.size === 0;
    if (actionBar.hidden) { document.body.classList.remove('selecting'); return; }
    document.body.classList.add('selecting');
    actionBar.replaceChildren(h('div', { class: 'inner row' },
      h('span', { class: 'small spacer' }, `${st.selected.size} selected`),
      h('button', { class: 'btn', type: 'button', onclick: async () => { const e = await suspendCards(col, await cardsOfSelection()); toast(e.label === 'Suspend' ? 'Suspended' : 'Unsuspended'); run(); } }, 'Suspend'),
      h('button', { class: 'btn', type: 'button', onclick: changeDeck }, 'Deck…'),
      h('button', { class: 'btn primary', type: 'button', onclick: moreActions }, 'More…')));
  }

  async function changeDeck() {
    const decks = [...col.decks.values()].filter((d) => !d.dyn).sort((a, b) => a.name.localeCompare(b.name));
    const did = await sheet('Move to deck', (close) => h('div', { class: 'menu-list' },
      decks.map((d) => h('button', { type: 'button', onclick: () => close(d.id) }, d.name.replaceAll('::', ' › ')))));
    if (!did) return;
    const cards = (await cardsOfSelection()).map((c) => (c.odid ? { ...c, odid: did } : { ...c, did }));
    await col.putCards(cards);
    toast(`Moved ${cards.length} card${cards.length === 1 ? '' : 's'}`);
    run();
  }

  async function editTags(add) {
    const v = await promptDialog(add ? 'Add tags' : 'Remove tags', { label: 'Tags (space-separated)', ok: add ? 'Add' : 'Remove' });
    if (!v?.trim()) return;
    const tags = normaliseTags(v);
    const nids = new Set(selectedCards().map((r) => r.note.id));
    const notes = (await col.allNotes()).filter((n) => nids.has(n.id));
    const lower = new Set(tags.map((t) => t.toLowerCase()));
    const now = Date.now();
    for (const n of notes) {
      n.tags = add ? normaliseTags([...n.tags, ...tags]) : n.tags.filter((t) => !lower.has(t.toLowerCase()));
      n.mod = now;
    }
    await col.putMany('notes', notes);
    toast(`${add ? 'Tagged' : 'Untagged'} ${notes.length} note${notes.length === 1 ? '' : 's'}`);
    run();
  }

  async function moreActions() {
    await menuSheet(`${st.selected.size} selected`, [
      { label: 'Flag…', icon: '⚑', onClick: async () => {
        const f = await sheet('Flag', (close) => h('div', { class: 'flags' }, FLAG_NAMES.map((name, i) => h('button', { type: 'button', onclick: () => close(i) }, i ? h('span', { class: 'flag-dot', style: { background: `var(--flag${i})` } }) : null, name))));
        if (f === undefined) return;
        await flagCards(col, await cardsOfSelection(), f); run();
      } },
      { label: 'Add tags…', icon: '#', onClick: () => editTags(true) },
      { label: 'Remove tags…', icon: '#', onClick: () => editTags(false) },
      { label: 'Bury until tomorrow', icon: '⤓', onClick: async () => { await buryCards(col, await cardsOfSelection()); toast('Buried'); run(); } },
      { label: 'Reset to new', icon: '↺', onClick: async () => {
        const cards = await cardsOfSelection();
        if (!(await confirmDialog('Reset to new?', `${cards.length} card${cards.length === 1 ? '' : 's'} will lose their progress (review history is kept).`, { ok: 'Reset', danger: true }))) return;
        await forgetCards(col, cards); toast('Reset to new'); run();
      } },
      { label: 'Set due date…', icon: '📅', onClick: async () => {
        const v = await promptDialog('Set due date', { label: 'Due in how many days?', value: '0', hint: '0 = today, 1 = tomorrow, 3-7 = random in range. Add ! to also set the interval.' });
        if (v === undefined) return;
        try { await setDueDate(col, await cardsOfSelection(), v); toast('Due date set'); run(); } catch (e) { toast(e.message); }
      } },
      { label: 'Reposition new cards…', icon: '↕', onClick: async () => {
        const v = await promptDialog('Reposition new cards', { label: 'Start position', value: '1', inputmode: 'numeric', hint: 'Selected new cards are numbered from here, in their current order.' });
        const start = parseInt(v, 10);
        if (!Number.isFinite(start)) return;
        await repositionNew(col, await cardsOfSelection(), start, 1); toast('Repositioned'); run();
      } },
      { label: 'Study these in a filtered deck', icon: '▶', onClick: () => filteredFromSearch() },
      { label: 'Delete notes', icon: '🗑', onClick: async () => {
        const nids = [...new Set(selectedCards().map((r) => r.note.id))];
        if (!(await confirmDialog('Delete notes?', `${nids.length} note${nids.length === 1 ? '' : 's'} and all their cards and review history will be deleted. This cannot be undone.`, { ok: 'Delete', danger: true }))) return;
        await col.deleteNotes(nids); toast('Deleted'); run();
      } },
    ]);
  }

  async function filteredFromSearch() {
    const ids = st.mode === 'cards' ? selectedCards().map((r) => r.card.id) : (await cardsOfSelection()).map((c) => c.id);
    const res = await sheet('Filtered deck', (close) => {
      const name = h('input', { class: 'input', value: 'Filtered Deck 1' });
      const order = h('select', { class: 'input' }, Object.entries(ORDERS).map(([k, v]) => h('option', { value: k }, v)));
      const resched = h('input', { type: 'checkbox', checked: true });
      return h('form', { onsubmit: (e) => { e.preventDefault(); close({ name: name.value.trim() || 'Filtered Deck 1', order: order.value, resched: resched.checked }); } },
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Order'), order),
        h('label', { class: 'switch' }, h('span', {}, 'Reschedule cards based on my answers', h('span', { class: 'hint-text', style: { display: 'block' } }, 'Off: cram without changing when cards are due.')), resched),
        h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Build')));
    });
    if (!res) return;
    try {
      const { deck, count } = await createFiltered(col, { ...res, search: `cid:${ids.join(',')}`, limit: ids.length });
      toast(`${count} card${count === 1 ? '' : 's'} in “${deck.name}”`);
      app.go(`/deck/${deck.id}`);
    } catch (e) { toast(e.message); }
  }

  async function searchHelp() {
    const rows = [
      ['dog cat', 'notes containing both words'], ['"a phrase"', 'exact phrase'], ['dog or cat', 'either'], ['-cat', 'without “cat”'],
      ['d*g / d_g', 'wildcards: any text / one character'], ['deck:French', 'deck and its subdecks'], ['tag:verbs', 'tag (and child tags); tag:none'],
      ['note:Basic', 'note type'], ['card:2', 'second card type / cloze 2'], ['Front:dog', 'search one field'],
      ['is:due is:new is:learn is:review', 'card state'], ['is:suspended is:buried', ''], ['flag:1', 'red flag (0 = none)'],
      ['prop:ivl>=30', 'interval; also due, reps, lapses, ease, s, d, r'], ['added:7', 'added in the last 7 days'],
      ['rated:1:1', 'answered Again today'], ['introduced:7', 'first studied in the last 7 days'], ['edited:1', 'edited today'], ['re:^\\d+$', 'regular expression'],
    ];
    await sheet('Search syntax', h('table', { class: 'info' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, h('code', {}, k)), h('td', {}, v))))));
  }

  await run();
  return () => document.body.classList.remove('selecting');
}

function localGet(k) { try { return localStorage.getItem(`ankipwa.${k}`); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(`ankipwa.${k}`, v); } catch {} }

