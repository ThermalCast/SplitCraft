// SplitCraft service worker — offline support for the installed app.
//
// WHY THIS IS A SEPARATE FILE: it has to be. A service worker is registered by
// URL and its scope is derived from its own path, so it cannot be inlined into
// the HTML the way everything else in this project is. It also only runs over
// https:// or localhost — opening the HTML as a file:// URL registers nothing,
// which is fine: registration is wrapped in a feature check on the page, and
// the app works exactly as before without it.
//
// STRATEGY: cache-first for the app shell, because the shell is a handful of
// static files that only change when a new version is deployed, and the whole
// point is that a gym basement with no signal still opens the app. Freshness is
// handled by the version below rather than by hitting the network on every
// load.
//
// Nothing here touches workout data. All of that lives in IndexedDB, which the
// service worker neither sees nor caches — clearing this cache costs you a
// download, never a training log.
const VERSION = 'splitcraft-v1';

// Bump VERSION on deploy. The install step precaches this list; the activate
// step deletes every cache that isn't the current VERSION, so an old shell
// cannot survive an update.
const SHELL = [
  './',
  './splitcraft.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Added individually rather than via addAll: addAll is atomic, so one 404
    // — a renamed HTML file, a missing icon — throws away the entire precache
    // and leaves the app with no offline support at all, silently. Better to
    // cache what exists and still work.
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { /* not fatal — see above */ }
    }));
    // Take over as soon as the new worker is ready rather than waiting for
    // every tab to close. This happens unconditionally, not on the page's
    // say-so — the page just shows a toast ("Update ready — reopen the app
    // to apply it") so the user knows why a reopen picks up something new.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Same-origin only. The OpenRouter call must always go to the network and
  // must never be cached — it is a POST anyway, but this makes the intent
  // explicit rather than relying on the method check above.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) {
      // Refresh in the background so the NEXT launch is current, without
      // making this one wait on the network.
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) (await caches.open(VERSION)).put(req, fresh.clone());
        } catch (e) { /* offline — the cached copy is doing its job */ }
      })());
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && url.pathname.indexOf('/api/') === -1) {
        (await caches.open(VERSION)).put(req, fresh.clone());
      }
      return fresh;
    } catch (e) {
      // Offline and not in the cache. For a navigation that means a cold
      // launch of a page we never stored — fall back to the app shell, which
      // is the only thing that could usefully render.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./splitcraft.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
