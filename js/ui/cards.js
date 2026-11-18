// Card view for the browser: page through search results like flashcards, without grading.
// Each card shows question and answer together (the answer side); swipe left / → for the next
// card, swipe right / ← for the previous. Nothing here changes scheduling.

import { h, toast } from './components.js';
import { searchCards } from '../search/search.js';
import { speak, stopSpeaking } from '../speech/speech.js';
import { renderCard, showInFrame, fitFrame } from '../render/card.js';
import { groupByNote, sortBrowseResults } from './browse.js';

const SWIPE_MIN = 60; // px of horizontal travel that counts as a swipe

export async function render(app) {
  const col = app.col;
  const params = app.params();
  const query = params.get('q') ?? 'deck:*';
  const back = params.get('back') || `/browse?q=${encodeURIComponent(query)}`;
  document.body.classList.add('reviewing');
  app.setTitle('Card view');
  app.setBack(back);

  const mediaUrls = new Map();
  const getMediaUrl = async (name) => {
    if (mediaUrls.has(name)) return mediaUrls.get(name);
    const rec = await col.getMedia(name);
    const url = rec ? URL.createObjectURL(rec.blob) : null;
    mediaUrls.set(name, url);
    return url;
  };
  const audio = new Audio();
  const speech = col.settings.tts;

  const st = { list: [], i: 0, rendered: null, note: null, nt: null, card: null };

  const editBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit note', title: 'Edit note (e)', onclick: () => editNote() }, '✎');
  app.setActions(editBtn);

  const posEl = h('span', { class: 'small muted', 'aria-live': 'polite' });
  const metaEl = h('span', { class: 'small muted cards-meta' });
  const topRow = h('div', { class: 'review-top' }, posEl, h('span', { class: 'spacer' }), metaEl);
  const frame = h('iframe', { class: 'card-frame', title: 'Card', sandbox: 'allow-same-origin', 'aria-live': 'polite' });
  const frameWrap = h('div', { class: 'card-frame-wrap swipe-card' }, frame);
  const hint = h('p', { class: 'small muted', style: { textAlign: 'center', margin: '10px 0 0' } }, 'Swipe left or right to move');
  const prevBtn = h('button', { class: 'btn nav-btn', type: 'button', 'aria-label': 'Previous card (←)', onclick: () => go(-1) }, '‹');
  const searchBtn = h('button', { class: 'btn primary show-btn', type: 'button', title: 'Copy the question and search Google (s)', onclick: () => searchQuestion() }, '🔍 Search');
  const nextBtn = h('button', { class: 'btn nav-btn', type: 'button', 'aria-label': 'Next card (→)', onclick: () => go(1) }, '›');
  const bar = h('div', { class: 'answer-bar' }, h('div', { class: 'inner cards-nav' }, prevBtn, searchBtn, nextBtn));
  const content = h('div', { class: 'cards-view' }, topRow, frameWrap, hint);
  app.main.append(content, bar);

  const onResize = () => fitFrame(frame);
  window.addEventListener('resize', onResize);

  // ---------- load the results, in the browser's order ----------
  let results;
  try { results = await searchCards(col, query); }
  catch (e) { content.replaceChildren(h('div', { class: 'empty' }, h('p', {}, `Search error: ${e.message}`))); return cleanup; }
  if (params.get('mode') === 'notes') results = groupByNote(results);
  st.list = sortBrowseResults(col, results, params.get('sort') || 'sfld');
  if (!st.list.length) {
    content.replaceChildren(h('div', { class: 'empty card-surface' }, h('h2', {}, 'No cards'), h('p', {}, 'Nothing matches this search.')));
    bar.hidden = true;
    return cleanup;
  }
  st.i = Math.min(Math.max(0, parseInt(params.get('i'), 10) || 0), st.list.length - 1);

  // ---------- showing a card ----------
  async function show(dir = 0) {
    const r = st.list[st.i];
    // The note may have been edited since the search ran.
    const note = (await col.getNote(r.note.id)) || r.note;
    const card = (await col.getCard(r.card.id)) || r.card;
    const nt = col.notetypes.get(note.ntid);
    if (!nt) { toast('This card’s note type is missing'); return; }
    Object.assign(st, { note, nt, card });
    st.rendered = renderCard({ card, note, notetype: nt, deckName: col.decks.get(card.did)?.name || '' });
    await paint();
    if (dir) slideIn(dir);
    const deck = col.decks.get(card.did)?.name.split('::').pop() || '';
    posEl.textContent = `${st.i + 1} / ${st.list.length}`;
    metaEl.textContent = [deck, card.queue === -1 ? 'suspended' : ''].filter(Boolean).join(' · ');
    prevBtn.disabled = st.i === 0;
    nextBtn.disabled = st.i === st.list.length - 1;
    // Remember the position, so coming back from the editor returns here.
    const p = app.params(); p.set('i', String(st.i));
    history.replaceState(null, '', `#/cards?${p}`);
  }

  async function paint() {
    // The answer side already includes the question (via {{FrontSide}}).
    const doc = await showInFrame(frame, st.rendered.a, {
      css: st.rendered.css, night: app.isDark(), fontScale: col.settings.fontScale, cardOrd: st.card.ord, getMediaUrl,
    });
    frameWrap.dataset.flag = String(st.card.flags & 7);
    wireFrame(doc);
    autoplay();
  }

  async function searchQuestion() {
    if (!st.rendered) return;
    const q = st.rendered.searchText;
    if (!q) return toast('Nothing to search on this card');
    try { await navigator.clipboard.writeText(q); } catch {}
    window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener');
  }

  let busy = false;
  async function go(step) {
    const j = st.i + step;
    if (busy || j < 0 || j >= st.list.length) { bounce(step); return; }
    busy = true;
    try {
      await slideOut(step);
      st.i = j;
      await show(step);
    } finally { busy = false; }
  }

  // ---------- swipe animation ----------
  // Never wait on an animation for long: hidden tabs pause them, and reduced motion skips them.
  const anim = (el, frames, ms) => {
    if (!el.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    const a = el.animate(frames, { duration: ms, easing: 'ease-out' });
    return Promise.race([a.finished.catch(() => {}), new Promise((r) => setTimeout(r, ms + 50))]);
  };
  const offscreen = () => Math.min(window.innerWidth, 600);
  async function slideOut(step) {
    const from = frameWrap.style.transform || 'translateX(0)';
    await anim(frameWrap, [{ transform: from, opacity: 1 }, { transform: `translateX(${-step * offscreen()}px)`, opacity: 0 }], 160);
    frameWrap.style.transform = `translateX(${-step * offscreen()}px)`;
    frameWrap.style.opacity = '0';
  }
  function slideIn(step) {
    frameWrap.style.transform = '';
    frameWrap.style.opacity = '';
    anim(frameWrap, [{ transform: `translateX(${step * 80}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], 180);
  }
  function bounce(step) {
    const from = frameWrap.style.transform || 'translateX(0)';
    frameWrap.style.transform = '';
    anim(frameWrap, [{ transform: from }, { transform: `translateX(${-step * 24}px)` }, { transform: 'translateX(0)' }], 220);
  }

  // Touch handling, used both inside the card iframe and on the area around it.
  let touch = null;
  let swiped = false;
  function onTouchStart(e) {
    if (e.touches.length !== 1) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, horiz: null };
  }
  function onTouchMove(e) {
    if (!touch) return;
    const dx = e.touches[0].clientX - touch.x;
    const dy = e.touches[0].clientY - touch.y;
    if (touch.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) touch.horiz = Math.abs(dx) > Math.abs(dy);
    if (!touch.horiz) return;
    if (e.cancelable) e.preventDefault();
    touch.dx = dx;
    const atEdge = (dx > 0 && st.i === 0) || (dx < 0 && st.i === st.list.length - 1);
    frameWrap.style.transform = `translateX(${atEdge ? dx / 4 : dx}px) rotate(${(atEdge ? dx / 4 : dx) / 40}deg)`;
  }
  function onTouchEnd() {
    if (!touch) return;
    const { dx, horiz } = touch;
    touch = null;
    if (!horiz) return;
    swiped = true;
    setTimeout(() => { swiped = false; }, 350);
    if (Math.abs(dx) >= SWIPE_MIN) go(dx < 0 ? 1 : -1);
    else {
      const from = frameWrap.style.transform;
      frameWrap.style.transform = '';
      anim(frameWrap, [{ transform: from }, { transform: 'translateX(0)' }], 150);
    }
  }
  const touchOpts = { passive: false };
  content.addEventListener('touchstart', onTouchStart, { passive: true });
  content.addEventListener('touchmove', onTouchMove, touchOpts);
  content.addEventListener('touchend', onTouchEnd);
  content.addEventListener('touchcancel', onTouchEnd);

  function wireFrame(doc) {
    doc.body.style.touchAction = 'pan-y';
    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchmove', onTouchMove, touchOpts);
    doc.addEventListener('touchend', onTouchEnd);
    doc.addEventListener('touchcancel', onTouchEnd);
    doc.addEventListener('click', (e) => {
      if (swiped) { e.preventDefault(); return; }
      const t = e.target;
      const sound = t.closest?.('[data-sound]');
      if (sound) { e.preventDefault(); playAv([{ kind: 'sound', file: sound.getAttribute('data-sound') }]); return; }
      const tts = t.closest?.('[data-tts]');
      if (tts) {
        e.preventDefault();
        playAv([{ kind: 'tts', text: tts.getAttribute('data-tts'), lang: tts.getAttribute('data-tts-lang') || null, speed: parseFloat(tts.getAttribute('data-tts-speed')) || 1 }]);
        return;
      }
      const hintLink = t.closest?.('a.hint[data-hint]');
      if (hintLink) { e.preventDefault(); const d = doc.getElementById(hintLink.dataset.hint); if (d) { d.style.display = 'block'; hintLink.style.display = 'none'; fitFrame(frame); } return; }
      const link = t.closest?.('a[href]');
      if (link) { e.preventDefault(); const href = link.getAttribute('href'); if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener'); return; }
    });
    doc.addEventListener('keydown', (e) => { if (e.target.id !== 'typeans') onKey(e); });
  }

  // ---------- the card's own audio (played once per side, like Anki) ----------
  let avToken = 0;
  let finishFile = null;
  async function playAv(items) {
    const token = ++avToken;
    finishFile?.();
    audio.pause();
    stopSpeaking();
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
      audio.play().catch(() => finishFile?.());
    });
  }
  function stopAv() { avToken++; audio.pause(); finishFile?.(); stopSpeaking(); }
  function autoplay() {
    stopAv();
    const own = [...st.rendered.qAv, ...st.rendered.aAv];
    if (own.length && speech.autoplay !== false) playAv(own);
  }

  function editNote() {
    if (!st.note) return;
    app.go(`/edit/${st.note.id}?back=${encodeURIComponent(location.hash.slice(1))}`);
  }

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (k === 's' || k === 'S') { e.preventDefault(); searchQuestion(); }
    else if (k === 'e' || k === 'E') { e.preventDefault(); editNote(); }
    else if (k === 'r' || k === 'R') { e.preventDefault(); autoplay(); }
  }
  document.addEventListener('keydown', onKey);

  function cleanup() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    stopAv();
    for (const url of mediaUrls.values()) if (url) URL.revokeObjectURL(url);
    document.body.classList.remove('reviewing');
  }

  await show();
  return cleanup;
}
