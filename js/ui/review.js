// Review screen: front → show answer → grade. Tap card to flip; keyboard shortcuts;
// search chip; flag/bury/suspend/reset/set due; card info; multi-level undo.

import { h, toast, menuSheet, sheet, promptDialog, confirmDialog, FLAG_NAMES } from './components.js';
import {
  nextCard, deckCounts, previewOutcomes, answerCard, undo, UndoStack, suspendCards, buryCards, flagCards,
  forgetCards, setDueDate, schedContext, nextLearningDue, previewDeckOf, Q,
} from '../sched/queue.js';
import { speak, stopSpeaking, listenFor, keepAwake, ttsSupported, recognitionSupported } from '../speech/speech.js';
import { currentRetrievability, REVLOG } from '../sched/scheduler.js';
import { renderCard, showInFrame, fitFrame } from '../render/card.js';
import { fmtInterval, fmtDate, dayToDate } from '../util/time.js';

// Undo history survives leaving and re-entering the review screen during a session.
export const undoStack = new UndoStack(50);

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

export async function render(app, [idStr]) {
  const col = app.col;
  const did = Number(idStr);
  const deck = col.decks.get(did);
  if (!deck) return app.go('/');
  document.body.classList.add('reviewing');
  app.setTitle(deck.name.split('::').pop());
  app.setBack(`/deck/${did}`);

  const mediaUrls = new Map();
  const getMediaUrl = async (name) => {
    if (mediaUrls.has(name)) return mediaUrls.get(name);
    const rec = await col.getMedia(name);
    const url = rec ? URL.createObjectURL(rec.blob) : null;
    mediaUrls.set(name, url);
    return url;
  };
  const audio = new Audio();

  const state = { card: null, note: null, nt: null, rendered: null, revealed: false, shownAt: 0, outcomes: null, kind: '', busy: false, waitTimer: null, typed: '', seq: 0, listener: null, revealTimer: null };
  const speech = col.settings.tts;
  const voice = col.settings.voice;

  const undoBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Undo', title: 'Undo (u)', onclick: () => doUndo() }, '↶');
  const menuBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Card actions', title: 'More', onclick: () => cardMenu() }, '⋮');
  app.setActions(undoBtn, menuBtn);

  const countsEl = h('div', { class: 'review-counts', 'aria-live': 'polite' });
  const flagChip = h('span', { class: 'chip', hidden: true });
  const searchChip = h('button', {
    class: 'chip', type: 'button', title: 'Copy the question and search Google', 'aria-label': 'Search the question on Google',
    onclick: (e) => { e.stopPropagation(); searchQuestion(); },
  }, h('span', { 'aria-hidden': 'true', html: SEARCH_ICON }), 'Search');
  const readChip = ttsSupported ? h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(!!speech.enabled), title: 'Read cards aloud',
    onclick: async (e) => { e.stopPropagation(); speech.enabled = !speech.enabled; await col.saveSettings(); syncChips(); if (speech.enabled) runSpeech(); else stopSpeaking(); },
  }, h('span', { 'aria-hidden': 'true' }, '🔊'), h('span', { class: 'chip-label' }, 'Read')) : null;
  const micChip = recognitionSupported ? h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(!!voice.enabled), title: 'Answer by voice: say “show”, then again / hard / good / easy',
    onclick: async (e) => { e.stopPropagation(); voice.enabled = !voice.enabled; await col.saveSettings(); syncChips(); if (voice.enabled) runSpeech(); else stopListening(); },
  }, h('span', { 'aria-hidden': 'true' }, '🎤'), h('span', { class: 'chip-label' }, 'Voice')) : null;
  const syncChips = () => {
    readChip?.setAttribute('aria-pressed', String(!!speech.enabled));
    micChip?.setAttribute('aria-pressed', String(!!voice.enabled));
    keepAwake(col.settings.keepAwake && (speech.enabled || voice.enabled));
  };
  syncChips();
  const topRow = h('div', { class: 'review-top' }, searchChip, readChip, micChip, flagChip, h('span', { class: 'spacer' }), h('span', { class: 'small muted', id: 'card-state' }));
  const frame = h('iframe', { class: 'card-frame', title: 'Card', sandbox: 'allow-same-origin', 'aria-live': 'polite' });
  const frameWrap = h('div', { class: 'card-frame-wrap' }, frame);
  const bar = h('div', { class: 'answer-bar' });
  const barInner = h('div', { class: 'inner' });
  bar.append(barInner);
  const content = h('div', {}, countsEl, topRow, frameWrap);
  app.main.append(content, bar);

  const onResize = () => fitFrame(frame);
  window.addEventListener('resize', onResize);
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => { if (state.card) showSide(); };
  darkMq.addEventListener('change', onScheme);

  // ---------- flow ----------
  async function loadNext(excludeId) {
    clearTimeout(state.waitTimer);
    const next = await nextCard(col, did, { exclude: excludeId ? new Set([excludeId]) : undefined });
    if (!next) return finished();
    const note = await col.getNote(next.card.nid);
    const nt = col.notetypes.get(note?.ntid);
    if (!note || !nt) {
      // Broken card (note or note type missing): skip it for this session.
      console.warn('Card without note/notetype', next.card);
      await col.putCards([{ ...next.card, queue: Q.USER_BURIED }]);
      return loadNext();
    }
    Object.assign(state, { card: next.card, kind: next.kind, note, nt, revealed: false, typed: '' });
    state.outcomes = previewOutcomes(col, state.card);
    await showSide();
    await updateCounts();
  }

  async function showSide() {
    const deckName = col.decks.get(state.card.did)?.name || '';
    state.rendered = renderCard({ card: state.card, note: state.note, notetype: state.nt, deckName, typed: state.typed });
    const html = state.revealed ? state.rendered.a : state.rendered.q;
    const doc = await showInFrame(frame, html, {
      css: state.rendered.css, night: app.isDark(), fontScale: col.settings.fontScale, cardOrd: state.card.ord, getMediaUrl,
    });
    wireFrame(doc);
    frameWrap.dataset.flag = String(state.card.flags & 7);
    flagChip.hidden = !(state.card.flags & 7);
    if (state.card.flags & 7) flagChip.replaceChildren(h('span', { class: 'flag-dot', style: { background: `var(--flag${state.card.flags & 7})` } }), FLAG_NAMES[state.card.flags & 7]);
    document.getElementById('card-state').textContent = ['New', 'Learning', 'Review', 'Relearning'][state.card.type] || '';
    renderBar();
    if (!state.revealed) state.shownAt = performance.now();
    runSpeech();
    const input = doc.getElementById('typeans');
    if (input && !state.revealed && matchMedia('(pointer: fine)').matches) input.focus();
  }

  function wireFrame(doc) {
    doc.addEventListener('click', (e) => {
      const t = e.target;
      const sound = t.closest?.('[data-sound]');
      if (sound) { e.preventDefault(); state.seq++; stopListening(); playAv([{ kind: 'sound', file: sound.getAttribute('data-sound') }]); return; }
      const tts = t.closest?.('[data-tts]');
      if (tts) {
        e.preventDefault(); state.seq++; stopListening();
        playAv([{ kind: 'tts', text: tts.getAttribute('data-tts'), lang: tts.getAttribute('data-tts-lang') || null, speed: parseFloat(tts.getAttribute('data-tts-speed')) || 1 }]);
        return;
      }
      const hint = t.closest?.('a.hint[data-hint]');
      if (hint) { e.preventDefault(); const d = doc.getElementById(hint.dataset.hint); if (d) { d.style.display = 'block'; hint.style.display = 'none'; fitFrame(frame); } return; }
      const link = t.closest?.('a[href]');
      if (link) { e.preventDefault(); const href = link.getAttribute('href'); if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener'); return; }
      if (t.closest?.('input, textarea, select, button, label')) return;
      if (!state.revealed) reveal();
    });
    doc.addEventListener('keydown', (e) => {
      if (e.target.id === 'typeans') {
        if (e.key === 'Enter') { e.preventDefault(); reveal(); }
        return;
      }
      onKey(e);
    });
  }

  function renderBar() {
    if (!state.revealed) {
      barInner.replaceChildren(h('button', { class: 'btn primary show-btn', type: 'button', onclick: () => reveal() }, 'Show answer'));
      return;
    }
    if (previewDeckOf(col, state.card)) {
      // Preview / cram without rescheduling: only "again" or "done".
      barInner.replaceChildren(h('div', { class: 'grades two', role: 'group', 'aria-label': 'Preview' },
        h('button', { class: 'grade again', type: 'button', 'aria-label': 'Show again later (key 1)', onclick: () => grade(1) }, h('small', {}, 'later'), 'Again'),
        h('button', { class: 'grade good', type: 'button', 'aria-label': 'Done, scheduling unchanged (key 3)', onclick: () => grade(3) }, h('small', {}, 'no change'), 'Done')));
      return;
    }
    const labels = ['Again', 'Hard', 'Good', 'Easy'];
    const cls = ['again', 'hard', 'good', 'easy'];
    const show = col.settings.showIntervals;
    barInner.replaceChildren(h('div', { class: 'grades', role: 'group', 'aria-label': 'Rate your answer' },
      labels.map((l, i) => {
        const ivl = fmtInterval(state.outcomes[i].seconds);
        return h('button', { class: `grade ${cls[i]}`, type: 'button', 'aria-label': `${l}, next in ${ivl} (key ${i + 1})`, onclick: () => grade(i + 1) },
          show ? h('small', {}, ivl) : null, l);
      })));
  }

  async function reveal() {
    if (state.revealed || !state.card) return;
    const input = frame.contentDocument?.getElementById('typeans');
    if (input) state.typed = input.value;
    state.revealed = true;
    await showSide();
  }

  async function grade(rating) {
    if (!state.revealed || state.busy || !state.card) return;
    state.busy = true;
    try {
      const elapsed = performance.now() - state.shownAt;
      const entry = await answerCard(col, state.card, rating, { timeMs: elapsed });
      entry.label = 'Answer';
      undoStack.push(entry);
      if (entry.leech) toast(col.presetFor(state.card.did).leechAction === 'suspend' ? 'Leech: card suspended and tagged “leech”.' : 'Leech: note tagged “leech”.');
      // Avoid showing the same learning card back-to-back when others are waiting.
      await loadNext(entry.cardAfter.queue === Q.LRN ? state.card.id : undefined);
    } catch (e) {
      console.error(e);
      toast(`Could not save: ${e.message || e}`);
    } finally {
      state.busy = false;
    }
  }

  async function doUndo() {
    const entry = undoStack.pop();
    if (!entry) return toast('Nothing to undo');
    await undo(col, entry);
    toast(`Undid ${(entry.label || 'answer').toLowerCase()}`);
    if (entry.kind === 'answer') {
      const card = await col.getCard(entry.cardBefore.id);
      const note = await col.getNote(card.nid);
      Object.assign(state, { card, note, nt: col.notetypes.get(note.ntid), revealed: false, typed: '' });
      state.outcomes = previewOutcomes(col, card);
      await showSide();
      await updateCounts();
    } else await loadNext();
  }

  async function updateCounts() {
    const c = await deckCounts(col, did);
    const cur = state.kind;
    countsEl.replaceChildren(
      h('span', { class: `n${cur === 'n' ? ' cur' : ''}`, 'aria-label': `${c.n} new` }, String(c.n)),
      h('span', { class: `l${cur === 'l' ? ' cur' : ''}`, 'aria-label': `${c.l} learning` }, String(c.l)),
      h('span', { class: `r${cur === 'r' ? ' cur' : ''}`, 'aria-label': `${c.r} to review` }, String(c.r)));
    undoBtn.disabled = undoStack.size === 0;
  }

  async function finished() {
    state.card = null;
    state.seq++;
    stopListening();
    clearTimeout(state.revealTimer);
    const nextLrn = await nextLearningDue(col, did);
    barInner.replaceChildren(h('a', { class: 'btn block', href: `#/deck/${did}` }, 'Back to deck'));
    content.replaceChildren(h('div', { class: 'empty card-surface' },
      h('h2', {}, 'Congratulations!'),
      h('p', {}, 'You have finished this deck for now.'),
      nextLrn ? h('p', { class: 'small muted' }, `More learning cards at ${new Date(nextLrn * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. This screen will continue automatically.`) : null,
      undoStack.size ? h('button', { class: 'btn', type: 'button', onclick: async () => { content.replaceChildren(countsEl, topRow, frameWrap); await doUndo(); } }, 'Undo last answer') : null));
    if (nextLrn) {
      const wait = Math.max(1000, nextLrn * 1000 - col.settings.learnAheadMins * 60000 - Date.now());
      state.waitTimer = setTimeout(async () => { content.replaceChildren(countsEl, topRow, frameWrap); await loadNext(); }, Math.min(wait, 2 ** 31 - 1));
    }
  }

  // ---------- audio: the card's sound files and TTS tags, in order ----------
  let avToken = 0;
  let finishFile = null;
  /** Play items ({kind:'sound', file} | {kind:'tts', text, lang, speed}); resolves when done or interrupted. */
  async function playAv(items) {
    const token = ++avToken;
    finishFile?.();
    audio.pause();
    for (const it of items) {
      if (token !== avToken) return;
      if (it.kind === 'sound') await playFile(it.file);
      else await speak(it.text, { lang: it.lang, voiceURI: speech.voiceURI, rate: speech.rate * (it.speed || 1) });
    }
  }
  async function playFile(name) {
    const url = await getMediaUrl(name);
    if (!url) { toast(`Missing audio: ${name}`); return; }
    await new Promise((resolve) => {
      finishFile = () => { finishFile = null; resolve(); };
      audio.src = url;
      audio.onended = audio.onerror = () => finishFile?.();
      audio.play().catch(() => finishFile?.()); // autoplay may be blocked until the first tap
    });
  }
  function stopAv() {
    avToken++;
    audio.pause();
    finishFile?.();
    stopSpeaking();
  }

  // ---------- read aloud, hands-free reveal, voice grading ----------
  function stopListening() {
    state.listener?.stop();
    state.listener = null;
    micChip?.classList.remove('live');
  }
  /**
   * The side's own audio/TTS (like Anki's autoplay), or else "read cards aloud", then
   * auto-reveal / listen for a command. Restarted on every side change, so nothing doubles up.
   */
  async function runSpeech() {
    const seq = ++state.seq;
    clearTimeout(state.revealTimer);
    stopListening();
    stopAv();
    if (!state.card || !state.rendered) return;
    const answerSide = state.revealed;
    const r = state.rendered;
    const own = answerSide ? r.aAv : r.qAv;
    if (own.length) {
      // A card with its own audio or {{tts}} speaks for itself; reading the text too would repeat it.
      if (speech.autoplay !== false) await playAv(own);
    } else if (speech.enabled && (!answerSide || speech.readAnswer)) {
      await speak(answerSide ? r.aText : r.qText, { voiceURI: speech.voiceURI, rate: speech.rate, lang: answerSide ? r.aLang : r.qLang });
    }
    if (seq !== state.seq) return;
    if (!answerSide && (speech.enabled || own.length) && speech.autoRevealSecs > 0) {
      state.revealTimer = setTimeout(() => { if (seq === state.seq && !state.revealed) reveal(); }, speech.autoRevealSecs * 1000);
    }
    if (voice.enabled && recognitionSupported) {
      const allowed = answerSide ? ['again', 'hard', 'good', 'easy', 'undo', 'repeat'] : ['show', 'undo', 'repeat'];
      micChip?.classList.add('live');
      state.listener = listenFor(allowed, {
        lang: voice.lang || 'en-US',
        onState: (st, msg) => {
          if (st === 'listening') micChip?.classList.add('live'); else micChip?.classList.remove('live');
          if (st === 'error') { toast(msg); voice.enabled = false; col.saveSettings(); syncChips(); }
        },
        onCommand: (cmd) => {
          if (seq !== state.seq) return;
          if (cmd === 'show') reveal();
          else if (cmd === 'undo') doUndo();
          else if (cmd === 'repeat') runSpeech();
          else grade({ again: 1, hard: 2, good: 3, easy: 4 }[cmd]);
        },
      });
    }
  }

  // ---------- search ----------
  async function searchQuestion() {
    if (!state.rendered) return;
    const q = state.rendered.searchText;
    if (!q) return toast('Nothing to search on this card');
    try { await navigator.clipboard.writeText(q); } catch {}
    window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener');
  }

  // ---------- menu actions ----------
  async function act(fn, msg) {
    const entry = await fn();
    if (entry) undoStack.push(entry);
    if (msg) toast(msg, { action: 'Undo', onAction: doUndo });
  }

  async function cardMenu() {
    if (!state.card) return;
    const c = state.card;
    await menuSheet('Card', [
      { label: 'Edit note', key: 'E', icon: '✎', onClick: editNote },
      { label: 'Flag…', key: 'Ctrl+1–7', icon: '⚑', onClick: flagMenu },
      { label: 'Bury card', key: '-', icon: '⤓', onClick: () => buryCurrent() },
      { label: 'Bury note', icon: '⤓', onClick: async () => { await act(async () => buryCards(col, await col.cardsOfNote(c.nid)), 'Note buried until tomorrow'); loadNext(); } },
      { label: 'Suspend card', key: '@', icon: '⏸', onClick: () => suspendCurrent() },
      { label: 'Suspend note', icon: '⏸', onClick: async () => { await act(async () => suspendCards(col, (await col.cardsOfNote(c.nid)).filter((x) => x.queue !== Q.SUSP)), 'Note suspended'); loadNext(); } },
      { label: 'Reset to new', icon: '↺', onClick: async () => { await act(() => forgetCards(col, [c]), 'Card reset to new'); loadNext(); } },
      { label: 'Set due date…', icon: '📅', onClick: async () => {
        const v = await promptDialog('Set due date', { label: 'Due in how many days?', value: '0', hint: '0 = today, 1 = tomorrow, 3-7 = random in range. Add ! to also set the interval.', inputmode: 'text' });
        if (v === undefined) return;
        try { await act(() => setDueDate(col, [c], v), 'Due date set'); loadNext(); } catch (e) { toast(e.message); }
      } },
      { label: 'Card info', key: 'I', icon: 'ℹ', onClick: () => cardInfo(app, c, state.note, state.nt) },
      { label: 'Delete note', icon: '🗑', onClick: async () => {
        if (!(await confirmDialog('Delete note?', 'This deletes the note and all its cards and review history. It cannot be undone.', { ok: 'Delete', danger: true }))) return;
        await col.deleteNotes([c.nid]);
        toast('Note deleted');
        loadNext();
      } },
    ]);
  }

  async function flagMenu() {
    await sheet('Flag', (close) => h('div', { class: 'flags' },
      FLAG_NAMES.map((name, i) => h('button', { type: 'button', onclick: async () => { close(); await setFlag(i); } },
        i ? h('span', { class: 'flag-dot', style: { background: `var(--flag${i})` } }) : null, name))));
  }
  async function setFlag(f) {
    if (!state.card) return;
    const flag = (state.card.flags & 7) === f ? 0 : f;
    await act(() => flagCards(col, [state.card], flag));
    state.card = await col.getCard(state.card.id);
    frameWrap.dataset.flag = String(flag);
    flagChip.hidden = !flag;
    if (flag) flagChip.replaceChildren(h('span', { class: 'flag-dot', style: { background: `var(--flag${flag})` } }), FLAG_NAMES[flag]);
  }
  async function buryCurrent() { await act(() => buryCards(col, [state.card]), 'Card buried until tomorrow'); loadNext(); }
  async function suspendCurrent() { await act(() => suspendCards(col, [state.card]), 'Card suspended'); loadNext(); }
  function editNote() { if (state.card) app.go(`/edit/${state.card.nid}?back=${encodeURIComponent(`/review/${did}`)}`); }

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if ((e.ctrlKey || e.metaKey) && /^[0-7]$/.test(e.key)) { e.preventDefault(); setFlag(Number(e.key)); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); if (!state.revealed) reveal(); else grade(3); }
    else if (/^[1-4]$/.test(k)) { if (state.revealed) { e.preventDefault(); grade(Number(k)); } }
    else if (k === 'u' || k === 'U') { e.preventDefault(); doUndo(); }
    else if (k === 'e' || k === 'E') { e.preventDefault(); editNote(); }
    else if (k === 'r' || k === 'R') { e.preventDefault(); runSpeech(); }
    else if (k === '-') { e.preventDefault(); buryCurrent(); }
    else if (k === '@') { e.preventDefault(); suspendCurrent(); }
    else if (k === 'i' || k === 'I') { e.preventDefault(); if (state.card) cardInfo(app, state.card, state.note, state.nt); }
    else if (k === 's' || k === 'S') { e.preventDefault(); searchQuestion(); }
  }
  document.addEventListener('keydown', onKey);

  await loadNext();

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    darkMq.removeEventListener('change', onScheme);
    clearTimeout(state.waitTimer);
    clearTimeout(state.revealTimer);
    state.seq++;
    stopListening();
    stopSpeaking();
    keepAwake(false);
    audio.pause();
    for (const url of mediaUrls.values()) if (url) URL.revokeObjectURL(url);
    document.body.classList.remove('reviewing');
  };
}

// ---------- card info ----------
export async function cardInfo(app, card, note, nt) {
  const col = app.col;
  card = (await col.getCard(card.id)) || card;
  const revs = (await col.revlogForCard(card.id)).sort((a, b) => a.id - b.id);
  const ctx = schedContext(col, card);
  const r = currentRetrievability(card, ctx);
  const deck = col.decks.get(card.did);
  const totalTime = revs.reduce((a, x) => a + (x.time || 0), 0);
  const due = card.queue === Q.NEW || card.type === 0 ? `New #${card.due}`
    : card.queue === Q.LRN ? new Date(card.due * 1000).toLocaleString()
    : fmtDate(dayToDate(card.due, col.col.crt).getTime());
  const rows = [
    ['Added', fmtDate(card.nid)],
    ['First review', revs[0] ? fmtDate(revs[0].id) : '—'],
    ['Latest review', revs.length ? fmtDate(revs[revs.length - 1].id) : '—'],
    ['Due', card.queue < 0 ? `${due} (${{ '-1': 'suspended', '-2': 'buried', '-3': 'buried' }[card.queue]})` : due],
    ['Interval', card.ivl ? fmtInterval(card.ivl * 86400) : '—'],
    ['Ease', card.factor ? `${card.factor / 10}%` : '—'],
    ['Stability', card.stability ? fmtInterval(card.stability * 86400) : '—'],
    ['Difficulty', card.difficulty ? `${Math.round(((card.difficulty - 1) / 9) * 100)}%` : '—'],
    ['Retrievability', r !== null ? `${Math.round(r * 100)}%` : '—'],
    ['Reviews', String(card.reps)],
    ['Lapses', String(card.lapses)],
    ['Average time', revs.length ? `${(totalTime / revs.length / 1000).toFixed(1)}s` : '—'],
    ['Total time', `${Math.round(totalTime / 1000)}s`],
    ['Card type', nt?.kind === 1 ? `Cloze ${card.ord + 1}` : nt?.templates.find((t) => t.ord === card.ord)?.name || ''],
    ['Note type', nt?.name || ''],
    ['Deck', deck?.name || ''],
    ['Card ID', String(card.id)],
    ['Note ID', String(card.nid)],
  ];
  const typeName = (t) => ['Learn', 'Review', 'Relearn', 'Filtered', 'Manual', 'Reschedule'][t] ?? String(t);
  const ratingName = ['', 'Again', 'Hard', 'Good', 'Easy'];
  const ivlText = (i) => (i < 0 ? fmtInterval(-i) : i > 0 ? fmtInterval(i * 86400) : '—');
  await sheet('Card info', h('div', {},
    h('table', { class: 'info' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v))))),
    h('h3', { style: { fontSize: '0.95rem', margin: '18px 0 6px' } }, 'Review history'),
    revs.length
      ? h('table', { class: 'info' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'Rating'), h('th', {}, 'Interval'))),
          h('tbody', {}, revs.slice().reverse().map((x) => h('tr', {},
            h('td', {}, new Date(x.id).toLocaleDateString()),
            h('td', {}, typeName(x.type)),
            h('td', { class: `r-${(ratingName[x.ease] || '').toLowerCase()}` }, x.type === REVLOG.MANUAL || x.type === REVLOG.RESCHEDULE ? '—' : ratingName[x.ease] || String(x.ease)),
            h('td', {}, ivlText(x.ivl))))))
      : h('p', { class: 'muted small' }, 'No reviews yet.'),
    h('div', { class: 'sheet-actions' },
      h('a', { class: 'btn', href: `#/edit/${card.nid}` }, 'Edit note'))
  ));
}

