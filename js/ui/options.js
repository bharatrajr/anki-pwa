// Deck options presets (like Anki): limits, FSRS / SM-2, steps, burying, leeches.

import { h, toast, promptDialog, confirmDialog } from './components.js';
import { DEFAULT_PRESET_ID } from '../db/collection.js';
import { DEFAULT_PARAMS, normaliseParams } from '../sched/fsrs.js';

/** "1m 10m 1h 1d" or "1 10" → minutes. */
export function parseSteps(text) {
  const out = [];
  for (const tok of String(text || '').trim().split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(tok);
    if (!m) throw new Error(`“${tok}” is not a valid step. Use values like 1m 10m 1h 1d.`);
    const v = parseFloat(m[1]);
    const unit = (m[2] || 'm').toLowerCase();
    const mins = unit === 's' ? v / 60 : unit === 'h' ? v * 60 : unit === 'd' ? v * 1440 : v;
    if (mins <= 0) throw new Error('Steps must be greater than zero.');
    out.push(mins);
  }
  return out;
}
export function formatSteps(steps) {
  return (steps || []).map((m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : m < 1 ? `${Math.round(m * 60)}s` : `${m}m`)).join(' ');
}

export async function render(app, [idStr]) {
  const col = app.col;
  const deck = col.decks.get(Number(idStr));
  if (!deck) return app.go('/');
  app.setTitle('Deck options');
  app.setBack(`/deck/${deck.id}`);

  let preset = { ...col.presetFor(deck.id) };
  const container = h('div');
  app.main.append(h('p', { class: 'small muted', style: { margin: '0 4px 8px' } }, deck.name.replaceAll('::', ' › ')), container);

  const num = (key, label, { min = 0, max = 99999, step = 1, hint } = {}) => {
    const input = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step: String(step), value: String(preset[key]), inputmode: step < 1 ? 'decimal' : 'numeric' });
    input.addEventListener('change', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) preset[key] = Math.min(max, Math.max(min, v)); });
    return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('p', { class: 'hint-text' }, hint) : null);
  };
  const toggle = (key, label, hint) => {
    const input = h('input', { type: 'checkbox', checked: !!preset[key] });
    input.addEventListener('change', () => { preset[key] = input.checked; });
    return h('label', { class: 'switch' }, h('span', {}, label, hint ? h('span', { class: 'hint-text', style: { display: 'block' } }, hint) : null), input);
  };
  const steps = (key, label, hint) => {
    const input = h('input', { class: 'input', value: formatSteps(preset[key]), autocomplete: 'off', autocapitalize: 'off' });
    input.addEventListener('change', () => {
      try { preset[key] = parseSteps(input.value); input.setCustomValidity(''); }
      catch (e) { input.setCustomValidity(e.message); input.reportValidity(); }
    });
    return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('p', { class: 'hint-text' }, hint) : null);
  };
  const section = (title, ...kids) => h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface', style: { padding: '4px 14px' } }, ...kids));

  function draw() {
    const presetSelect = h('select', { class: 'input', 'aria-label': 'Preset' },
      [...col.presets.values()].map((p) => {
        const used = [...col.decks.values()].filter((d) => d.presetId === p.id).length;
        return h('option', { value: String(p.id), selected: p.id === preset.id }, `${p.name} (used by ${used} deck${used === 1 ? '' : 's'})`);
      }));
    presetSelect.addEventListener('change', () => { preset = { ...col.presets.get(Number(presetSelect.value)) }; draw(); });

    const sched = h('select', { class: 'input' },
      h('option', { value: 'fsrs', selected: preset.scheduler === 'fsrs' }, 'FSRS (recommended)'),
      h('option', { value: 'sm2', selected: preset.scheduler === 'sm2' }, 'SM-2 (Anki legacy)'));
    sched.addEventListener('change', () => { preset.scheduler = sched.value; draw(); });

    const retOut = h('output', {}, `${Math.round(preset.retention * 100)}%`);
    const ret = h('input', { type: 'range', min: '0.80', max: '0.97', step: '0.01', value: String(preset.retention), style: { width: '100%', minHeight: '44px', accentColor: 'var(--accent)' }, 'aria-label': 'Desired retention' });
    ret.addEventListener('input', () => { preset.retention = parseFloat(ret.value); retOut.textContent = `${Math.round(preset.retention * 100)}%`; });

    const params = h('textarea', { class: 'input', rows: 3, style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }, placeholder: DEFAULT_PARAMS.join(', ') }, preset.fsrsParams ? preset.fsrsParams.join(', ') : '');
    params.addEventListener('change', () => {
      const t = params.value.trim();
      if (!t) { preset.fsrsParams = null; return; }
      const arr = t.split(/[\s,]+/).map(Number);
      if (arr.some((x) => !Number.isFinite(x)) || ![17, 19, 21].includes(arr.length)) { toast('FSRS parameters must be 17, 19 or 21 numbers.'); return; }
      preset.fsrsParams = normaliseParams(arr);
    });

    const leechAction = h('select', { class: 'input' },
      h('option', { value: 'tag', selected: preset.leechAction === 'tag' }, 'Tag only'),
      h('option', { value: 'suspend', selected: preset.leechAction === 'suspend' }, 'Suspend card'));
    leechAction.addEventListener('change', () => { preset.leechAction = leechAction.value; });

    const desc = h('textarea', { class: 'input', rows: 2 }, deck.desc || '');

    const fsrs = preset.scheduler === 'fsrs';
    container.replaceChildren(
      section('Preset',
        h('label', { class: 'field' }, h('span', {}, 'This deck uses'), presetSelect),
        h('div', { class: 'row', style: { marginBottom: '10px' } },
          h('button', { class: 'btn', type: 'button', onclick: async () => { const n = await promptDialog('New preset', { label: 'Name', value: 'New preset', ok: 'Create' }); if (n?.trim()) { preset = { ...(await col.addPreset(n.trim(), preset)) }; draw(); } } }, 'Add'),
          h('button', { class: 'btn', type: 'button', onclick: async () => { const n = await promptDialog('Rename preset', { label: 'Name', value: preset.name, ok: 'Rename' }); if (n?.trim()) { preset.name = n.trim(); draw(); } } }, 'Rename'),
          preset.id !== DEFAULT_PRESET_ID ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
            if (!(await confirmDialog('Delete preset?', 'Decks using it will switch to the Default preset.', { ok: 'Delete', danger: true }))) return;
            await col.deletePreset(preset.id); preset = { ...col.presetFor(deck.id) }; draw();
          } }, 'Delete') : null)),
      section('Daily limits',
        num('newPerDay', 'New cards per day', { max: 9999 }),
        num('revPerDay', 'Maximum reviews per day', { max: 99999 })),
      section('Scheduler',
        h('label', { class: 'field' }, h('span', {}, 'Algorithm'), sched),
        fsrs ? h('div', { class: 'field' }, h('span', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' } }, 'Desired retention', retOut), ret,
          h('p', { class: 'hint-text' }, 'The chance you still remember a card when it comes due. Higher means more reviews. 90% suits most people.')) : null,
        fsrs ? h('details', { class: 'field' }, h('summary', { style: { minHeight: '44px', display: 'flex', alignItems: 'center', cursor: 'pointer' } }, 'FSRS parameters (advanced)'),
          params, h('p', { class: 'hint-text' }, 'Leave empty for the FSRS-6 defaults. You can paste parameters optimised in Anki (Deck options → FSRS → Optimize). This app does not optimise them itself.')) : null,
        toggle('fuzz', 'Interval fuzz', 'Spread reviews out slightly so cards added together don’t stay together.'),
        num('maxIvl', 'Maximum interval (days)', { min: 1, max: 36500 })),
      section('Learning',
        steps('learnSteps', 'Learning steps', 'e.g. 1m 10m. Blank = graduate straight away.'),
        steps('relearnSteps', 'Relearning steps', 'e.g. 10m. Used after you press Again on a review.'),
        fsrs ? null : num('gradIvl', 'Graduating interval (days)', { min: 1, max: 36500 }),
        fsrs ? null : num('easyIvl', 'Easy interval (days)', { min: 1, max: 36500 })),
      fsrs ? null : section('SM-2 advanced',
        num('startingEase', 'Starting ease', { min: 1.31, max: 5, step: 0.01 }),
        num('easyBonus', 'Easy bonus', { min: 1, max: 5, step: 0.01 }),
        num('hardMult', 'Hard interval', { min: 0.5, max: 1.3, step: 0.01 }),
        num('ivlMod', 'Interval modifier', { min: 0.5, max: 2, step: 0.01 }),
        num('lapseMult', 'New interval after lapse', { min: 0, max: 1, step: 0.01 }),
        num('minLapseIvl', 'Minimum interval after lapse (days)', { min: 1, max: 365 })),
      section('Burying',
        toggle('buryNew', 'Bury new siblings', 'Other new cards of the same note wait until tomorrow.'),
        toggle('buryRev', 'Bury review siblings'),
        toggle('buryInterday', 'Bury interday learning siblings')),
      section('Leeches',
        num('leechThreshold', 'Leech threshold (lapses)', { min: 1, max: 99 }),
        h('label', { class: 'field' }, h('span', {}, 'Leech action'), leechAction)),
      section('Deck description', h('label', { class: 'field' }, h('span', { class: 'sr-only' }, 'Description'), desc)),
      h('div', { class: 'sticky-actions' }, h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
        const saved = await col.savePreset(preset);
        deck.presetId = saved.id;
        deck.desc = desc.value;
        await col.saveDeck(deck);
        toast('Options saved');
        app.go(`/deck/${deck.id}`);
      } }, 'Save'))
    );
  }
  draw();
}
