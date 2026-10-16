// Anki-style search (https://docs.ankiweb.net/searching.html), the common subset:
//   words and "quoted phrases" (case-insensitive; * any text, _ one character)
//   -term (not), a or b, (grouping), implicit AND
//   deck:Name (with subdecks; * wildcard)  tag:x (with child tags; tag:none)
//   note:Basic  card:1 / card:"Card 2"  field:value  re:regex  nid:1,2  cid:1,2
//   is:new is:learn is:review is:due is:suspended is:buried is:flagged
//   flag:0-7  prop:ivl>10 (ivl due reps lapses ease pos s d r)
//   added:N edited:N rated:N[:1-4] introduced:N

import { stripHtml } from '../render/html.js';
import { retrievability, normaliseParams } from '../sched/fsrs.js';

// ---------- parsing ----------

function tokenize(q) {
  const out = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { out.push(ch); i++; continue; }
    let tok = '', quoted = false;
    while (i < q.length && !/\s/.test(q[i]) && q[i] !== '(' && q[i] !== ')') {
      if (q[i] === '"') {
        if (tok === '') quoted = true; // "whole phrase"; key:"value" stays a key search
        i++;
        while (i < q.length && q[i] !== '"') { if (q[i] === '\\' && q[i + 1] === '"') { tok += '"'; i += 2; continue; } tok += q[i++]; }
        i++;
        continue;
      }
      tok += q[i++];
    }
    out.push({ text: tok, quoted });
  }
  return out;
}

/** Parse a query into an AST: {op:'and'|'or', items} | {op:'not', item} | {op:'term', key, value}. */
export function parseQuery(q) {
  const toks = tokenize(String(q || ''));
  let pos = 0;
  const peek = () => toks[pos];
  const isWord = (t, w) => t && typeof t === 'object' && !t.quoted && t.text.toLowerCase() === w;
  function parseOr() {
    const items = [parseAnd()];
    while (isWord(peek(), 'or')) { pos++; items.push(parseAnd()); }
    return items.length === 1 ? items[0] : { op: 'or', items };
  }
  function parseAnd() {
    const items = [];
    while (pos < toks.length && peek() !== ')' && !isWord(peek(), 'or')) {
      if (isWord(peek(), 'and')) { pos++; continue; }
      items.push(parseUnary());
    }
    return items.length === 1 ? items[0] : { op: 'and', items };
  }
  function parseUnary() {
    const t = toks[pos++];
    if (t === '(') { const e = parseOr(); if (peek() === ')') pos++; return e; }
    if (t === ')') return { op: 'and', items: [] };
    if (!t.quoted && t.text.startsWith('-') && t.text.length > 1) return { op: 'not', item: termOf(t.text.slice(1), false) };
    if (!t.quoted && t.text === '-') { const next = parseUnary(); return { op: 'not', item: next }; }
    return termOf(t.text, t.quoted);
  }
  function termOf(text, quoted) {
    const m = quoted ? null : /^([a-z_-]+):(.*)$/is.exec(text);
    if (m) return { op: 'term', key: m[1].toLowerCase(), value: m[2] };
    return { op: 'term', key: '', value: text };
  }
  const ast = pos < toks.length ? parseOr() : { op: 'and', items: [] };
  return ast;
}

// ---------- matching helpers ----------

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** Anki glob: * = any, _ = one char, \* and \_ literal. */
export function globToRegex(glob, { whole = true } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && (glob[i + 1] === '*' || glob[i + 1] === '_')) { re += escapeRe(glob[++i]); continue; }
    if (c === '*') re += '.*';
    else if (c === '_') re += '.';
    else re += escapeRe(c);
  }
  return new RegExp(whole ? `^${re}$` : re, 'is');
}

const textCache = new WeakMap();
function noteText(note) {
  let t = textCache.get(note);
  if (t === undefined) { t = stripHtml(note.fields.join(' ')).replace(/\s+/g, ' '); textCache.set(note, t); }
  return t;
}

function cmp(a, op, b) {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '!=': return a !== b;
    default: return Math.abs(a - b) < 1e-9 || a === b;
  }
}

// ---------- compiling ----------

/**
 * Compile a query. ctx = { col, timing }. Returns { test(card, note), needsRevlog }.
 * When needsRevlog, call prepare(revlogRows) before testing.
 */
export function compileQuery(query, ctx) {
  const ast = typeof query === 'string' ? parseQuery(query) : query;
  const { col, timing } = ctx;
  const dayStartMs = (daysBack) => timing.nextDayStart - daysBack * 86400000;
  const revNeeds = [];
  const deckNameCache = new Map();
  const deckName = (did) => {
    if (!deckNameCache.has(did)) deckNameCache.set(did, col.decks.get(did)?.name || '');
    return deckNameCache.get(did);
  };

  const build = (node) => {
    if (node.op === 'and') { const fs = node.items.map(build); return (c, n) => fs.every((f) => f(c, n)); }
    if (node.op === 'or') { const fs = node.items.map(build); return (c, n) => fs.some((f) => f(c, n)); }
    if (node.op === 'not') { const f = build(node.item); return (c, n) => !f(c, n); }
    return buildTerm(node.key, node.value);
  };

  const buildTerm = (key, value) => {
    const v = value;
    const lower = v.toLowerCase();
    switch (key) {
      case '': {
        if (!v) return () => true;
        const re = globToRegex(v, { whole: false });
        return (c, n) => re.test(noteText(n));
      }
      case 'deck': {
        if (v === '*') return () => true;
        if (lower === 'filtered') return (c) => !!c.odid;
        const re = globToRegex(v);
        const reChild = globToRegex(`${v}::*`);
        return (c) => {
          for (const did of c.odid ? [c.did, c.odid] : [c.did]) {
            const name = deckName(did);
            if (re.test(name) || reChild.test(name)) return true;
          }
          return false;
        };
      }
      case 'tag': {
        if (lower === 'none') return (c, n) => n.tags.length === 0;
        const re = globToRegex(v);
        const reChild = globToRegex(`${v}::*`);
        return (c, n) => n.tags.some((t) => re.test(t) || reChild.test(t));
      }
      case 'note': case 'notetype': case 'mid': {
        const re = globToRegex(v);
        return (c, n) => re.test(col.notetypes.get(n.ntid)?.name || '') || String(n.ntid) === v;
      }
      case 'card': {
        if (/^\d+$/.test(v)) { const ord = +v - 1; return (c) => c.ord === ord; }
        const re = globToRegex(v);
        return (c, n) => {
          const nt = col.notetypes.get(n.ntid);
          return !!nt && re.test(nt.templates.find((t) => t.ord === c.ord)?.name || (nt.kind === 1 ? `Cloze ${c.ord + 1}` : ''));
        };
      }
      case 'is': return isTerm(lower, timing, col);
      case 'flag': { const f = parseInt(v, 10) || 0; return (c) => (c.flags & 7) === f; }
      case 'prop': return propTerm(v, timing, col);
      case 'nid': { const ids = new Set(v.split(',').map(Number)); return (c, n) => ids.has(n.id); }
      case 'cid': { const ids = new Set(v.split(',').map(Number)); return (c) => ids.has(c.id); }
      case 'added': { const since = dayStartMs(Math.max(1, parseInt(v, 10) || 1)); return (c) => c.id >= since; }
      case 'edited': { const since = dayStartMs(Math.max(1, parseInt(v, 10) || 1)); return (c, n) => (n.mod || 0) >= since; }
      case 'rated': case 'introduced': {
        const [daysStr, easeStr] = v.split(':');
        const since = dayStartMs(Math.min(365 * 100, Math.max(1, parseInt(daysStr, 10) || 1)));
        const need = { kind: key, since, ease: easeStr ? parseInt(easeStr, 10) : null, set: new Set() };
        revNeeds.push(need);
        return (c) => need.set.has(c.id);
      }
      case 're': {
        let re;
        try { re = new RegExp(v, 'i'); } catch { return () => false; }
        return (c, n) => re.test(n.fields.join('\x1f'));
      }
      case 'dupe': return () => false;
      default: {
        // field:value — search inside one field (field name may use wildcards).
        const fre = globToRegex(key);
        const vre = globToRegex(v);
        return (c, n) => {
          const nt = col.notetypes.get(n.ntid);
          if (!nt) return false;
          return nt.fields.some((f, i) => fre.test(f.name) && vre.test(stripHtml(n.fields[i] || '').trim()));
        };
      }
    }
  };

  const test = build(ast);
  return {
    test,
    needsRevlog: revNeeds.length > 0,
    prepare(revlog) {
      for (const need of revNeeds) {
        need.set.clear();
        if (need.kind === 'rated') {
          for (const r of revlog) if (r.id >= need.since && r.type !== 4 && (need.ease === null || r.ease === need.ease)) need.set.add(r.cid);
        } else {
          const first = new Map();
          for (const r of revlog) if (r.type !== 4 && (!first.has(r.cid) || r.id < first.get(r.cid))) first.set(r.cid, r.id);
          for (const [cid, id] of first) if (id >= need.since) need.set.add(cid);
        }
      }
    },
  };
}

function isTerm(what, timing, col) {
  const nowSec = Math.floor(timing.now / 1000) + (col.settings?.learnAheadMins || 0) * 60;
  switch (what) {
    case 'new': return (c) => c.type === 0;
    case 'learn': return (c) => c.type === 1 || c.type === 3;
    case 'review': return (c) => c.type === 2 || c.type === 3;
    case 'due': return (c) => ((c.queue === 2 || c.queue === 3) && c.due <= timing.today) || (c.queue === 1 && c.due <= nowSec);
    case 'suspended': case 'susp': return (c) => c.queue === -1;
    case 'buried': return (c) => c.queue === -2 || c.queue === -3;
    case 'flagged': return (c) => (c.flags & 7) !== 0;
    default: return () => false;
  }
}

function propTerm(v, timing, col) {
  const m = /^([a-z]+)(<=|>=|!=|=|<|>)(-?\d+(?:\.\d+)?)$/i.exec(v);
  if (!m) return () => false;
  const [, prop, op, numStr] = m;
  const num = parseFloat(numStr);
  const get = {
    ivl: (c) => (c.type === 2 || c.type === 3 ? c.ivl : null),
    due: (c) => (c.queue === 2 || c.queue === 3 ? c.due - timing.today : c.queue === 1 ? Math.floor((c.due * 1000 - timing.now) / 86400000) : null),
    reps: (c) => c.reps,
    lapses: (c) => c.lapses,
    ease: (c) => (c.factor ? c.factor / 1000 : null),
    pos: (c) => (c.type === 0 ? c.due : null),
    s: (c) => c.stability || null,
    d: (c) => (c.difficulty ? (c.difficulty - 1) / 9 : null),
    r: (c) => cardRetrievability(c, timing, col),
  }[prop.toLowerCase()];
  if (!get) return () => false;
  return (c) => { const x = get(c); return x !== null && x !== undefined && cmp(x, op, num); };
}

/** Current FSRS retrievability of a card (0–1), or null for new / unscheduled cards. */
export function cardRetrievability(c, timing, col) {
  if (!c.stability || !c.lastReview) return null;
  const preset = col.presetFor(c.odid || c.did);
  return retrievability(normaliseParams(preset.fsrsParams), Math.max(0, timing.today - timing.dayOf(c.lastReview)), c.stability);
}

/** Run a search over the collection. Returns [{card, note}]. */
export async function searchCards(col, query, { timing = col.timing() } = {}) {
  const compiled = compileQuery(query, { col, timing });
  if (compiled.needsRevlog) compiled.prepare(await col.allRevlog());
  const [cards, notes] = await Promise.all([col.allCards(), col.allNotes()]);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const out = [];
  for (const c of cards) {
    const n = byId.get(c.nid);
    if (n && compiled.test(c, n)) out.push({ card: c, note: n });
  }
  return out;
}
