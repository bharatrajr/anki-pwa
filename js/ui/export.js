// Export screen: .apkg (deck or all, with/without progress and media), .colpkg, .txt, .csv.

import { h, toast, downloadBlob } from './components.js';
import { exportPackage, exportNotesText, exportCsv, exportFilename } from '../io/anki-export.js';

export async function render(app) {
  const col = app.col;
  app.setTitle('Export');
  app.setBack('/backup');
  const params = app.params();
  const st = {
    format: params.get('format') || 'apkg',
    did: Number(params.get('did')) || 0,
    withScheduling: true, withMedia: true,
    html: true, tags: true, deck: true, notetype: true, guid: true,
  };
  const body = h('div');
  app.main.append(body);

  const formats = [
    ['apkg', 'Anki deck package (.apkg)', 'For Anki desktop, AnkiDroid and AnkiMobile: File → Import.'],
    ['colpkg', 'Anki collection package (.colpkg)', 'Everything, with progress and media. Importing it in Anki replaces the collection there.'],
    ['txt', 'Notes in plain text (.txt)', 'Anki’s text format, with GUIDs so re-importing updates instead of duplicating.'],
    ['csv', 'CSV spreadsheet (.csv)', 'For Excel, Google Sheets or other apps. No progress.'],
  ];

  function draw() {
    const toggle = (key, label, hint) => {
      const input = h('input', { type: 'checkbox', checked: !!st[key] });
      input.addEventListener('change', () => { st[key] = input.checked; });
      return h('label', { class: 'switch' }, h('span', {}, label, hint ? h('span', { class: 'hint-text', style: { display: 'block' } }, hint) : null), input);
    };
    const formatList = h('fieldset', { class: 'choice' }, h('legend', { class: 'sr-only' }, 'Format'),
      formats.map(([v, label, hint]) => {
        const r = h('input', { type: 'radio', name: 'fmt', value: v, checked: st.format === v });
        r.addEventListener('change', () => { st.format = v; draw(); });
        return h('label', { class: 'switch' }, h('span', {}, label, h('span', { class: 'hint-text', style: { display: 'block' } }, hint)), r);
      }));
    const deckSel = h('select', { class: 'input', 'aria-label': 'Deck' },
      h('option', { value: '0', selected: !st.did }, 'All decks'),
      [...col.decks.values()].filter((d) => !d.dyn).sort((a, b) => a.name.localeCompare(b.name)).map((d) => h('option', { value: String(d.id), selected: d.id === st.did }, d.name.replaceAll('::', ' › '))));
    deckSel.addEventListener('change', () => { st.did = Number(deckSel.value); });

    const status = h('p', { class: 'small muted', 'aria-live': 'polite' });
    const build = async () => {
      const onProgress = (t) => { status.textContent = t; };
      const did = st.did || null;
      let r, ext;
      if (st.format === 'apkg') { r = await exportPackage(col, { did, withScheduling: st.withScheduling, withMedia: st.withMedia, onProgress }); ext = 'apkg'; }
      else if (st.format === 'colpkg') { r = await exportPackage(col, { full: true, onProgress }); ext = 'colpkg'; }
      else if (st.format === 'txt') { r = await exportNotesText(col, { did, html: st.html, tags: st.tags, deck: st.deck, notetype: st.notetype, guid: st.guid }); ext = 'txt'; }
      else { r = await exportCsv(col, { did, html: st.html }); ext = 'csv'; }
      status.textContent = '';
      const name = exportFilename(col, { did: st.format === 'colpkg' ? null : did, ext });
      return { file: new File([r.blob], name, { type: r.blob.type || 'application/octet-stream' }), counts: r.counts };
    };
    const describe = (c) => [c.notes != null && `${c.notes} notes`, c.cards != null && `${c.cards} cards`, c.revlog && `${c.revlog} reviews`, c.media && `${c.media} media`].filter(Boolean).join(', ');
    const run = async (share) => {
      for (const b of buttons.querySelectorAll('button')) b.disabled = true;
      try {
        const { file, counts } = await build();
        if (share) {
          try { await navigator.share({ files: [file], title: file.name }); toast(`Shared ${file.name}`); }
          catch (e) { if (e.name !== 'AbortError') { downloadBlob(file, file.name); toast('Sharing failed, downloaded instead.'); } }
        } else {
          downloadBlob(file, file.name);
          toast(`Exported ${describe(counts)} (${(file.size / 1048576).toFixed(2)} MB)`);
        }
        if (st.format === 'colpkg') await col.markBackedUp();
      } catch (e) {
        console.error(e);
        status.textContent = `Export failed: ${e.message || e}`;
      } finally {
        for (const b of buttons.querySelectorAll('button')) b.disabled = false;
      }
    };
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.apkg', { type: 'application/octet-stream' })] }));
    const buttons = h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => run(false) }, 'Export'),
      canShare ? h('button', { class: 'btn', type: 'button', onclick: () => run(true) }, 'Share…') : null);

    body.replaceChildren(
      section('Format', formatList),
      section('Options',
        st.format !== 'colpkg' ? h('label', { class: 'field' }, h('span', {}, 'Deck'), deckSel) : h('p', { class: 'muted', style: { margin: '8px 0' } }, 'The whole collection is exported, with progress and media.'),
        st.format === 'apkg' ? [
          toggle('withScheduling', 'Include progress', 'Scheduling, FSRS memory state and review history. Turn off to share a deck with someone else.'),
          toggle('withMedia', 'Include media', 'Images and audio used by the cards.')] : null,
        st.format === 'txt' ? [
          toggle('html', 'Keep HTML formatting'), toggle('guid', 'Include GUID column'), toggle('notetype', 'Include note type column'),
          toggle('deck', 'Include deck column'), toggle('tags', 'Include tags column')] : null,
        st.format === 'csv' ? toggle('html', 'Keep HTML formatting', 'Off gives plain text, easier to edit in a spreadsheet.') : null,
        h('div', { style: { margin: '10px 0' } }, buttons),
        status),
      section('Moving progress between AnkiPWA and Anki',
        h('ol', { style: { margin: '0', paddingLeft: '20px' } },
          h('li', {}, 'To Anki: export an .apkg with progress here, then in Anki use File → Import (AnkiDroid: ⋮ → Import; AnkiMobile: open the file). Notes already in Anki are matched by GUID and updated if this copy is newer.'),
          h('li', {}, 'Back from Anki: in Anki choose Export → Anki Deck Package with “Include scheduling information” and media, then import that file here and keep “Update progress of cards you already have” on.'),
          h('li', {}, 'Full move: a .colpkg replaces the whole collection on the other side, so only use it when one side is empty or out of date.'))));
  }
  draw();
}

function section(title, ...kids) {
  return h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface', style: { padding: '8px 14px' } }, ...kids));
}
