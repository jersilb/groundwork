#!/usr/bin/env node
// End-to-end smoke test against a live `wrangler dev` instance (the real
// Worker: assets, API routes, WebSocket sessions). Loads each client route
// in real Chromium and asserts the app shell renders with no console errors.
// Requires dist/ (run `npm run build:web` first) and local D1 migrations.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 8795;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SANDBOX_CHROME_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROME_PATH = existsSync(SANDBOX_CHROME_PATH) ? SANDBOX_CHROME_PATH : undefined;

if (!existsSync(path.join(REPO_ROOT, "dist"))) {
  console.error("dist/ not found - run `npm run build:web` first");
  process.exit(1);
}

async function startWrangler() {
  const child = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT)], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain pipes (the known-good pattern from test-phase1) so wrangler never
  // blocks on a full stdout buffer.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  // Wait for readiness
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not become ready in time");
}

async function main() {
  // Any failed route / console error / failed request sets this to 1 —
  // it starts at 0 because "no failures observed" IS the pass condition.
  let exitCode = 0;
  let browser;
  let wrangler;
  try {
    wrangler = await startWrangler();
    console.log(`wrangler dev up on :${PORT}`);
    browser = await chromium.launch({ ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}), args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    page.on("requestfailed", (req) => failedRequests.push(req.url() + " -> " + (req.failure()?.errorText ?? "?")));

    const routes = [
      { path: "/", expect: "How it works" },
      { path: "/join", expect: "Join a session" },
      // The fake lab's first segment is "Welcome" — a connected room shows it.
      { path: "/session/demo/phone", expect: "Welcome" },
      { path: "/session/demo", expect: "Welcome" },
      { path: "/org/demo", expect: "your program" },
      { path: "/org/demo/billing", expect: "Your plan" },
      { path: "/install", expect: "Install Groundwork on your phone" },
    ];

    for (const route of routes) {
      await page.goto(`http://localhost:${PORT}${route.path}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(700);
      const body = await page.evaluate(() => document.body.innerText);
      const ok = body.includes(route.expect);
      console.log(`${ok ? "PASS" : "FAIL"}: ${route.path} (expects "${route.expect}")`);
      if (!ok) exitCode = 1;
    }

    if (consoleErrors.length > 0) {
      console.error("CONSOLE ERRORS:");
      for (const e of consoleErrors.slice(0, 8)) console.error("  " + e.slice(0, 300));
      exitCode = 1;
    } else {
      console.log("PASS: zero console errors across all routes.");
    }
    if (failedRequests.length > 0) {
      console.error("FAILED REQUESTS:");
      for (const f of failedRequests.slice(0, 8)) console.error("  " + f.slice(0, 300));
      exitCode = 1;
    }
  } catch (err) {
    console.error("SMOKE TEST FAILED:", err.message ?? err);
    exitCode = 1;
  } finally {
    await browser?.close();
    if (wrangler?.pid) {
      try { process.kill(-wrangler.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  process.exit(exitCode);
}

main();
