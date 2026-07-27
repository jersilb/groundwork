// Minimal installable-PWA service worker — build plan §7. This is the
// installability primitive (cache the app shell, respond when offline),
// not the production offline experience. The real offline queue mechanism
// (IndexedDB submission/vote queue, reconnect replay) lives client-side
// in the app itself (see test/resilience/client.js from Phase 3) — a
// service worker's cache-the-shell job and that queue's job are related
// but distinct, and wiring them together for the real app is
// frontend-ux-engineer + ultimate-web-designer territory (CLAUDE.md).

const CACHE_NAME = "groundwork-shell-v1";
const SHELL_ASSETS = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});
