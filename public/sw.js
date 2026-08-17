// Groundwork PWA service worker — production offline experience.
//
// Strategy (documented, no build-time plugin needed):
//
//  1. PRECACHE the app shell at install: /, /index.html, /manifest.json,
//     /icon-192.png, /icon-512.png. Each shell asset is fetched individually
//     with a try/catch so one transient failure can never sink the install.
//  2. RUNTIME cache for built JS/CSS/fonts/images: hashed assets are
//     immutable, so stale-while-revalidate gives an instant cached response
//     on repeat visits and a background refresh keeps the copy warm. Every
//     visited screen therefore works offline after the first load.
//  3. NETWORK-FIRST for same-origin API GETs (/org, /program, ...) with a
//     cache fallback, so org/program data still renders (stale) when the
//     network is gone.
//  4. NAVIGATION requests go network-first and fall back to the cached
//     /index.html when offline — SPA routing keeps working on any deep link.
//  5. Lifecycle: skipWaiting() on install + clients.claim() on activate so a
//     fresh deploy takes over immediately, and activate deletes every cache
//     not belonging to this version (which also clears the old shell-v1
//     cache from the minimal Phase-7 primitive).
//
// Why a cache-manifest.json? A pure runtime cache cannot make the app work
// offline after the FIRST load: on a first visit the SW registers only after
// the page's own JS/CSS/fonts have already been fetched, so it never sees
// them. The postbuild script scripts/generate-cache-manifest.mjs (wired as
// "postbuild:web") therefore writes dist/cache-manifest.json listing every
// hashed asset, and install() below precaches that list alongside the fixed
// shell. The runtime caches then cover anything the manifest missed.

const VERSION = "groundwork-pwa-v2";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const API_CACHE = `${VERSION}-api`;

const SHELL_ASSETS = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

// Same-origin API endpoints (see web/src/lib/api.ts). WebSocket upgrade
// requests are never routed through fetch, so /session/:key/connect is not
// affected by the API cache.
const API_PREFIXES = ["/org", "/program", "/lab-session", "/initiative", "/review-cycle", "/health"];

const STATIC_ASSET_RE = /\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i;

function isApiPath(url) {
  return API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + "/"));
}

function isStaticAsset(url) {
  return STATIC_ASSET_RE.test(url.pathname);
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    SHELL_ASSETS.map(async (url) => {
      try {
        // cache: "reload" bypasses the HTTP cache so a deploy's new shell
        // is what actually lands in the SW cache.
        const res = await fetch(url, { cache: "reload" });
        if (res.ok) await cache.put(url, res.clone());
      } catch {
        // Skip a single failing asset (e.g. a transient 5xx); the rest of
        // the shell still installs and the runtime caches fill in the gap
        // on first use.
      }
    }),
  );
}

async function precacheManifestedAssets() {
  // Precache every hashed asset listed in the postbuild cache-manifest.json
  // into the asset cache, so a fresh install is fully offline-capable. Each
  // entry is fetched individually with try/catch — one bad URL must not sink
  // the whole install. A missing manifest (e.g. stale dist) is not an error.
  try {
    const manifestRes = await fetch("/cache-manifest.json", { cache: "reload" });
    if (!manifestRes.ok) return;
    const manifest = await manifestRes.json();
    if (!Array.isArray(manifest.assets)) return;
    const cache = await caches.open(ASSET_CACHE);
    await Promise.all(
      manifest.assets.map(async (url) => {
        try {
          const res = await fetch(url, { cache: "reload" });
          if (res.ok) await cache.put(url, res.clone());
        } catch {
          // Skip this asset; the runtime SWR cache will fill it on first use.
        }
      }),
    );
  } catch {
    // Offline at install or unparseable manifest: still install the shell.
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Background refresh: don't block the response on the network.
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("offline and uncached");
  }
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      // Refresh the precached copy of the shell entry points so the next
      // offline launch picks up the newest app.
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        await cache.put(request, res.clone());
      }
    }
    return res;
  } catch {
    // Offline: SPA fallback — any deep link (/org/..., /session/...) renders
    // the cached app shell, and client-side routing takes over.
    return (await cache.match("/index.html")) || (await cache.match("/"));
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([precacheShell(), precacheManifestedAssets()])
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigations: network-first, cached /index.html when offline.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Same-origin API GETs: network-first with stale cache fallback.
  if (isApiPath(url)) {
    event.respondWith(networkFirst(request, API_CACHE).catch(() => Response.error()));
    return;
  }

  // Built JS/CSS/fonts/images (+ manifest/icons): stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }

  // Anything else same-origin: cache-first, network on miss.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});