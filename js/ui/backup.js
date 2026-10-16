// Backup & restore (full lossless JSON). Anki import/export screens arrive in later milestones.

import { h, toast, confirmDialog, downloadBlob, pickFile } from './components.js';
import { backupBlob, backupFilename, parseBackup } from '../io/backup.js';
import { fmtDate } from '../util/time.js';

export async function render(app) {
  const col = app.col;
  app.setTitle('Backup');
  const notes = await col.noteCount();
  const cards = await col.cardCount();
  const last = col.col.lastBackup;
  const status = h('p', { class: 'small muted', 'aria-live': 'polite' });

  const makeFile = async () => {
    status.textContent = 'Preparing backup…';
    const blob = await backupBlob(col);
    status.textContent = '';
    return new File([blob], backupFilename(), { type: 'application/json' });
  };

  const download = async () => {
    const file = await makeFile();
    downloadBlob(file, file.name);
    await col.markBackedUp();
    toast(`Backup saved (${(file.size / 1048576).toFixed(2)} MB)`);
    app.go('/backup');
  };

  const share = async () => {
    const file = await makeFile();
    try {
      await navigator.share({ files: [file], title: 'AnkiPWA backup' });
      await col.markBackedUp();
      toast('Backup shared');
      app.go('/backup');
    } catch (e) {
      if (e.name !== 'AbortError') { toast('Sharing failed, downloading instead.'); downloadBlob(file, file.name); await col.markBackedUp(); }
    }
  };

  const restore = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let parsed;
    try { parsed = parseBackup(await file.text()); } catch (e) { toast(e.message); return; }
    const c = parsed.counts;
    const ok = await confirmDialog('Restore this backup?',
      `Backup from ${fmtDate(parsed.created)}: ${c.notes} notes, ${c.cards} cards, ${c.revlog} reviews, ${c.media} media files. Everything currently on this device (${notes} notes, ${cards} cards) will be replaced.`,
      { ok: 'Replace and restore', danger: true });
    if (!ok) return;
    status.textContent = 'Restoring…';
    await col.replaceAll(parsed.data);
    app.applyTheme();
    status.textContent = '';
    toast('Backup restored');
    app.go('/');
  };

  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] }));
  const section = (title, ...kids) => h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface', style: { padding: '14px' } }, ...kids));

  app.main.append(
    section('Full backup',
      h('p', { style: { marginTop: 0 } }, 'Everything in one file: decks, notes, cards, review history, media and settings. Keep a copy somewhere safe, such as Google Drive, at least once a week.'),
      h('p', { class: 'small muted' }, `${notes} notes · ${cards} cards · last backup: ${last ? fmtDate(last) : 'never'}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: download }, 'Download backup'),
        canShareFiles ? h('button', { class: 'btn', type: 'button', onclick: share }, 'Share to Drive / WhatsApp…') : null),
      status),
    section('Restore',
      h('p', { style: { marginTop: 0 } }, 'Load a backup file made by this app. This replaces everything on this device.'),
      h('button', { class: 'btn', type: 'button', onclick: restore }, 'Restore from file…')),
    section('Anki files',
      h('p', { style: { margin: 0 }, class: 'muted' }, 'Importing .apkg / .colpkg / text files from Anki, AnkiDroid and AnkiMobile, and exporting back with your progress, come in the next updates.'))
  );
}
