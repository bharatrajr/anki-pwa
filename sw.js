// Service worker: versioned cache. Network-first for the app shell (so updates arrive
// quickly), cache fallback when offline. Large vendor files are cache-first.
// Bump VERSION on every release; the old cache is deleted on activate.

const VERSION = 'v0.2.0';
const CACHE = `ankipwa-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './js/main.js',
  './js/db/idb.js',
  './js/db/schema.js',
  './js/db/collection.js',
  './js/model/notetypes.js',
  './js/model/cards.js',
  './js/render/html.js',
  './js/render/cloze.js',
  './js/render/template.js',
  './js/render/card.js',
  './js/sched/fsrs.js',
  './js/sched/scheduler.js',
  './js/sched/queue.js',
  './js/io/backup.js',
  './js/io/vendor.js',
  './js/io/protobuf.js',
  './js/io/anki-read.js',
  './js/io/anki-import.js',
  './js/io/anki-export.js',
  './js/io/text-import.js',
  './js/search/search.js',
  './js/sched/filtered.js',
  './js/stats/stats.js',
  './js/speech/speech.js',
  './js/util/hash.js',
  './js/util/time.js',
  './js/util/platform.js',
  './js/ui/components.js',
  './js/ui/decks.js',
  './js/ui/overview.js',
  './js/ui/review.js',
  './js/ui/editor.js',
  './js/ui/options.js',
  './js/ui/settings.js',
  './js/ui/backup.js',
  './js/ui/help.js',
  './js/ui/import.js',
  './js/ui/export.js',
  './js/ui/browse.js',
  './js/ui/stats.js',
];
const VENDOR = ['./vendor/sql-wasm.js', './vendor/sql-wasm.wasm', './vendor/jszip.min.js', './vendor/fzstd.mjs'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // Vendor files are needed only for Anki import/export; don't fail install if one is missing.
    await Promise.all(VENDOR.map((u) => cache.add(u).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('ankipwa-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(request, { signal: controller.signal, cache: 'no-cache' });
    clearTimeout(timer);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// Android share sheet (Web Share Target): keep the shared file, then open the import screen.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    let file = form.getAll('file').find((f) => f && typeof f !== 'string');
    if (!file) {
      const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
      if (text) file = new File([text], 'shared.txt', { type: 'text/plain' });
    }
    if (file) {
      const cache = await caches.open('ankipwa-share');
      await cache.put('shared-file', new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'shared') } }));
    }
  } catch (e) { console.warn('share failed', e); }
  return Response.redirect('./#/import?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) { event.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/')) event.respondWith(cacheFirst(req));
  else event.respondWith(networkFirst(req));
});
