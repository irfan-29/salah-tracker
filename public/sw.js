/*
  Hasanath service worker.

  Its job is to make the app installable (Chrome and PWABuilder require a
  service worker with a fetch handler) and to keep the shell usable on a flaky
  connection. It deliberately does NOT cache anything personal:

  - /api/* is never touched. Salah logs, sessions and posts always come from the
    network, so a reader never sees someone else's (or a stale) record.
  - Pages are network-first. A fresh deploy is picked up on the next load; the
    cached shell is only a fallback when the network is unreachable.
  - Vite's hashed /assets/* files never change, so they are cache-first.
  - Fonts, images and icons are stale-while-revalidate.

  Bump VERSION whenever this file's caching rules change; old caches are
  removed on activate.
*/
const VERSION = 'v1';
const SHELL_CACHE = `hasanath-shell-${VERSION}`;
const ASSET_CACHE = `hasanath-assets-${VERSION}`;
const SHELL_URL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll([SHELL_URL, '/manifest.webmanifest', '/icons/icon-192.png']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('hasanath-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Audio seeking sends Range requests; the cache cannot answer those correctly.
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/.well-known/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (/^\/(fonts|images|icons|css)\//.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirstPage(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Every route serves the same index.html, so one cached copy covers all.
      const cache = await caches.open(SHELL_CACHE);
      cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Hasanath</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155;text-align:center">' +
      '<div><h1 style="color:#0d9488;font-size:1.25rem">You are offline</h1>' +
      '<p>Connect to the internet and reopen Hasanath.</p></div></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
