// Deck overview: today's counts, Study now, and "Study more" (extra new / review cards today).

import { h, sheet, toast } from './components.js';
import { deckCounts, nextLearningDue } from '../sched/queue.js';

export async function render(app, [idStr]) {
  const col = app.col;
  const did = Number(idStr);
  const deck = col.decks.get(did);
  if (!deck) return app.go('/');
  app.setTitle(deck.name.split('::').pop());
  app.setBack('/');
  app.setActions(h('a', { class: 'icon-btn', href: `#/options/${did}`, 'aria-label': 'Deck options', title: 'Deck options' }, '⚙'));

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
    h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
      h('button', { class: 'btn', type: 'button', onclick: () => studyMore(app, did) }, 'Study more'),
      h('a', { class: 'btn', href: `#/add?did=${did}` }, 'Add card')),
    h('p', { class: 'small muted', style: { marginTop: '16px' } },
      `${preset.scheduler === 'fsrs' ? `FSRS · retention ${Math.round(preset.retention * 100)}%` : 'SM-2'} · ${preset.newPerDay} new / ${preset.revPerDay} reviews a day · preset “${preset.name}”`)
  );
  app.main.append(box);
}

async function studyMore(app, did) {
  const col = app.col;
  await sheet('Study more today', (close) => {
    const newIn = h('input', { class: 'input', type: 'number', min: '0', max: '9999', value: '10', inputmode: 'numeric' });
    const revIn = h('input', { class: 'input', type: 'number', min: '0', max: '9999', value: '0', inputmode: 'numeric' });
    return h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const n = Math.max(0, parseInt(newIn.value, 10) || 0);
        const r = Math.max(0, parseInt(revIn.value, 10) || 0);
        if (n) await col.addExtraToday(did, 'n', n);
        if (r) await col.addExtraToday(did, 'r', r);
        close(true);
        toast(`Today's limits raised by ${n} new and ${r} review cards.`);
        app.go(`/deck/${did}`);
      },
    },
      h('p', { class: 'small muted' }, 'Raise today’s limits for this deck. Custom study and cramming of weak cards come in a later update.'),
      h('label', { class: 'field' }, h('span', {}, 'Extra new cards today'), newIn),
      h('label', { class: 'field' }, h('span', {}, 'Extra review cards today (overdue beyond the limit)'), revIn),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Apply')));
  });
}
