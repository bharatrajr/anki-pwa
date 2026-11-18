// "Search" sheet for a card: look the question up, then copy a sentence or paragraph in one
// tap, or add it straight to the note's back field. Results come from Wikipedia (which allows
// in-app requests); Google opens in a new tab, and text copied there can be pasted back here.

import { h, toast, sheet } from './components.js';
import { escapeHtml } from '../render/html.js';
import { KIND_CLOZE } from '../model/notetypes.js';

const WIKI = 'https://en.wikipedia.org/w/api.php';

/**
 * Open the search sheet for a card's note.
 * onAdded(note) is called after text is added to the back field, so the caller can re-render.
 */
export async function lookupSheet(app, { query, note, nt, card, onAdded }) {
  const col = app.col;
  const backIdx = backFieldIndex(nt, card);
  const backName = nt.fields[backIdx]?.name || 'Back';

  await sheet('Search', () => {
    const input = h('input', { class: 'input', type: 'search', value: query, 'aria-label': 'Search for', enterkeyhint: 'search', autocomplete: 'off' });
    const results = h('div', { class: 'lookup-results', 'aria-live': 'polite' });
    const form = h('form', { class: 'search-row', role: 'search', onsubmit: (e) => { e.preventDefault(); wiki(input.value.trim()); } },
      input, h('button', { class: 'btn primary', type: 'submit' }, 'Search'));
    const tools = h('div', { class: 'row lookup-tools' },
      h('button', { class: 'btn compact', type: 'button', onclick: () => google(input.value.trim()) }, 'Google ↗'),
      h('button', { class: 'btn compact', type: 'button', onclick: () => pasteClipboard() }, '📋 Paste copied text'),
      h('span', { class: 'small muted spacer', style: { textAlign: 'right' } }, `＋ adds to “${backName}”`));

    async function wiki(q) {
      if (!q) return;
      results.replaceChildren(h('p', { class: 'small muted' }, 'Searching Wikipedia…'));
      try {
        const url = `${WIKI}?${new URLSearchParams({
          action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: q, gsrlimit: '3',
          prop: 'extracts', exintro: '1', explaintext: '1', exlimit: '3',
        })}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
        if (!pages.length) {
          results.replaceChildren(h('p', { class: 'small muted' }, 'No Wikipedia results. Try Google, copy what you need, then tap “Paste copied text”.'));
          return;
        }
        results.replaceChildren(...pages.map((p) => block(p.title, p.extract, `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(' ', '_'))}`)));
      } catch (e) {
        results.replaceChildren(h('p', { class: 'small muted' }, `Could not search (${navigator.onLine ? e.message : 'offline'}). Try Google, copy text, then “Paste copied text”.`));
      }
    }

    function google(q) {
      if (!q) return;
      copyText(q);
      window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener');
    }

    async function pasteClipboard() {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch {}
      if (text.trim()) { results.prepend(block('Copied text', text)); return; }
      // No clipboard access (or it was empty): let the user paste by hand.
      const area = h('textarea', { class: 'input', rows: 4, placeholder: 'Paste text here' });
      const box = h('div', { class: 'lookup-block' }, area,
        h('div', { class: 'sheet-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { if (area.value.trim()) box.replaceWith(block('Pasted text', area.value)); } }, 'Split into sentences')));
      results.prepend(box);
      area.focus();
    }

    // One source: each paragraph with its own buttons, then each sentence with its own.
    function block(title, text, href) {
      const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
      return h('section', { class: 'lookup-block' },
        h('h3', {}, href ? h('a', { href, target: '_blank', rel: 'noopener' }, title) : title),
        paras.map((para) => h('div', { class: 'lookup-para' },
          h('div', { class: 'lookup-para-actions' },
            h('span', { class: 'small muted spacer' }, 'Paragraph'),
            copyBtn(para), addBtn(para)),
          splitSentences(para).map((s) => h('div', { class: 'lookup-line' }, h('span', { class: 'lookup-text' }, s), copyBtn(s), addBtn(s))))));
    }

    function copyBtn(text) {
      const b = h('button', { class: 'lookup-btn', type: 'button', title: 'Copy', 'aria-label': `Copy: ${text.slice(0, 60)}` }, 'Copy');
      b.addEventListener('click', async () => {
        if (await copyText(text)) flash(b, 'Copied'); else toast('Copy is blocked in this browser');
      });
      return b;
    }
    function addBtn(text) {
      const b = h('button', { class: 'lookup-btn add', type: 'button', title: `Add to ${backName}`, 'aria-label': `Add to ${backName}: ${text.slice(0, 60)}` }, '＋');
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        b.disabled = true;
        try {
          await addToBack(col, note, backIdx, text);
          flash(b, '✓', true);
          toast(`Added to ${backName}`);
          onAdded?.(note);
        } catch (e) { b.disabled = false; toast(`Could not save: ${e.message || e}`); }
      });
      return b;
    }

    if (query) wiki(query);
    return h('div', {}, form, tools, results);
  });
}

/** Copy to the clipboard; falls back to a hidden textarea where the async API is unavailable. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = h('textarea', { readonly: true, style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
  ta.value = text;
  (document.querySelector('dialog[open]') || document.body).append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

function flash(btn, label, keep = false) {
  const old = btn.textContent;
  btn.textContent = label;
  btn.classList.add('done');
  if (!keep) setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1200);
}

/** Split a paragraph into sentences (keeps abbreviations like "e.g." and "U.S." mostly intact). */
export function splitSentences(text) {
  const out = [];
  let buf = '';
  for (const part of String(text).trim().split(/(?<=[.!?।]["”’)]?)\s+/)) {
    buf = buf ? `${buf} ${part}` : part;
    const tail = buf.split(/\s+/).pop() || '';
    // Don't break after short abbreviations such as "Dr." / "e.g." / single initials.
    if (/^(?:[A-Z]|[a-z]\.[a-z]|Dr|Mr|Mrs|Ms|St|vs|etc|e\.g|i\.e|No|Jr|Sr)\.$/.test(tail)) continue;
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

/** The field shown on the back: on the answer template but not the question; else a sensible fallback. */
export function backFieldIndex(nt, card) {
  const names = nt.fields.map((f) => f.name);
  if (nt.kind === KIND_CLOZE) {
    const i = names.findIndex((n) => /back extra|extra/i.test(n));
    return i >= 0 ? i : Math.min(1, names.length - 1);
  }
  const tmpl = nt.templates.find((t) => t.ord === card?.ord) || nt.templates[0];
  const refs = (s) => new Set([...String(s || '').matchAll(/\{\{([^}]+)\}\}/g)]
    .map((m) => m[1].trim())
    .filter((r) => !/^[#^/!]/.test(r))
    .map((r) => r.split(':').pop().trim()));
  const q = refs(tmpl?.qfmt);
  const a = refs(tmpl?.afmt);
  const i = names.findIndex((n) => a.has(n) && !q.has(n));
  if (i >= 0) return i;
  const back = names.findIndex((n) => /^back$/i.test(n));
  return back >= 0 ? back : names.length - 1;
}

async function addToBack(col, note, idx, text) {
  const fresh = (await col.getNote(note.id)) || note;
  const add = escapeHtml(text.trim()).replace(/\n+/g, '<br>');
  const cur = fresh.fields[idx] || '';
  fresh.fields[idx] = cur.trim() ? `${cur}<br>${add}` : add;
  await col.updateNote(fresh);
  Object.assign(note, fresh);
}
