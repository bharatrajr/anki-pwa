// Small DOM helpers: element builder, toast, bottom-sheet dialogs, confirm/prompt.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
export function toast(msg, { action, onAction, ms = 3500 } = {}) {
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', {}, msg));
  if (action) t.append(h('button', { type: 'button', onclick: () => { t.hidden = true; onAction?.(); } }, action));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Open a bottom sheet. content: Node or (close) => Node. Resolves with the value passed to close(). */
export function sheet(title, content) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'sheet', 'aria-label': title });
    let result;
    const close = (v) => { result = v; dlg.close(); };
    const body = typeof content === 'function' ? content(close) : content;
    dlg.append(
      h('div', { class: 'sheet-head' },
        h('h2', {}, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close(undefined) }, '✕')),
      h('div', { class: 'sheet-body' }, body)
    );
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(undefined); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  return sheet(title, (close) =>
    h('div', {},
      h('p', {}, message),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => close(true) }, ok)))
  ).then((v) => !!v);
}

export function promptDialog(title, { label = '', value = '', placeholder = '', hint = '', ok = 'OK', inputmode } = {}) {
  return sheet(title, (close) => {
    const input = h('input', { class: 'input', value, placeholder, 'aria-label': label || title, inputmode, autocomplete: 'off' });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); close(input.value); } },
      label ? h('label', { class: 'field' }, h('span', {}, label), input) : input,
      hint ? h('p', { class: 'hint-text' }, hint) : null,
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, ok)));
    return form;
  });
}

/** A list of menu buttons in a sheet; items: [{label, key?, icon?, onClick}] (null = skip). */
export function menuSheet(title, items) {
  return sheet(title, (close) =>
    h('div', { class: 'menu-list', role: 'menu' },
      items.filter(Boolean).map((it) =>
        h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); it.onClick(); } },
          it.icon ? h('span', { 'aria-hidden': 'true' }, it.icon) : null,
          h('span', {}, it.label),
          it.key ? h('kbd', {}, it.key) : null)))
  );
}

export const FLAG_NAMES = ['No flag', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'];

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}
