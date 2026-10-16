// Add / edit notes: note type, deck, rich fields (bold/italic/underline, cloze, images), tags.

import { h, toast, confirmDialog } from './components.js';
import { KIND_CLOZE } from '../model/notetypes.js';
import { clozeNumbers } from '../render/cloze.js';
import { sanitizeHtml } from '../render/card.js';
import { escapeHtml } from '../render/html.js';
import { DEFAULT_DECK_ID } from '../db/collection.js';

const LAST_KEY = 'ankipwa.lastAdd';

export async function render(app, [nidStr]) {
  const col = app.col;
  const editing = !!nidStr;
  const params = app.params();
  const back = params.get('back');
  let note = null, cards = [];
  if (editing) {
    note = await col.getNote(Number(nidStr));
    if (!note) { toast('Note not found'); return app.go('/'); }
    cards = await col.cardsOfNote(note.id);
  }
  app.setTitle(editing ? 'Edit note' : 'Add');
  if (editing || back) app.setBack(back || '/');

  let last = {};
  try { last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); } catch {}
  let nt = editing ? col.notetypes.get(note.ntid) : col.notetypes.get(last.ntid) || col.notetypeByName('Basic') || [...col.notetypes.values()][0];
  let did = editing ? cards[0]?.did || DEFAULT_DECK_ID : Number(params.get('did')) || (col.decks.has(last.did) ? last.did : DEFAULT_DECK_ID);
  const sticky = new Map(); // field index → html kept between adds

  const mediaUrls = new Map();
  const blobUrl = async (name) => {
    if (mediaUrls.has(name)) return mediaUrls.get(name);
    const rec = await col.getMedia(name);
    const url = rec ? URL.createObjectURL(rec.blob) : '';
    mediaUrls.set(name, url);
    return url;
  };

  const ntSelect = h('select', { class: 'input', disabled: editing, 'aria-label': 'Note type' },
    [...col.notetypes.values()].sort((a, b) => a.name.localeCompare(b.name)).map((t) => h('option', { value: String(t.id), selected: t.id === nt.id }, t.name)));
  const deckSelect = h('select', { class: 'input', 'aria-label': 'Deck' },
    [...col.decks.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => h('option', { value: String(d.id), selected: d.id === did }, d.name.replaceAll('::', ' › '))));
  const tagsInput = h('input', { class: 'input', value: editing ? note.tags.join(' ') : last.tags || '', placeholder: 'space-separated', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
  const fieldsBox = h('div');
  const saveBtn = h('button', { class: 'btn primary block', type: 'submit' }, editing ? 'Save' : 'Add');

  let editors = [];
  async function buildFields(initial) {
    fieldsBox.replaceChildren();
    editors = [];
    for (const [i, f] of nt.fields.entries()) {
      const ed = h('div', { class: 'rich', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': f.name, spellcheck: 'true' });
      ed.innerHTML = await toEditorHtml(initial?.[i] ?? sticky.get(i) ?? '');
      ed.addEventListener('paste', (e) => onPaste(e, ed));
      ed.addEventListener('drop', (e) => onDrop(e, ed));
      ed.addEventListener('keydown', (e) => onFieldKey(e, ed));
      editors.push(ed);
      const pin = h('button', {
        type: 'button', class: 'icon-btn', 'aria-pressed': String(sticky.has(i)), title: 'Keep this field after adding', 'aria-label': `Keep ${f.name} after adding`,
        style: { minHeight: '32px', minWidth: '32px', fontSize: '0.9rem', opacity: sticky.has(i) ? 1 : 0.45 },
        onclick: (e) => { if (sticky.has(i)) sticky.delete(i); else sticky.set(i, ''); e.currentTarget.style.opacity = sticky.has(i) ? 1 : 0.45; e.currentTarget.setAttribute('aria-pressed', String(sticky.has(i))); },
      }, '📌');
      fieldsBox.append(h('div', { class: 'field' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { style: { fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' } }, f.name), editing ? null : pin),
        ed));
    }
  }

  async function toEditorHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = sanitizeHtml(html);
    for (const img of tmp.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (src && !/^(?:https?:|data:|blob:)/i.test(src)) {
        img.setAttribute('data-media', src);
        img.setAttribute('src', await blobUrl(src));
      }
    }
    return tmp.innerHTML;
  }
  function fromEditor(ed) {
    const tmp = ed.cloneNode(true);
    for (const img of tmp.querySelectorAll('img[data-media]')) {
      img.setAttribute('src', img.getAttribute('data-media'));
      img.removeAttribute('data-media');
    }
    let html = tmp.innerHTML.replace(/<br\s*\/?>$/i, '').replace(/^(?:<br\s*\/?>)+$/i, '');
    if (/^\s*$/.test(html.replace(/&nbsp;/g, ''))) html = html.trim();
    return html;
  }

  async function insertImage(ed, file) {
    const name = await col.addMediaFile(file);
    const url = await blobUrl(name);
    ed.focus();
    document.execCommand('insertHTML', false, `<img src="${url}" data-media="${escapeHtml(name)}">`);
  }
  async function onPaste(e, ed) {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      for (const f of files) await insertImage(ed, new File([f], f.name && f.name !== 'image.png' ? f.name : `paste-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }));
      return;
    }
    // Paste text without foreign formatting; keep line breaks.
    const text = e.clipboardData?.getData('text/plain');
    if (text !== undefined) {
      e.preventDefault();
      document.execCommand('insertHTML', false, escapeHtml(text).replace(/\r?\n/g, '<br>'));
    }
  }
  async function onDrop(e, ed) {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await insertImage(ed, f);
  }

  function cloze(ed, sameNumber) {
    const all = editors.map(fromEditor).join(' ');
    const nums = [...clozeNumbers(all)];
    const max = nums.length ? Math.max(...nums) : 0;
    const n = sameNumber ? Math.max(max, 1) : max + 1;
    ed.focus();
    const sel = window.getSelection();
    const text = sel && sel.rangeCount && ed.contains(sel.anchorNode) ? sel.toString() : '';
    document.execCommand('insertText', false, `{{c${n}::${text}}}`);
    if (!text) {
      // Put the caret inside the empty cloze.
      const s = window.getSelection();
      for (let i = 0; i < 2; i++) s.modify?.('move', 'backward', 'character');
    }
  }

  function onFieldKey(e, ed) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); cloze(ed, e.altKey); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  }

  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    h('button', { type: 'button', 'aria-label': 'Bold', title: 'Bold (Ctrl+B)', onmousedown: (e) => e.preventDefault(), onclick: () => document.execCommand('bold') }, h('b', {}, 'B')),
    h('button', { type: 'button', 'aria-label': 'Italic', title: 'Italic (Ctrl+I)', onmousedown: (e) => e.preventDefault(), onclick: () => document.execCommand('italic') }, h('i', {}, 'I')),
    h('button', { type: 'button', 'aria-label': 'Underline', title: 'Underline (Ctrl+U)', onmousedown: (e) => e.preventDefault(), onclick: () => document.execCommand('underline') }, h('u', {}, 'U')),
    h('button', { type: 'button', 'aria-label': 'Cloze deletion', title: 'Cloze (Ctrl+Shift+C; add Alt for same number)', onmousedown: (e) => e.preventDefault(), onclick: () => { const ed = editors.find((x) => x.contains(window.getSelection()?.anchorNode)) || editors[0]; cloze(ed, false); } }, '[…]'),
    h('button', { type: 'button', 'aria-label': 'Insert image', title: 'Insert image', onmousedown: (e) => e.preventDefault(), onclick: () => {
      const ed = editors.find((x) => x.contains(window.getSelection()?.anchorNode)) || editors[0];
      const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      input.addEventListener('change', async () => { if (input.files[0]) await insertImage(ed, input.files[0]); input.remove(); });
      document.body.append(input);
      input.click();
    } }, '🖼'));

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      try { await save(); } finally { saveBtn.disabled = false; }
    },
  },
    h('div', { class: 'row', style: { gap: '10px' } },
      h('label', { class: 'field', style: { flex: '1 1 160px', margin: '6px 0' } }, h('span', {}, 'Type'), ntSelect),
      h('label', { class: 'field', style: { flex: '1 1 160px', margin: '6px 0' } }, h('span', {}, 'Deck'), deckSelect)),
    toolbar,
    fieldsBox,
    h('label', { class: 'field' }, h('span', {}, 'Tags'), tagsInput),
    h('div', { class: 'sticky-actions' }, saveBtn),
    editing ? h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '8px' } },
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog('Delete note?', `This deletes the note, its ${cards.length} card${cards.length === 1 ? '' : 's'} and their review history.`, { ok: 'Delete', danger: true }))) return;
        await col.deleteNotes([note.id]);
        toast('Note deleted');
        app.go(back || '/');
      } }, 'Delete note')) : null,
    !editing ? h('p', { class: 'hint-text', style: { textAlign: 'center' } }, 'Ctrl+Enter adds · Ctrl+Shift+C makes a cloze · paste or drop images into a field') : null
  );

  ntSelect.addEventListener('change', async () => {
    const old = editors.map(fromEditor);
    nt = col.notetypes.get(Number(ntSelect.value));
    sticky.clear();
    await buildFields(old);
  });
  deckSelect.addEventListener('change', () => { did = Number(deckSelect.value); });

  async function save() {
    const fields = editors.map(fromEditor);
    const tags = tagsInput.value;
    if (editing) {
      note.fields = fields;
      note.tags = tags.split(/\s+/).filter(Boolean);
      const { added } = await col.updateNote(note, { did });
      // Move cards when the deck changed.
      const moved = cards.filter((c) => c.did !== did);
      if (moved.length) await col.putCards(moved.map((c) => ({ ...(c), did })));
      toast(added.length ? `Saved. ${added.length} new card${added.length === 1 ? '' : 's'} added.` : 'Saved');
      app.go(back || `/deck/${did}`);
      return;
    }
    if (!fields[0] || !fields[0].replace(/<[^>]*>|&nbsp;|\s/g, '')) {
      toast(`The first field (${nt.fields[0].name}) is empty.`);
      editors[0].focus();
      return;
    }
    if (nt.kind === KIND_CLOZE && clozeNumbers(fields.join(' ')).size === 0) {
      toast('Add at least one cloze, e.g. select a word and tap […].');
      return;
    }
    try {
      const { cards: made } = await col.addNote({ ntid: nt.id, fields, tags: tags.split(/\s+/).filter(Boolean), did });
      try { localStorage.setItem(LAST_KEY, JSON.stringify({ ntid: nt.id, did, tags })); } catch {}
      toast(`Added ${made.length} card${made.length === 1 ? '' : 's'}`);
      for (const i of sticky.keys()) sticky.set(i, fields[i]);
      await buildFields(null);
      editors[0]?.focus();
    } catch (e) {
      toast(e.message || String(e));
    }
  }

  await buildFields(editing ? note.fields : null);
  app.main.append(form);
  if (matchMedia('(pointer: fine)').matches) editors[0]?.focus();

  return () => { for (const u of mediaUrls.values()) if (u) URL.revokeObjectURL(u); };
}
