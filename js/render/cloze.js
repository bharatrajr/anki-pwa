// Cloze parsing and rendering compatible with Anki (rslib/src/cloze.rs) for the
// common cases: {{c1::answer}}, {{c1::answer::hint}}, several numbers per note,
// the same number used more than once, and nested clozes.

const OPEN_RE = /\{\{c(\d+)::/y;

/** Parse text into a tree: strings and {ord, children[], hint} nodes. */
export function parseCloze(text) {
  const root = { children: [] };
  const stack = [root];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) { stack[stack.length - 1].children.push(buf); buf = ''; }
  };
  while (i < text.length) {
    OPEN_RE.lastIndex = i;
    const m = OPEN_RE.exec(text);
    if (m) {
      flush();
      const node = { ord: parseInt(m[1], 10), children: [], hint: null };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      i += m[0].length;
      continue;
    }
    if (stack.length > 1 && text.startsWith('}}', i)) {
      flush();
      const node = stack.pop();
      // Split a trailing "::hint" off the last text child.
      const last = node.children[node.children.length - 1];
      if (typeof last === 'string') {
        const idx = last.indexOf('::');
        if (idx >= 0) {
          node.hint = last.slice(idx + 2);
          const before = last.slice(0, idx);
          if (before) node.children[node.children.length - 1] = before;
          else node.children.pop();
        }
      }
      i += 2;
      continue;
    }
    buf += text[i];
    i++;
  }
  flush();
  // Unclosed clozes: treat their opening marker as plain text, like Anki.
  while (stack.length > 1) {
    const node = stack.pop();
    const parent = stack[stack.length - 1];
    const idx = parent.children.indexOf(node);
    parent.children.splice(idx, 1, `{{c${node.ord}::`, ...node.children);
  }
  return root.children;
}

/** All cloze numbers present in a text (Set of ints ≥1). */
export function clozeNumbers(text) {
  const out = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (typeof n !== 'string') { out.add(n.ord); walk(n.children); }
    }
  };
  walk(parseCloze(text || ''));
  return out;
}

function nodeText(nodes) {
  return nodes.map((n) => (typeof n === 'string' ? n : nodeText(n.children))).join('');
}

function containsOrd(nodes, ord) {
  return nodes.some((n) => typeof n !== 'string' && (n.ord === ord || containsOrd(n.children, ord)));
}

/**
 * Render the cloze field for card `ord` (1-based cloze number).
 * side: 'q' or 'a'. opts.blankText overrides "[...]" (used for TTS/search).
 */
export function renderCloze(text, ord, side, opts = {}) {
  const nodes = parseCloze(text || '');
  const render = (list) =>
    list
      .map((n) => {
        if (typeof n === 'string') return n;
        if (n.ord === ord) {
          if (side === 'q') {
            if (opts.blankText !== undefined) return opts.blankText;
            const label = n.hint ? `[${n.hint}]` : '[...]';
            return `<span class="cloze" data-cloze="${escapeAttr(nodeText(n.children))}" data-ordinal="${n.ord}">${label}</span>`;
          }
          return `<span class="cloze" data-ordinal="${n.ord}">${render(n.children)}</span>`;
        }
        // Inactive cloze: show its content; nested active ones still render as active.
        const inner = render(n.children);
        if (opts.blankText !== undefined) return inner;
        return `<span class="cloze-inactive" data-ordinal="${n.ord}">${inner}</span>`;
      })
      .join('');
  return render(nodes);
}

/** {{cloze-only:Field}}: just the answers of the active cloze, comma-separated. */
export function clozeOnly(text, ord) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (typeof n === 'string') continue;
      if (n.ord === ord) out.push(nodeText(n.children));
      else walk(n.children);
    }
  };
  walk(parseCloze(text || ''));
  return out.join(', ');
}

export function hasCloze(text, ord) {
  return containsOrd(parseCloze(text || ''), ord);
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
