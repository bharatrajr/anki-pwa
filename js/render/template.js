// Anki card-template rendering for the common syntax:
// {{Field}}, {{FrontSide}}, {{#F}}…{{/F}}, {{^F}}…{{/F}}, {{text:F}}, {{hint:F}},
// {{type:F}}, {{type:cloze:F}}, {{cloze:F}}, {{cloze-only:F}}, {{tts …:F}} (text kept),
// special fields Tags/Type/Deck/Subdeck/Card/CardFlag. Unknown filters pass content through.

import { renderCloze, clozeOnly } from './cloze.js';
import { stripHtml, fieldIsEmpty, escapeHtml } from './html.js';

/** Tokenise a template into a nested tree. */
export function parseTemplate(src) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  const re = /\{\{([^}]*?)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) stack[stack.length - 1].children.push({ type: 'text', text: src.slice(last, m.index) });
    last = re.lastIndex;
    const tag = m[1].trim();
    if (tag.startsWith('#') || tag.startsWith('^')) {
      const node = { type: tag[0] === '#' ? 'if' : 'unless', key: tag.slice(1).trim(), children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (tag.startsWith('/')) {
      const key = tag.slice(1).trim();
      // Close the matching open section; tolerate mismatches like Anki shows an error.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].key === key) { stack.length = i; break; }
      }
    } else if (tag.startsWith('!')) {
      // comment
    } else {
      const parts = tag.split(':');
      const field = parts.pop().trim();
      stack[stack.length - 1].children.push({ type: 'field', field, filters: parts.map((p) => p.trim()) });
    }
  }
  if (last < src.length) stack[stack.length - 1].children.push({ type: 'text', text: src.slice(last) });
  return root;
}

/**
 * Render a template.
 * ctx: { fields: {name: html}, side: 'q'|'a', cardOrd (0-based), frontSide (html for {{FrontSide}}),
 *        tags: [], deckName, cardName, notetypeName, flag, typed (string typed by the user) }
 * Returns { html, typeAnswer: {expected, combining} | null, ttsSegments: [] }
 */
export function renderTemplate(src, ctx) {
  const tree = parseTemplate(src);
  const state = { typeAnswer: null };
  const html = renderNodes(tree.children, ctx, state);
  return { html, typeAnswer: state.typeAnswer };
}

function lookup(name, ctx) {
  if (name === 'FrontSide') return ctx.side === 'a' ? ctx.frontSide || '' : '';
  if (name === 'Tags') return (ctx.tags || []).join(' ');
  if (name === 'Type') return ctx.notetypeName || '';
  if (name === 'Deck') return ctx.deckName || '';
  if (name === 'Subdeck') return (ctx.deckName || '').split('::').pop();
  if (name === 'Card') return ctx.cardName || '';
  if (name === 'CardFlag') return ctx.flag ? `flag${ctx.flag}` : '';
  if (ctx.fields && Object.prototype.hasOwnProperty.call(ctx.fields, name)) return ctx.fields[name] ?? '';
  return null; // unknown field
}

function isNonEmpty(key, ctx) {
  // {{#c1}} style conditionals on cloze numbers are supported by Anki for cloze notetypes.
  const cm = /^c(\d+)$/.exec(key);
  if (cm && ctx.cardOrd !== undefined && lookup(key, ctx) === null) return ctx.cardOrd + 1 === parseInt(cm[1], 10);
  const v = lookup(key, ctx);
  return v !== null && !fieldIsEmpty(v);
}

function renderNodes(nodes, ctx, state) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.text;
    else if (n.type === 'if') { if (isNonEmpty(n.key, ctx)) out += renderNodes(n.children, ctx, state); }
    else if (n.type === 'unless') { if (!isNonEmpty(n.key, ctx)) out += renderNodes(n.children, ctx, state); }
    else if (n.type === 'field') out += renderField(n, ctx, state);
  }
  return out;
}

function renderField(node, ctx, state) {
  let value = lookup(node.field, ctx);
  const filters = [...node.filters];
  if (value === null) {
    if (filters.length === 0) return `<span class="template-error">{unknown field ${escapeHtml(node.field)}}</span>`;
    value = '';
  }
  // type-in-the-answer: {{type:F}} or {{type:cloze:F}}
  if (filters[0] === 'type') {
    const isCloze = filters.includes('cloze');
    const expected = isCloze ? clozeOnly(value, ctx.cardOrd + 1) : stripHtml(value).trim();
    state.typeAnswer = { expected, field: node.field };
    if (ctx.side === 'q') {
      return '<input type="text" id="typeans" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Type your answer">';
    }
    return `<div id="typeans-result">${typeDiff(ctx.typed || '', expected)}</div>`;
  }
  // Filters are applied right-to-left (innermost first), e.g. {{text:cloze:Text}}.
  for (let i = filters.length - 1; i >= 0; i--) value = applyFilter(filters[i], value, ctx);
  return value;
}

function applyFilter(filter, value, ctx) {
  const name = filter.split(/\s+/)[0];
  switch (name) {
    case 'text':
      return escapeHtml(stripHtml(value));
    case 'cloze':
      return renderCloze(value, (ctx.cardOrd ?? 0) + 1, ctx.side);
    case 'cloze-only':
      return clozeOnly(value, (ctx.cardOrd ?? 0) + 1);
    case 'hint': {
      if (fieldIsEmpty(value)) return '';
      const id = `hint${Math.random().toString(36).slice(2, 8)}`;
      return `<a class="hint" href="#" data-hint="${id}">Show hint</a><div id="${id}" class="hint" style="display:none">${value}</div>`;
    }
    case 'tts':
      return value; // TTS is handled by the app's read-aloud feature
    case 'kana':
      return value.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$2');
    case 'kanji':
      return value.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$1');
    case 'furigana':
      return value.replace(/ ?([^ >]+?)\[(.+?)\]/g, '<ruby><rb>$1</rb><rt>$2</rt></ruby>');
    default:
      return value;
  }
}

/** Character diff of the typed answer against the expected answer (Anki-like colouring). */
export function typeDiff(typed, expected) {
  const a = typed.trim();
  const b = expected;
  if (!a) return `<code class="typeans"><span class="typeMissed">${escapeHtml(b)}</span></code>`;
  if (a === b) return `<code class="typeans"><span class="typeGood">${escapeHtml(a)}</span></code>`;
  // LCS table
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let typedOut = '', expOut = '';
  let i = 0, j = 0;
  const span = (cls, s) => (s ? `<span class="${cls}">${escapeHtml(s)}</span>` : '');
  let good = '', bad = '', goodE = '', missed = '';
  const flushT = () => { typedOut += span('typeGood', good) + span('typeBad', bad); good = bad = ''; };
  const flushE = () => { expOut += span('typeGood', goodE) + span('typeMissed', missed); goodE = missed = ''; };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (bad) flushT();
      if (missed) flushE();
      good += a[i]; goodE += b[j]; i++; j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      if (goodE) flushE();
      missed += b[j]; j++;
    } else {
      if (good) flushT();
      bad += a[i]; i++;
    }
  }
  flushT(); flushE();
  return `<code class="typeans">${typedOut}<br><span class="typearrow">↓</span><br>${expOut}</code>`;
}
