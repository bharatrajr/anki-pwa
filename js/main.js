// App boot: open the collection, ask for persistent storage, register the service
// worker, and route between screens (hash router so it works under any sub-path).

import { Collection } from './db/collection.js';
import { h, toast } from './ui/components.js';
import * as decksView from './ui/decks.js';
import * as overviewView from './ui/overview.js';
import * as reviewView from './ui/review.js';
import * as editorView from './ui/editor.js';
import * as optionsView from './ui/options.js';
import * as settingsView from './ui/settings.js';
import * as backupView from './ui/backup.js';
import * as helpView from './ui/help.js';
import * as importView from './ui/import.js';
import * as exportView from './ui/export.js';
import * as browseView from './ui/browse.js';
import * as statsView from './ui/stats.js';

export const APP_VERSION = '0.3.1';

const routes = [
  [/^\/?$/, decksView, 'decks'],
  [/^\/deck\/(\d+)$/, overviewView, 'decks'],
  [/^\/review\/(\d+)$/, reviewView, 'decks'],
  [/^\/add$/, editorView, 'add'],
  [/^\/edit\/(\d+)$/, editorView, 'decks'],
  [/^\/options\/(\d+)$/, optionsView, 'decks'],
  [/^\/settings$/, settingsView, 'decks'],
  [/^\/backup$/, backupView, 'backup'],
  [/^\/import$/, importView, 'backup'],
  [/^\/export$/, exportView, 'backup'],
  [/^\/browse$/, browseView, 'browse'],
  [/^\/stats$/, statsView, 'stats'],
  [/^\/help$/, helpView, 'decks'],
];

const app = {
  col: null,
  version: APP_VERSION,
  installPrompt: null,
  storagePersisted: null,
  cleanup: null,
  main: document.getElementById('main'),
  setTitle(t) { document.getElementById('title').textContent = t; document.title = t === 'AnkiPWA' ? t : `${t} · AnkiPWA`; },
  setBack(href) {
    const b = document.getElementById('back-btn');
    b.hidden = !href;
    b.onclick = href ? () => (typeof href === 'function' ? href() : app.go(href)) : null;
  },
  setActions(...nodes) { document.getElementById('bar-actions').replaceChildren(...nodes.flat().filter(Boolean)); },
  go(path) { if (location.hash === `#${path}`) route(); else location.hash = path; },
  params() { return new URLSearchParams(location.hash.split('?')[1] || ''); },
  applyTheme() {
    const s = app.col.settings;
    const root = document.documentElement;
    if (s.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = s.theme;
    root.style.setProperty('--fs', s.fontScale);
    try { localStorage.setItem('ankipwa.ui', JSON.stringify({ theme: s.theme, fontScale: s.fontScale })); } catch {}
  },
  isDark() {
    const t = app.col.settings.theme;
    return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  },
};

async function route() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  if (app.cleanup) { try { await app.cleanup(); } catch (e) { console.error(e); } app.cleanup = null; }
  document.body.classList.remove('reviewing', 'selecting');
  app.setBack(null);
  app.setActions();
  for (const [re, view, nav] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    for (const a of document.querySelectorAll('.bottomnav a')) {
      if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    app.main.replaceChildren();
    try {
      app.cleanup = (await view.render(app, m.slice(1))) || null;
    } catch (e) {
      console.error(e);
      app.main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Something went wrong'), h('p', {}, String(e.message || e)), h('a', { class: 'btn', href: '#/' }, 'Back to decks')));
    }
    window.scrollTo(0, 0);
    return;
  }
  app.go('/');
}

async function boot() {
  try {
    app.col = await Collection.open();
  } catch (e) {
    document.getElementById('boot-msg').textContent = `Could not open the database: ${e.message || e}. Private browsing can block storage.`;
    return;
  }
  app.applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.applyTheme());
  if (navigator.storage?.persist) {
    try {
      app.storagePersisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch { app.storagePersisted = false; }
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); app.installPrompt = e; document.dispatchEvent(new Event('installable')); });
  window.addEventListener('appinstalled', () => { app.installPrompt = null; toast('Installed. You can open AnkiPWA from your home screen.'); });
  // Files opened with the installed app (desktop file handlers).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const handle = params.files?.[0];
      if (!handle) return;
      importView.setPendingFile(await handle.getFile());
      app.go('/import');
    });
  }
  await route();
  registerSW();
  // A new day can start while the app is open: refresh counts when we come back.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && (await app.col.rolloverIfNeeded())) route();
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready.', {
            action: 'Reload', ms: 15000,
            onAction: () => {
              navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
              nw.postMessage('skipWaiting');
            },
          });
        }
      });
    });
  }).catch((e) => console.warn('SW registration failed', e));
}

window.__app = app; // for debugging and automated checks
boot();
