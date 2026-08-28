#!/usr/bin/env node
// Captures the PWA manifest's screenshots from the REAL running app — the
// manifest claims /screenshot-wide.png (1280x720, shared screen) and
// /screenshot-narrow.png (750x1334, phone client), and Chrome rejects a
// manifest whose screenshot files 404. Serve the built PWA (wrangler dev
// after `npm run build:web`) and run:
//   node scripts/generate-pwa-screenshots.mjs [baseURL]
import { chromium } from "playwright";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8794";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const browser = await chromium.launch();

try {
  const wide = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await wide.goto(BASE + "/", { waitUntil: "networkidle" });
  await wide.screenshot({ path: path.join(REPO_ROOT, "public", "screenshot-wide.png") });
  console.log("Wrote public/screenshot-wide.png (1280x720, landing)");

  const narrow = await browser.newPage({
    viewport: { width: 750, height: 1334 },
    isMobile: true,
    hasTouch: true,
  });
  await narrow.goto(BASE + "/join", { waitUntil: "networkidle" });
  await narrow.screenshot({ path: path.join(REPO_ROOT, "public", "screenshot-narrow.png") });
  console.log("Wrote public/screenshot-narrow.png (750x1334, join)");
} finally {
  await browser.close();
}
