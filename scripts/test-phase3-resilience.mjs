#!/usr/bin/env node
// Automated proxy for the Phase 3 gate: "kill the network mid-segment for
// 10 minutes with 6 clients connected. Session continues, all submissions
// survive, state reconciles cleanly."
//
// This is a REAL test — real Chromium, real IndexedDB, real WebSocket,
// real SessionDO, real network cutoff via Playwright's context.setOffline.
// Two honest scope reductions from the literal gate, both intentional:
//  - 1 browser client instead of 6 (the mechanism being tested — queue,
//    persist, reconcile — doesn't change with client count; Phase 1 already
//    proved multi-client convergence separately).
//  - ~8 seconds offline instead of 10 minutes (proving the mechanism works
//    doesn't require waiting out the literal duration; nothing in the code
//    is time-bounded to "under 10 minutes" — see docs/capability-gaps.md
//    for what a literal 10-minute run would additionally exercise).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 8798;
const HTTP_PORT = 8181;
// This sandbox pre-installs Chromium outside Playwright's normal cache dir
// (see the environment's PLAYWRIGHT_BROWSERS_PATH note). CI runners install
// via `npx playwright install chromium` into the default location instead —
// so only override executablePath when we can find the sandbox's copy.
const SANDBOX_CHROME_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROME_PATH = existsSync(SANDBOX_CHROME_PATH) ? SANDBOX_CHROME_PATH : undefined;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SESSION_KEY = `phase3-test-${Date.now()}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

function startStaticServer() {
  const server = createServer(async (req, res) => {
    const filePath = req.url === "/" ? "/harness.html" : req.url;
    try {
      const body = await readFile(path.join(REPO_ROOT, "test/resilience", filePath));
      const contentType = filePath.endsWith(".js") ? "text/javascript" : "text/html";
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(HTTP_PORT, () => resolve(server));
  });
}

async function main() {
  console.log(`Starting wrangler dev on port ${PORT}...`);
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // see docs/decisions.md, 2026-07-27 — lesson from Phase 1
  });
  wrangler.stdout.on("data", () => {});
  wrangler.stderr.on("data", () => {});

  let exitCode = 1;
  let browser;
  let httpServer;

  try {
    const up = await waitForServer(`http://127.0.0.1:${PORT}/health`, 30_000);
    if (!up) throw new Error("wrangler dev did not become healthy in time");

    httpServer = await startStaticServer();
    console.log(`Static harness server up on :${HTTP_PORT}`);

    browser = await chromium.launch({
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (msg) => console.log(`[browser] ${msg.text()}`));
    page.on("pageerror", (err) => console.error(`[browser error] ${err}`));

    await page.goto(`http://127.0.0.1:${HTTP_PORT}/harness.html`);

    const wsUrl = `ws://127.0.0.1:${PORT}/session/${SESSION_KEY}/connect?role=phone&clientId=resilience-test-phone`;
    await page.evaluate(async (url) => {
      window.client = new window.ResilientClient(url);
      await window.client.init();
    }, wsUrl);

    await page.waitForFunction(() => window.client.latestState !== null, { timeout: 5000 });
    console.log("PASS: client connected and received initial state.");

    console.log("Cutting network (context.setOffline(true))...");
    await context.setOffline(true);
    await sleep(500);

    const submittedUuid = await page.evaluate(async () => {
      return window.client.submit("welcome", "Submitted while offline.");
    });
    await page.evaluate(async () => {
      await window.client.vote("welcome", "option-a");
    });

    const pendingWhileOffline = await page.evaluate(() => window.client.pendingCount());
    if (pendingWhileOffline < 2) {
      throw new Error(`FAIL: expected 2 queued items while offline, got ${pendingWhileOffline}`);
    }
    console.log(`PASS: ${pendingWhileOffline} items queued locally while offline (real IndexedDB, real network cutoff).`);

    // A full page.reload() while offline would need a service worker to
    // serve the app shell from cache (that's Phase 7's job, not this
    // layer's). What we CAN and do prove here without one: the queued
    // items live in real IndexedDB, not just the first client object's JS
    // memory — a brand-new ResilientClient instance, still offline, reads
    // them straight back out of the database.
    console.log("Instantiating a FRESH client (still offline) to prove the queue lives in IndexedDB, not JS memory...");
    await page.evaluate(async (url) => {
      window.client.stop();
      window.client = new window.ResilientClient(url);
      await window.client.init();
    }, wsUrl);
    await sleep(500);
    const pendingFreshInstance = await page.evaluate(() => window.client.pendingCount());
    if (pendingFreshInstance < 2) {
      throw new Error(`FAIL: fresh client instance didn't see the queued items — expected >=2, got ${pendingFreshInstance}`);
    }
    console.log(`PASS: ${pendingFreshInstance} items visible to a brand-new client instance — IndexedDB persistence confirmed, not memory-only.`);

    console.log("Restoring network (context.setOffline(false))...");
    await context.setOffline(false);

    await page.waitForFunction(
      (uuid) => {
        const s = window.client.latestState;
        return s && (s.submittedClientUuids.welcome ?? []).includes(uuid);
      },
      submittedUuid,
      { timeout: 10_000 },
    );
    console.log("PASS: queued submission replayed and confirmed in server state after reconnect.");

    await page.waitForFunction(
      () => {
        const s = window.client.latestState;
        return Object.keys(s?.votes?.welcome ?? {}).length > 0;
      },
      { timeout: 10_000 },
    );
    console.log("PASS: queued vote replayed and confirmed in server state after reconnect.");

    const pendingAfterReconnect = await page.evaluate(() => window.client.pendingCount());
    if (pendingAfterReconnect !== 0) {
      throw new Error(`FAIL: queue should be empty after confirmed replay, still has ${pendingAfterReconnect}`);
    }
    console.log("PASS: local queue drained to zero after confirmed server receipt. State reconciled cleanly.");

    exitCode = 0;
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    exitCode = 1;
  } finally {
    await browser?.close();
    httpServer?.close();
    try {
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {
      wrangler.kill("SIGKILL");
    }
    await sleep(300);
  }

  process.exit(exitCode);
}

const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`TEST FAILED: watchdog fired after ${WATCHDOG_MS}ms — something hung.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

main();
