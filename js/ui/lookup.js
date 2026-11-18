// "Search" sheet for a card: Google results inside the app, with one-tap Copy on every sentence
// and paragraph, and ＋ to add it straight to the note's back field. Google itself can't be
// framed or fetched from a web app, so results come through serper.dev (a Google results API;
// the user's own key, saved in Settings). "Full page" pulls a result's whole text in the same way.
// Text copied in a normal Google tab can also be pasted back and split here.

import { h, toast, sheet } from './components.js';
import { escapeHtml } from '../render/html.js';
import { KIND_CLOZE } from '../model/notetypes.js';

const SERPER = 'https://google.serper.dev/search';
const SCRAPE = 'https://scrape.serper.dev';

/**
 * Open the search sheet for a card's note.
 * onAdded(note) is called after text is added to the back field, so the caller can re-render.
 */
export async function lookupSheet(app, { query, note, nt, card, onAdded }) {
  const col = app.col;
  const cfg = col.settings.search || {};
  const backIdx = backFieldIndex(nt, card);
  const backName = nt.fields[backIdx]?.name || 'Back';

  await sheet('Google search', (close) => {
    const input = h('input', { class: 'input', type: 'search', value: query, 'aria-label': 'Search for', enterkeyhint: 'search', autocomplete: 'off' });
    const results = h('div', { class: 'lookup-results', 'aria-live': 'polite' });
    const form = h('form', { class: 'search-row', role: 'search', onsubmit: (e) => { e.preventDefault(); search(input.value.trim()); } },
      input, h('button', { class: 'btn primary', type: 'submit' }, 'Search'));
    const tools = h('div', { class: 'row lookup-tools' },
      h('button', { class: 'btn compact', type: 'button', onclick: () => openGoogle(input.value.trim()) }, 'Open in Google ↗'),
      h('button', { class: 'btn compact', type: 'button', onclick: () => pasteClipboard() }, '📋 Paste copied text'),
      h('span', { class: 'small muted spacer', style: { textAlign: 'right' } }, `＋ adds to “${backName}”`));

    const msg = (text) => h('p', { class: 'small muted' }, text);
    const toSettings = () => { close(); app.go('/settings'); };

    async function serper(url, body) {
      const res = await fetch(url, { method: 'POST', headers: { 'X-API-KEY': cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('The search key was not accepted. Check it in Settings.'), { key: true });
      if (res.status === 429) throw new Error('Too many searches right now, or no searches left on this key.');
      if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
      return res.json();
    }

    async function search(q) {
      if (!q) return;
      if (!cfg.key) {
        results.replaceChildren(h('div', { class: 'lookup-block' },
          h('p', {}, 'To see Google results here with Copy and ＋ buttons, add a free search key in Settings (one time).'),
          h('div', { class: 'sheet-actions', style: { justifyContent: 'flex-start' } },
            h('button', { class: 'btn primary', type: 'button', onclick: toSettings }, 'Open Settings'))));
        return;
      }
      results.replaceChildren(msg('Searching Google…'));
      try {
        const data = await serper(SERPER, { q, gl: cfg.gl || 'in', hl: 'en', num: 10 });
        const out = [];
        const ab = data.answerBox;
        if (ab) {
          const parts = [ab.answer, ab.snippet, ...(ab.snippetHighlighted || [])].filter(Boolean);
          out.push(block(ab.title || 'Top answer', [...new Set(parts)].join('\n'), ab.link));
        }
        const kg = data.knowledgeGraph;
        if (kg?.description) out.push(block(kg.title || 'About', kg.description, kg.descriptionLink || kg.website));
        for (const r of data.organic || []) {
          const text = [r.snippet, ...(r.sitelinks || []).map((x) => x.snippet)].filter(Boolean).join('\n');
          out.push(block(r.title, text, r.link, { full: true }));
        }
        for (const r of data.peopleAlsoAsk || []) out.push(block(r.question, r.snippet, r.link, { full: true }));
        results.replaceChildren(...(out.length ? out : [msg('No results. Try other words.')]));
      } catch (e) {
        results.replaceChildren(h('div', { class: 'lookup-block' },
          msg(navigator.onLine ? e.message : 'You are offline.'),
          e.key ? h('button', { class: 'btn compact', type: 'button', onclick: toSettings }, 'Open Settings') : null));
      }
    }

    // Replace a result's snippet with the page's full text.
    async function loadFull(section, title, link, btn) {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const data = await serper(SCRAPE, { url: link });
        const paras = String(data.text || '').split(/\n+/).map((x) => x.replace(/\s+/g, ' ').trim())
          .filter((x) => x.split(' ').length >= 6) // skip menus, buttons and other page furniture
          .slice(0, 80);
        if (!paras.length) throw new Error('No readable text on that page');
        section.replaceWith(block(title, paras.join('\n'), link));
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Full page';
        toast(e.message || 'Could not load the page');
      }
    }

    function openGoogle(q) {
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

    // One source: each paragraph (with its own buttons when it has several sentences), then each sentence.
    function block(title, text, href, { full = false } = {}) {
      const paras = String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
      const section = h('section', { class: 'lookup-block' });
      const fullBtn = full && href ? h('button', { class: 'lookup-btn', type: 'button', title: 'Show the whole page text here', onclick: () => loadFull(section, title, href, fullBtn) }, 'Full page') : null;
      section.append(
        h('div', { class: 'lookup-head' },
          h('h3', {}, href ? h('a', { href, target: '_blank', rel: 'noopener' }, title) : title),
          fullBtn),
        href ? h('div', { class: 'lookup-src small muted' }, hostOf(href)) : '',
        ...paras.map((para) => {
          const sentences = splitSentences(para);
          return h('div', { class: 'lookup-para' },
            sentences.length > 1 ? h('div', { class: 'lookup-para-actions' }, h('span', { class: 'small muted spacer' }, 'Whole paragraph'), copyBtn(para), addBtn(para)) : null,
            sentences.map((x) => h('div', { class: 'lookup-line' }, h('span', { class: 'lookup-text' }, x), copyBtn(x), addBtn(x))));
        }));
      return section;
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

    if (query) search(query);
    return h('div', {}, form, tools, results);
  });
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
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
