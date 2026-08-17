#!/usr/bin/env node
// Real PWA installability test for Phase 7. Uses Chrome DevTools
// Protocol's own Page.getInstallabilityErrors — the actual mechanism
// Chrome/Android uses to decide whether to offer install — rather than
// guessing at the criteria ourselves. If this comes back empty, real
// Chrome would offer to install this PWA.
//
// What this proves: the manifest, icons, and service worker satisfy
// Chrome's real installability bar. What it does NOT prove: the literal
// "install to home screen on iOS and Android" gate — no real phones
// exist in this sandbox, and iOS Safari's installability criteria differ
// from Chrome's CDP check (no beforeinstallprompt on iOS at all — Add to
// Home Screen is manual there regardless of manifest quality). Logged as
// a capability gap, same category as Phase 1's physical-device test.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const HTTP_PORT = 8182;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SANDBOX_CHROME_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROME_PATH = existsSync(SANDBOX_CHROME_PATH) ? SANDBOX_CHROME_PATH : undefined;

// The PWA now serves the built frontend (dist/), not the old installability
// shell. CI runs `npm run build:web` before this job; locally, build first.
const STATIC_DIR = path.join(REPO_ROOT, "dist");
if (!existsSync(STATIC_DIR)) {
  console.error("dist/ not found - run `npm run build:web` before the PWA test");
  process.exit(1);
}

const CONTENT_TYPES = { ".html": "text/html", ".json": "application/manifest+json", ".js": "text/javascript", ".png": "image/png" };

function startStaticServer() {
  const server = createServer(async (req, res) => {
    const filePath = req.url === "/" ? "/index.html" : req.url;
    try {
      const body = await readFile(path.join(STATIC_DIR, filePath));
      const ext = path.extname(filePath);
      res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, () => resolve(server)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let exitCode = 1;
  let browser;
  let httpServer;

  try {
    httpServer = await startStaticServer();
    console.log(`Static PWA server up on :${HTTP_PORT}`);

    browser = await chromium.launch({
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error(`[browser error] ${err}`));

    await page.goto(`http://localhost:${HTTP_PORT}/`);

    console.log("Checking manifest is linked and fetchable...");
    const manifestHref = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute("href"));
    if (manifestHref !== "/manifest.json") throw new Error(`FAIL: expected manifest link href "/manifest.json", got "${manifestHref}"`);
    const manifestRes = await page.request.get(`http://localhost:${HTTP_PORT}/manifest.json`);
    const manifest = await manifestRes.json();
    for (const field of ["name", "short_name", "start_url", "display", "icons"]) {
      if (!(field in manifest)) throw new Error(`FAIL: manifest missing required field "${field}"`);
    }
    const has192 = manifest.icons.some((i) => i.sizes === "192x192");
    const has512 = manifest.icons.some((i) => i.sizes === "512x512");
    if (!has192 || !has512) throw new Error("FAIL: manifest must declare 192x192 and 512x512 icons");
    console.log("PASS: manifest linked, fetchable, and has all required fields + icon sizes.");

    console.log("Waiting for the service worker to actually register and activate...");
    await page.waitForFunction(
      async () => {
        if (!("serviceWorker" in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return Boolean(reg.active);
      },
      { timeout: 10_000 },
    );
    console.log("PASS: service worker registered and reached the 'active' state for real.");

    console.log("Verifying icon files actually load (not 404s the manifest just claims exist)...");
    for (const icon of manifest.icons) {
      const res = await page.request.get(`http://localhost:${HTTP_PORT}${icon.src}`);
      if (!res.ok()) throw new Error(`FAIL: icon ${icon.src} returned ${res.status()}`);
      const buf = await res.body();
      if (buf.length < 100) throw new Error(`FAIL: icon ${icon.src} is suspiciously small (${buf.length} bytes) — likely a placeholder stub, not a real image`);
    }
    console.log("PASS: both icon files load for real with substantive content.");

    console.log("Asking Chrome's own DevTools Protocol whether this PWA is installable (the real criteria Chrome/Android use)...");
    const cdpSession = await context.newCDPSession(page);
    const { installabilityErrors } = await cdpSession.send("Page.getInstallabilityErrors");
    // "in-incognito" is expected and unavoidable here: Playwright's
    // browser.newContext() creates an ephemeral profile Chrome treats as
    // incognito-like, and Chrome intentionally disables installability in
    // incognito regardless of manifest/SW/icon quality — a real user's
    // normal profile wouldn't hit this. Every OTHER error is a genuine
    // finding about the PWA itself, not an artifact of automation.
    const realErrors = installabilityErrors.filter((e) => e.errorId !== "in-incognito");
    if (realErrors.length > 0) {
      console.error("FAIL: Chrome reports real installability errors (beyond the expected incognito artifact):");
      for (const e of realErrors) console.error(`  ${e.errorId}: ${JSON.stringify(e.errorArguments)}`);
      exitCode = 1;
    } else {
      const ignoredNote = installabilityErrors.length > 0 ? ` (ignored expected automation artifact: ${installabilityErrors.map((e) => e.errorId).join(", ")})` : "";
      console.log(`PASS: Chrome's own installability check found zero REAL errors${ignoredNote} — this PWA satisfies Chrome/Android's actual install criteria.`);
      exitCode = 0;
    }
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    exitCode = 1;
  } finally {
    await browser?.close();
    httpServer?.close();
    await sleep(200);
  }

  process.exit(exitCode);
}

main();
