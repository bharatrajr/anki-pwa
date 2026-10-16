// Import screen: Anki packages (.apkg / .colpkg), Anki text, CSV/TSV, Quizlet and JSON.
// Files can also arrive from the Android share sheet (Share Target) or a file handler.

import { h, toast, confirmDialog, pickFile, sheet } from './components.js';
import { readAnkiPackage } from '../io/anki-read.js';
import { mergePackage, replaceWithPackage, packageSummary } from '../io/anki-import.js';
import { parseAnkiText, parseDelimited, parseQuizlet, parseJsonNotes, suggestMapping, importRows } from '../io/text-import.js';
import { DEFAULT_DECK_ID } from '../db/collection.js';

const ACCEPT = '.apkg,.colpkg,.txt,.csv,.tsv,.json,text/plain,text/csv,text/tab-separated-values,application/json,application/zip,application/octet-stream';
const SHARE_CACHE = 'ankipwa-share';

/** A file handed over by the share sheet / file handler, waiting to be imported. */
let pendingFile = null;
export function setPendingFile(file) { pendingFile = file; }

export async function render(app) {
  const col = app.col;
  app.setTitle('Import');
  app.setBack('/backup');
  const body = h('div');
  app.main.append(body);

  const start = () => {
    body.replaceChildren(
      section('Import a file',
        h('p', { style: { marginTop: 0 } }, 'Anki decks and collections (.apkg, .colpkg) from Anki desktop, AnkiDroid or AnkiMobile, including scheduling, review history and media. Also Anki text exports, CSV/TSV spreadsheets, Quizlet exports and JSON.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', onclick: async () => { const f = await pickFile(ACCEPT); if (f) handleFile(f); } }, 'Choose file…'),
          h('button', { class: 'btn', type: 'button', onclick: pasteText }, 'Paste text…')),
        h('p', { class: 'hint-text' }, 'On Android you can also share a file to AnkiPWA from Files, Drive or WhatsApp.')),
    );
  };

  async function pasteText() {
    const text = await sheet('Paste text', (close) => {
      const ta = h('textarea', { class: 'input', rows: 10, placeholder: 'term<Tab>definition, one per line (Quizlet: Export → copy)', 'aria-label': 'Text to import' });
      setTimeout(() => ta.focus(), 30);
      return h('div', {}, ta, h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => close(ta.value) }, 'Next')));
    });
    if (text?.trim()) showText(text, 'pasted.txt', true);
  }

  async function handleFile(file) {
    const name = file.name || 'file';
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    if (/\.(apkg|colpkg)$/i.test(name) || isZip) return showPackage(file, name);
    const text = await file.text();
    return showText(text, name, false);
  }

  // ---------- Anki packages ----------
  async function showPackage(file, name) {
    const status = h('p', { class: 'small muted', 'aria-live': 'polite' }, 'Reading the file…');
    body.replaceChildren(section(name, status));
    let pkg;
    try { pkg = await readAnkiPackage(file, { filename: name }); }
    catch (e) { console.error(e); status.textContent = ''; body.append(errorBox(e)); return; }
    const s = packageSummary(pkg);
    const isCol = pkg.kind === 'colpkg';
    const mine = { notes: await col.noteCount(), cards: await col.cardCount() };

    const modeReplace = h('input', { type: 'radio', name: 'mode', value: 'replace', checked: isCol });
    const modeMerge = h('input', { type: 'radio', name: 'mode', value: 'merge', checked: !isCol });
    const withSched = h('input', { type: 'checkbox', checked: true });
    const updSched = h('input', { type: 'checkbox', checked: true });
    const updNotes = h('select', { class: 'input' },
      h('option', { value: 'newer', selected: true }, 'If the file’s copy is newer'),
      h('option', { value: 'always' }, 'Always'),
      h('option', { value: 'never' }, 'Never'));
    const mergeOpts = h('div', {},
      h('label', { class: 'switch' }, h('span', {}, 'Include progress', h('span', { class: 'hint-text', style: { display: 'block' } }, 'Scheduling and review history. Off imports every card as new.')), withSched),
      h('label', { class: 'switch' }, h('span', {}, 'Update progress of cards you already have', h('span', { class: 'hint-text', style: { display: 'block' } }, 'When the file’s card was reviewed more recently than yours. This is how you bring progress back from Anki.')), updSched),
      h('label', { class: 'field' }, h('span', {}, 'Update existing notes'), updNotes));
    const syncMode = () => { mergeOpts.hidden = modeReplace.checked; };
    modeReplace.addEventListener('change', syncMode);
    modeMerge.addEventListener('change', syncMode);
    syncMode();

    const go = h('button', { class: 'btn primary block', type: 'button' }, 'Import');
    go.addEventListener('click', async () => {
      const replace = modeReplace.checked;
      if (replace && !(await confirmDialog('Replace everything?', `Everything on this device (${mine.notes} notes, ${mine.cards} cards) will be replaced by this collection. Download a backup first if you might want it back.`, { ok: 'Replace', danger: true }))) return;
      go.disabled = true;
      const onProgress = (t) => { status.textContent = t; };
      try {
        const r = replace
          ? await replaceWithPackage(col, pkg, { onProgress })
          : await mergePackage(col, pkg, { withScheduling: withSched.checked, updateScheduling: updSched.checked, updateNotes: updNotes.value, onProgress });
        app.applyTheme();
        showResult(r);
      } catch (e) {
        console.error(e);
        go.disabled = false;
        status.textContent = '';
        body.append(errorBox(e));
      }
    });

    status.textContent = '';
    body.replaceChildren(
      section(name,
        h('p', { style: { marginTop: 0 } }, `${isCol ? 'Anki collection' : 'Anki deck package'}: ${s.notes} notes, ${s.cards} cards (${s.reviewed} studied), ${s.revlog} reviews, ${s.media} media files.`),
        s.decks.length ? h('p', { class: 'small muted' }, `Decks: ${s.decks.slice(0, 12).join(', ')}${s.decks.length > 12 ? ` and ${s.decks.length - 12} more` : ''}`) : null,
        h('fieldset', { class: 'choice' },
          h('legend', { class: 'sr-only' }, 'How to import'),
          h('label', { class: 'switch' }, h('span', {}, 'Add to my collection', h('span', { class: 'hint-text', style: { display: 'block' } }, 'Notes already here (same GUID) are matched, not duplicated.')), modeMerge),
          h('label', { class: 'switch' }, h('span', {}, 'Replace everything on this device', h('span', { class: 'hint-text', style: { display: 'block' } }, isCol ? 'Like Anki does with a .colpkg.' : 'Delete what is here first.')), modeReplace)),
        mergeOpts,
        h('div', { style: { margin: '12px 0 6px' } }, go),
        status));
  }

  // ---------- text ----------
  function showText(text, name, pasted) {
    const isJson = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
    let parsed;
    const st = {
      format: isJson ? 'json' : 'anki',
      sep: null, headerRow: null, termSep: '\t', rowSep: '\n',
      ntid: (col.notetypeByName('Basic') || [...col.notetypes.values()][0]).id,
      did: DEFAULT_DECK_ID, html: null, tags: '', dupes: 'update', mapping: null,
    };
    if (pasted) st.format = 'quizlet';

    const reparse = () => {
      if (st.format === 'json') {
        const j = parseJsonNotes(text);
        parsed = { rows: j.rows, columns: j.columns, header: {}, sep: null };
      } else if (st.format === 'quizlet') {
        parsed = { rows: parseQuizlet(text, unescapeSep(st.termSep), unescapeSep(st.rowSep)), columns: null, header: {}, sep: null };
      } else {
        const a = parseAnkiText(text);
        if (st.sep && st.sep !== a.sep) a.rows = parseDelimited(text.split(/\r?\n/).filter((l) => !/^#[a-z ]+:/i.test(l)).join('\n'), st.sep);
        parsed = { ...a };
        st.sep = st.sep || a.sep;
        if (a.header.notetype && col.notetypeByName(a.header.notetype)) st.ntid = col.notetypeByName(a.header.notetype).id;
        if (a.header.deck) { const d = col.deckByName(a.header.deck); if (d) st.did = d.id; }
        if (st.html === null && a.header.html !== null) st.html = a.header.html;
        if (a.header.tags.length && !st.tags) st.tags = a.header.tags.join(' ');
        if (st.headerRow === null) {
          // A first row naming the note type's fields (or Tags/Deck) is a header.
          const names = new Set([...col.notetypes.get(st.ntid).fields.map((f) => f.name.toLowerCase()), 'tags', 'deck', 'guid', 'note type', 'notetype']);
          st.headerRow = !a.columns && !a.hasHeaderLines && !!a.rows[0]?.some((v) => names.has(v.trim().toLowerCase()));
        }
        if (st.headerRow && parsed.rows.length) parsed = { ...parsed, columns: parsed.rows[0], rows: parsed.rows.slice(1) };
      }
      if (st.html === null) st.html = parsed.rows.slice(0, 50).some((r) => r.some((v) => /<[a-z][^>]*>/i.test(v)));
      const ncols = Math.max(0, ...parsed.rows.slice(0, 200).map((r) => r.length));
      st.mapping = suggestMapping(parsed.columns, ncols, col.notetypes.get(st.ntid), parsed.header);
    };

    const draw = () => {
      try { reparse(); } catch (e) { body.replaceChildren(errorBox(e)); return; }
      const nt = col.notetypes.get(st.ntid);
      const ncols = st.mapping.length;
      const targets = [['', 'Ignore'], ...nt.fields.map((f, i) => [`f:${i}`, `Field: ${f.name}`]), ['tags', 'Tags'], ['deck', 'Deck'], ['notetype', 'Note type'], ['guid', 'GUID']];
      const sel = (value, options, onChange, label) => {
        const el = h('select', { class: 'input', 'aria-label': label }, options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === String(value) }, t)));
        el.addEventListener('change', () => onChange(el.value));
        return el;
      };
      const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
      const sample = (ci) => parsed.rows.slice(0, 3).map((r) => r[ci] ?? '').filter(Boolean).map((v) => v.replace(/<[^>]+>/g, ' ').slice(0, 40)).join(' · ');

      const formatSel = sel(st.format, [['anki', 'Anki text / CSV / TSV'], ['quizlet', 'Quizlet'], ['json', 'JSON']], (v) => { st.format = v; st.mapping = null; draw(); }, 'Format');
      const sepSel = sel(st.sep || '\t', [['\t', 'Tab'], [',', 'Comma'], [';', 'Semicolon'], ['|', 'Pipe'], [':', 'Colon'], [' ', 'Space']], (v) => { st.sep = v; draw(); }, 'Separator');
      const ntSel = sel(st.ntid, [...col.notetypes.values()].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name]), (v) => { st.ntid = Number(v); draw(); }, 'Note type');
      const deckSel = sel(st.did, [...col.decks.values()].filter((d) => !d.dyn).sort((a, b) => a.name.localeCompare(b.name)).map((d) => [d.id, d.name.replaceAll('::', ' › ')]), (v) => { st.did = Number(v); }, 'Deck');
      const dupSel = sel(st.dupes, [['update', 'Update the existing note'], ['skip', 'Skip'], ['add', 'Add anyway']], (v) => { st.dupes = v; }, 'Duplicates');
      const htmlBox = h('input', { type: 'checkbox', checked: !!st.html });
      htmlBox.addEventListener('change', () => { st.html = htmlBox.checked; });
      const headBox = h('input', { type: 'checkbox', checked: st.headerRow });
      headBox.addEventListener('change', () => { st.headerRow = headBox.checked; draw(); });
      const tagsIn = h('input', { class: 'input', value: st.tags, placeholder: 'space-separated', autocapitalize: 'off' });
      tagsIn.addEventListener('input', () => { st.tags = tagsIn.value; });
      const termIn = h('input', { class: 'input', value: escapeSep(st.termSep), 'aria-label': 'Between term and definition' });
      termIn.addEventListener('change', () => { st.termSep = termIn.value; draw(); });
      const rowIn = h('input', { class: 'input', value: escapeSep(st.rowSep), 'aria-label': 'Between rows' });
      rowIn.addEventListener('change', () => { st.rowSep = rowIn.value; draw(); });

      const mapRows = Array.from({ length: ncols }, (_, ci) => h('label', { class: 'field' },
        h('span', {}, `Column ${ci + 1}${parsed.columns?.[ci] ? ` “${parsed.columns[ci]}”` : ''}`, h('span', { class: 'hint-text', style: { display: 'block', fontWeight: 400 } }, sample(ci) || '(empty)')),
        sel(st.mapping[ci], targets, (v) => { st.mapping[ci] = v; }, `Column ${ci + 1}`)));

      const status = h('p', { class: 'small muted', 'aria-live': 'polite' });
      const go = h('button', { class: 'btn primary block', type: 'button' }, `Import ${parsed.rows.length} note${parsed.rows.length === 1 ? '' : 's'}`);
      go.addEventListener('click', async () => {
        if (!st.mapping.some((m) => m === 'f:0')) { toast(`Choose a column for “${nt.fields[0].name}”.`); return; }
        go.disabled = true;
        try {
          const r = await importRows(col, parsed.rows, { mapping: st.mapping, ntid: st.ntid, did: st.did, html: st.html, tags: st.tags.split(/\s+/).filter(Boolean), dupes: st.dupes, onProgress: (t) => { status.textContent = t; } });
          showResult({ mode: 'text', notesAdded: r.added, notesUpdated: r.updated, notesSkipped: r.skipped, cardsAdded: r.cards, errors: r.errors });
        } catch (e) { console.error(e); go.disabled = false; body.append(errorBox(e)); }
      });

      body.replaceChildren(
        section(name,
          field('Format', formatSel),
          st.format === 'anki' ? field('Separator', sepSel) : null,
          st.format === 'anki' && !parsed.hasHeaderLines ? h('label', { class: 'switch' }, h('span', {}, 'First row has column names'), headBox) : null,
          st.format === 'quizlet' ? h('div', { class: 'row', style: { alignItems: 'flex-start' } },
            h('label', { class: 'field', style: { flex: '1 1 140px' } }, h('span', {}, 'Between term and definition'), termIn),
            h('label', { class: 'field', style: { flex: '1 1 140px' } }, h('span', {}, 'Between rows'), rowIn)) : null,
          st.format === 'quizlet' ? h('p', { class: 'hint-text' }, 'Use \\t for Tab and \\n for a new line, matching what you chose in Quizlet’s export.') : null,
          field('Note type', ntSel),
          field('Deck', deckSel),
          h('label', { class: 'switch' }, h('span', {}, 'Fields contain HTML', h('span', { class: 'hint-text', style: { display: 'block' } }, 'Off treats text literally and keeps line breaks.')), htmlBox),
          field('Add tags', tagsIn),
          field('When a note already exists', dupSel)),
        section('Columns', mapRows.length ? mapRows : h('p', { class: 'muted' }, 'No rows found.')),
        h('div', { class: 'sticky-actions' }, go),
        status);
    };
    draw();
  }

  function showResult(r) {
    const lines = [];
    if (r.mode === 'replace') lines.push(`Collection replaced: ${r.notesAdded} notes, ${r.cardsAdded} cards, ${r.revlogAdded} reviews, ${r.mediaAdded} media files.`);
    else {
      lines.push(`${r.notesAdded} new note${r.notesAdded === 1 ? '' : 's'} (${r.cardsAdded} cards).`);
      if (r.notesUpdated) lines.push(`${r.notesUpdated} existing note${r.notesUpdated === 1 ? '' : 's'} updated.`);
      if (r.notesSkipped) lines.push(`${r.notesSkipped} skipped (already here, unchanged or empty).`);
      if (r.cardsUpdated) lines.push(`Progress updated on ${r.cardsUpdated} card${r.cardsUpdated === 1 ? '' : 's'}.`);
      if (r.revlogAdded) lines.push(`${r.revlogAdded} reviews added to the history.`);
      if (r.mediaAdded) lines.push(`${r.mediaAdded} media file${r.mediaAdded === 1 ? '' : 's'} added.`);
    }
    body.replaceChildren(section('Import finished',
      ...lines.map((l) => h('p', { style: { margin: '4px 0' } }, l)),
      r.errors?.length ? h('details', {}, h('summary', {}, `${r.errors.length} row(s) had problems`), h('ul', { class: 'small' }, r.errors.slice(0, 50).map((e) => h('li', {}, e)))) : null,
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('a', { class: 'btn primary', href: '#/' }, 'Go to decks'),
        h('button', { class: 'btn', type: 'button', onclick: start }, 'Import another'))));
    toast('Import finished');
  }

  // Share target / file handler hand-off.
  let shared = pendingFile;
  pendingFile = null;
  if (!shared && app.params().get('shared') && 'caches' in globalThis) {
    try {
      const cache = await caches.open(SHARE_CACHE);
      const res = await cache.match('shared-file');
      if (res) {
        const nameHdr = decodeURIComponent(res.headers.get('X-Filename') || 'shared.txt');
        shared = new File([await res.blob()], nameHdr, { type: res.headers.get('Content-Type') || '' });
        await cache.delete('shared-file');
      }
    } catch (e) { console.warn(e); }
  }
  if (shared) handleFile(shared); else start();
}

function section(title, ...kids) {
  return h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface', style: { padding: '12px 14px' } }, ...kids));
}

function errorBox(e) {
  return h('div', { class: 'banner', role: 'alert', style: { marginTop: '12px' } }, h('span', { class: 'spacer' }, String(e.message || e)));
}

const unescapeSep = (s) => String(s).replace(/\\t/g, '\t').replace(/\\n/g, '\n');
const escapeSep = (s) => String(s).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
