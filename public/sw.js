// Minimal service worker - just enough to satisfy PWA installability.
// This app requires a connection, so we don't cache anything; we simply
// pass all requests straight through to the network.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
