// Service worker registration (PWA offline shell).
//
// Registers /sw.js (copied from public/ into dist/ by Vite) after the first
// load so it never competes with the initial render. Skipped in dev: Vite's
// dev server serves unhashed modules and HMR would fight a caching worker;
// the production build (dist/) is where the offline experience matters.

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failure must never break the app; offline is a
      // progressive enhancement here.
    });
  });
}
