// Deck overview: today's counts, Study now, custom study (extra limits, forgotten cards,
// review ahead, preview new, by tag, weak cards) and filtered-deck controls.

import { h, sheet, toast, confirmDialog } from './components.js';
import { deckCounts, nextLearningDue } from '../sched/queue.js';
import { createFiltered, rebuildFiltered, emptyFiltered, customStudySearch, CUSTOM_STUDY_NAME } from '../sched/filtered.js';

export async function render(app, [idStr]) {
  const col = app.col;
  const did = Number(idStr);
  const deck = col.decks.get(did);
  if (!deck) return app.go('/');
  app.setTitle(deck.name.split('::').pop());
  app.setBack('/');
  app.setActions(
    h('a', { class: 'icon-btn', href: deck.dyn ? '#/stats' : `#/stats?did=${did}`, 'aria-label': 'Statistics', title: 'Statistics' }, '📊'),
    deck.dyn ? null : h('a', { class: 'icon-btn', href: `#/options/${did}`, 'aria-label': 'Deck options', title: 'Deck options' }, '⚙'));

  await col.rolloverIfNeeded();
  const c = await deckCounts(col, did);
  const total = c.n + c.l + c.r;
  const preset = col.presetFor(did);
  const nextLrn = await nextLearningDue(col, did);

  const box = h('div', { class: 'overview card-surface' },
    deck.name.includes('::') ? h('p', { class: 'small muted', style: { margin: 0 } }, deck.name.split('::').slice(0, -1).join(' › ')) : null,
    h('h2', { style: { margin: '4px 0 0', fontSize: '1.4rem' } }, deck.name.split('::').pop()),
    deck.desc ? h('div', { class: 'small muted', html: deck.desc.replace(/<script[\s\S]*?<\/script>/gi, '') }) : null,
    h('div', { class: 'big-counts' },
      h('div', {}, h('b', { style: { color: 'var(--new)' } }, String(c.n)), h('small', {}, 'New')),
      h('div', {}, h('b', { style: { color: 'var(--learn)' } }, String(c.l)), h('small', {}, 'Learning')),
      h('div', {}, h('b', { style: { color: 'var(--review)' } }, String(c.r)), h('small', {}, 'To review'))),
    total
      ? h('a', { class: 'btn primary block', href: `#/review/${did}`, style: { minHeight: '52px', fontSize: '1.05rem' } }, 'Study now')
      : h('div', {},
          h('p', { style: { fontWeight: 600, margin: '0 0 4px' } }, 'Congratulations! You have finished this deck for now.'),
          nextLrn ? h('p', { class: 'small muted', style: { margin: 0 } }, `A learning card is due at ${new Date(nextLrn * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`) : null),
    deck.dyn
      ? h('div', {},
          h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
            h('button', { class: 'btn', type: 'button', onclick: async () => { const n = await rebuildFiltered(col, did); toast(`Rebuilt: ${n} card${n === 1 ? '' : 's'}`); app.go(`/deck/${did}`); } }, 'Rebuild'),
            h('button', { class: 'btn', type: 'button', onclick: async () => { const n = await emptyFiltered(col, did); toast(`${n} card${n === 1 ? '' : 's'} returned to their decks`); app.go(`/deck/${did}`); } }, 'Empty'),
            h('button', { class: 'btn danger', type: 'button', onclick: async () => {
              if (!(await confirmDialog('Delete filtered deck?', 'Its cards go back to their original decks; nothing is lost.', { ok: 'Delete' }))) return;
              await col.deleteDeck(did); toast('Filtered deck deleted'); app.go('/');
            } }, 'Delete')),
          h('p', { class: 'small muted', style: { marginTop: '16px' } },
            `Filtered deck · search: ${deck.terms?.search || ''} · ${deck.resched === false ? 'preview: answers don’t change scheduling' : 'answers reschedule cards'}`))
      : h('div', {},
          h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
            h('button', { class: 'btn', type: 'button', onclick: () => customStudy(app, deck) }, 'Custom study'),
            h('a', { class: 'btn', href: `#/add?did=${did}` }, 'Add card'),
            h('a', { class: 'btn', href: `#/browse?q=${encodeURIComponent(`deck:"${deck.name}"`)}` }, 'Browse')),
          h('p', { class: 'small muted', style: { marginTop: '16px' } },
            `${preset.scheduler === 'fsrs' ? `FSRS · retention ${Math.round(preset.retention * 100)}%` : 'SM-2'} · ${preset.newPerDay} new / ${preset.revPerDay} reviews a day · preset “${preset.name}”`))
  );
  app.main.append(box);
}

async function customStudy(app, deck) {
  const col = app.col;
  const did = deck.id;
  const options = [
    ['new', 'Increase today’s new card limit'],
    ['rev', 'Increase today’s review limit'],
    ['forgotten', 'Review forgotten cards'],
    ['ahead', 'Review ahead'],
    ['preview', 'Preview new cards'],
    ['tags', 'Study by card state or tag'],
    ['weak', 'Weak cards (lowest recall chance first)'],
  ];
  await sheet('Custom study', (close) => {
    let kind = 'new';
    const form = h('form');
    const body = h('div');
    const radios = h('fieldset', { class: 'choice' }, h('legend', { class: 'sr-only' }, 'What to study'),
      options.map(([v, label]) => {
        const r = h('input', { type: 'radio', name: 'cs', value: v, checked: v === kind });
        r.addEventListener('change', () => { kind = v; draw(); });
        return h('label', { class: 'switch' }, h('span', {}, label), r);
      }));
    const num = (label, value, hint) => {
      const input = h('input', { class: 'input', type: 'number', min: '1', max: '9999', value: String(value), inputmode: 'numeric' });
      return [h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('p', { class: 'hint-text' }, hint) : null), input];
    };
    let read = () => ({});
    const draw = () => {
      body.replaceChildren();
      if (kind === 'new' || kind === 'rev') {
        const [el, input] = num(kind === 'new' ? 'Extra new cards today' : 'Extra review cards today', kind === 'new' ? 10 : 50);
        body.append(el);
        read = () => ({ n: parseInt(input.value, 10) || 0 });
      } else if (kind === 'forgotten' || kind === 'ahead' || kind === 'preview') {
        const label = { forgotten: 'Cards you pressed Again on in the last … days', ahead: 'Cards due in the next … days', preview: 'Cards added in the last … days' }[kind];
        const [el, input] = num(label, kind === 'ahead' ? 3 : 1);
        const [lim, limIn] = num('At most this many cards', 100);
        body.append(el, lim);
        read = () => ({ days: parseInt(input.value, 10) || 1, limit: parseInt(limIn.value, 10) || 100 });
      } else if (kind === 'tags') {
        const state = h('select', { class: 'input' }, [['due', 'Due cards'], ['new', 'New cards (random)'], ['review', 'All review cards (random)'], ['all', 'All cards (random)']].map(([v, l]) => h('option', { value: v }, l)));
        const tags = h('input', { class: 'input', placeholder: 'optional: tags, space-separated', autocapitalize: 'off' });
        const resched = h('input', { type: 'checkbox', checked: true });
        const [lim, limIn] = num('At most this many cards', 100);
        body.append(h('label', { class: 'field' }, h('span', {}, 'Cards'), state), h('label', { class: 'field' }, h('span', {}, 'Only with these tags'), tags), lim,
          h('label', { class: 'switch' }, h('span', {}, 'Reschedule cards based on my answers', h('span', { class: 'hint-text', style: { display: 'block' } }, 'Off: cram without changing when cards are due.')), resched));
        read = () => ({ state: state.value, tags: tags.value, limit: parseInt(limIn.value, 10) || 100, resched: resched.checked });
      } else if (kind === 'weak') {
        const [lim, limIn] = num('How many cards', 50, 'Review cards whose predicted recall (FSRS) is lowest, in that order.');
        body.append(lim);
        read = () => ({ limit: parseInt(limIn.value, 10) || 50 });
      }
    };
    draw();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = read();
      if (kind === 'new' || kind === 'rev') {
        await col.addExtraToday(did, kind === 'new' ? 'n' : 'r', Math.max(0, v.n));
        close(true);
        toast(`Today's ${kind === 'new' ? 'new card' : 'review'} limit raised by ${v.n}.`);
        app.go(`/deck/${did}`);
        return;
      }
      const search = customStudySearch(deck.name, kind, v);
      const order = { forgotten: 'random', ahead: 'due', preview: 'added', tags: v.state === 'due' ? 'due' : 'random', weak: 'retrievability' }[kind];
      try {
        const { deck: f, count } = await createFiltered(col, { name: CUSTOM_STUDY_NAME, search, limit: v.limit, order, resched: kind === 'preview' ? false : v.resched ?? true });
        close(true);
        if (!count) { toast('No cards matched.'); app.go(`/deck/${f.id}`); return; }
        toast(`${count} card${count === 1 ? '' : 's'} in “${f.name}”`);
        app.go(`/review/${f.id}`);
      } catch (err) { toast(err.message); }
    });
    form.append(radios, body, h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'OK')));
    return form;
  });
}

