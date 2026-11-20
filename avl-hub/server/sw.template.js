/* AVL Hub service worker. Generated at server start-up: the version and file list below are filled in from the real files in public/,
   so every release gets a fresh cache and nothing stale is served. App DATA is cached by the app itself (IndexedDB), never here. */
const VERSION = '__VERSION__';
const SHELL = __ASSETS__;
const SHELL_CACHE = 'avl-shell-' + VERSION;
const FILES_CACHE = 'avl-files-v1';          // private photos viewed on this device (cleared at sign-out)

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('avl-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => {
  if (e.data === 'clear-private') e.waitUntil(caches.delete(FILES_CACHE));
  if (e.data === 'skip-waiting') self.skipWaiting();
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/files/')) return e.respondWith(photoFirst(req));
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/vendor/') || url.pathname === '/sw.js') return;   // data & big optional assets: network only
  if (req.mode === 'navigate') return e.respondWith(caches.match('/index.html').then(r => r || fetch(req)));            // app shell for every page: works offline
  e.respondWith(caches.match(req, { ignoreSearch: false }).then(r => r || fetch(req)));
});
// Photos only (never video/PDF): network first so edits show, fall back to the copy already viewed on this device.
async function photoFirst(req) {
  if (req.headers.has('range')) return fetch(req);
  const cache = await caches.open(FILES_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) cache.put(req, res.clone());
    return res;
  } catch { const hit = await cache.match(req); if (hit) return hit; throw new Error('offline'); }
}
