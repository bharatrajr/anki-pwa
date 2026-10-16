// Turning a card into question/answer HTML, and showing it in a sandboxed iframe.
// The iframe has sandbox="allow-same-origin" WITHOUT allow-scripts, so nothing in a
// card can run JavaScript; the app attaches its own listeners from outside.

import { renderTemplate } from './template.js';
import { renderCloze } from './cloze.js';
import { stripHtml, escapeHtml, soundRefs } from './html.js';
import { fieldMap, KIND_CLOZE } from '../model/notetypes.js';

/** Remove scripts, event handlers, javascript: URLs and other active content. */
export function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed|base|meta|link)\b[^>]*>(?:[\s\S]*?<\/\1\s*>)?/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1="#"');
}

/**
 * Render both sides of a card.
 * Returns { q, a, css, typeAnswer, qText, aText, qSounds, aSounds }
 */
export function renderCard({ card, note, notetype, deckName = '', typed = '' }) {
  const fields = fieldMap(notetype, note);
  const isCloze = notetype.kind === KIND_CLOZE;
  const tmpl = isCloze ? notetype.templates[0] : notetype.templates.find((t) => t.ord === card.ord) || notetype.templates[0];
  const base = {
    fields, cardOrd: card.ord, tags: note.tags, deckName, notetypeName: notetype.name,
    cardName: tmpl.name, flag: card.flags & 7,
  };
  const q = renderTemplate(tmpl.qfmt, { ...base, side: 'q' });
  const a = renderTemplate(tmpl.afmt, { ...base, side: 'a', frontSide: stripTypeInput(q.html), typed });
  const qHtml = sanitizeHtml(q.html);
  const aHtml = sanitizeHtml(a.html);
  return {
    q: qHtml,
    a: aHtml,
    css: notetype.css || '',
    typeAnswer: q.typeAnswer || a.typeAnswer,
    qText: isCloze ? clozeQuestionText(note, notetype, card, 'blank') : speakableText(qHtml),
    aText: speakableText(answerOnlyHtml(aHtml)),
    searchText: isCloze ? clozeQuestionText(note, notetype, card, '').slice(0, 300) : searchText(qHtml),
    qSounds: soundRefs(q.html),
    aSounds: soundRefs(answerOnlyHtml(a.html)),
  };
}

function stripTypeInput(html) {
  return html.replace(/<input[^>]*id="typeans"[^>]*>/g, '');
}

/** The part of the answer after <hr id=answer>, if present (to avoid repeating the question). */
export function answerOnlyHtml(aHtml) {
  const m = /<hr[^>]*id=["']?answer["']?[^>]*>/i.exec(aHtml);
  return m ? aHtml.slice(m.index + m[0].length) : aHtml;
}

export function speakableText(html) {
  return stripHtml(
    String(html || '')
      .replace(/\[sound:[^\]]+\]/g, ' ')
      .replace(/<span class="cloze"[^>]*>\[(?:\.\.\.|[^\]]*)\]<\/span>/g, ' blank ')
      .replace(/<(br|div|p|li|tr|h\d)[^>]*>/gi, '. ')
  )
    .replace(/\s*\.\s*(\.\s*)+/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/^[\s.]+/, '')
    .trim();
}

function searchText(html) {
  return stripHtml(
    String(html || '')
      .replace(/\[sound:[^\]]+\]/g, ' ')
      .replace(/<span class="cloze"[^>]*>[\s\S]*?<\/span>/g, ' ')
      .replace(/<(br|div|p|li)[^>]*>/gi, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Cloze question text with blanks: used by TTS ('blank') and search (''). */
export function clozeQuestionText(note, notetype, card, blank) {
  const fields = fieldMap(notetype, note);
  const qfmt = notetype.templates[0].qfmt;
  const used = [...qfmt.matchAll(/\{\{[^}]*cloze:([^}]+)\}\}/g)].map((m) => m[1].trim());
  return used.map((f) => stripHtml(renderCloze(fields[f] || '', card.ord + 1, 'q', { blankText: blank ? ` ${blank} ` : ' ' }))).join(' ').replace(/\s+/g, ' ').trim();
}

// ---------- iframe display ----------

const BASE_CSS = `
html,body{margin:0;padding:0}
body{padding:16px 14px 24px;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
img{max-width:100%;height:auto}
.card{font-size:calc(20px * var(--fs,1))}
.sound-btn{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:1px solid #8884;background:#8881;color:inherit;font-size:18px;cursor:pointer;vertical-align:middle;margin:2px}
#typeans{width:100%;box-sizing:border-box;font-size:18px;padding:10px;border-radius:8px;border:1px solid #8888;margin-top:12px;background:transparent;color:inherit}
code.typeans{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.95em}
.typeGood{background:#2e7d3233;color:inherit}.typeBad{background:#c6282833;text-decoration:line-through}.typeMissed{background:#9e9e9e33}
.nightMode .card,.nightMode.card{color:#e8e8e8 !important;background-color:#1b1b1d !important}
a.hint{display:inline-block;padding:10px 4px;color:#1565c0}
.nightMode a.hint{color:#90caf9}
.template-error{color:#c62828;font-size:14px}
`;

/** Replace [sound:x] with buttons and media src with data-media for later resolution. */
export function prepareMediaHtml(html) {
  let i = 0;
  return html
    .replace(/\[sound:([^\]]+)\]/g, (_, f) => `<button type="button" class="sound-btn" data-sound="${escapeHtml(f)}" data-idx="${i++}" aria-label="Play audio">▶</button>`)
    .replace(/(<(?:img|audio|source|video)\b[^>]*?)\ssrc=(["']?)([^"'>\s]+)\2/gi, (m, pre, q, src) => {
      if (/^(?:https?:|data:|blob:)/i.test(src)) return m;
      return `${pre} data-media="${escapeHtml(src)}"`;
    });
}

/**
 * Write a side into the iframe. Resolves images from the media store.
 * opts: { css, night, fontScale, cardOrd, getMediaUrl(name) → Promise<url|null> }
 */
export async function showInFrame(frame, html, opts) {
  const doc = frame.contentDocument;
  const night = opts.night ? ' nightMode night_mode' : '';
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_CSS}</style><style>${opts.css || ''}</style><style>:root{--fs:${opts.fontScale || 1}}</style></head>
<body class="card card${(opts.cardOrd || 0) + 1}${night}" style="font-size:calc(20px * var(--fs,1))">${prepareMediaHtml(html)}</body></html>`);
  doc.close();
  const pending = [];
  for (const el of doc.querySelectorAll('[data-media]')) {
    pending.push(
      opts.getMediaUrl(el.getAttribute('data-media')).then((url) => {
        if (url) el.setAttribute('src', url);
        else el.setAttribute('alt', `missing: ${el.getAttribute('data-media')}`);
      })
    );
  }
  for (const el of doc.querySelectorAll('img')) el.addEventListener('load', () => fitFrame(frame));
  await Promise.all(pending);
  fitFrame(frame);
  return doc;
}

export function fitFrame(frame) {
  const doc = frame.contentDocument;
  if (!doc?.documentElement) return;
  frame.style.height = '0px';
  const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
  frame.style.height = `${Math.max(h, 120)}px`;
}
