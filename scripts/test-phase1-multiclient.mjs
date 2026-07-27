#!/usr/bin/env node
// Automated proxy for the Phase 1 gate: "three real devices in one room
// advance through segments together with no state divergence."
//
// This is a real functional test (three concurrent WebSocket clients
// against a live wrangler dev instance, real DO storage, real D1
// checkpoint), NOT a mock. It is not a substitute for the literal
// physical-device room test — that requires real hardware and is logged
// as an open item in docs/capability-gaps.md. What it does verify: the
// DO's broadcast/state-version mechanism produces zero divergence across
// concurrent clients under real network I/O.
import { spawn } from "node:child_process";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const SESSION_KEY = `phase1-test-${Date.now()}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

function connectClient(role, clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/session/${SESSION_KEY}/connect?role=${role}&clientId=${clientId}`);
    const states = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") states.push(msg.state);
      if (msg.type === "error") console.error(`[${clientId}] server error: ${msg.message}`);
    });
    ws.addEventListener("open", () => resolve({ ws, clientId, role, states }));
    ws.addEventListener("error", (err) => reject(err));
  });
}

function send(client, message) {
  client.ws.send(JSON.stringify(message));
}

function latestState(client) {
  return client.states[client.states.length - 1];
}

async function waitForCondition(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  console.log(`Starting wrangler dev on port ${PORT}...`);
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so we can kill wrangler's workerd
                     // child too — SIGTERM to just the wrapper orphans it
                     // and leaves the port held (bit us once already).
  });
  // Drain stdout/stderr continuously — an unread pipe fills its OS buffer
  // and blocks the child process's write() call, hanging wrangler dev
  // entirely. This bit us once already; do not remove.
  wrangler.stdout.on("data", () => {});
  wrangler.stderr.on("data", () => {});
  let exitCode = 1;

  try {
    const up = await waitForServer(30_000);
    if (!up) throw new Error("wrangler dev did not become healthy in time");
    console.log("Server up. Connecting 3 clients (1 screen, 2 phones)...");

    const screen = await connectClient("screen", "device-screen");
    const phoneA = await connectClient("phone", "device-phone-a");
    const phoneB = await connectClient("phone", "device-phone-b");
    const clients = [screen, phoneA, phoneB];

    await waitForCondition(() => clients.every((c) => c.states.length >= 1), 5000, "initial state on all clients");
    console.log("All 3 clients received initial state.");

    // Both phones submit into segment "welcome" — dedup should still allow
    // both since they're different clientUuids.
    send(phoneA, { type: "submit", segmentKey: "welcome", clientUuid: "uuid-a-1", content: "Attendance is down." });
    send(phoneB, { type: "submit", segmentKey: "welcome", clientUuid: "uuid-b-1", content: "Budget is tight." });
    // Duplicate submit from phoneA with the SAME uuid — must be deduped.
    send(phoneA, { type: "submit", segmentKey: "welcome", clientUuid: "uuid-a-1", content: "duplicate, ignore me" });

    await waitForCondition(
      () => clients.every((c) => latestState(c)?.submissionCounts.welcome === 2),
      5000,
      "all clients converge on submissionCounts.welcome === 2 (dedup working)",
    );
    console.log("PASS: dedup — 2 distinct submissions counted on all 3 clients, duplicate ignored.");

    // Only the screen may advance segments. Phone attempts should be rejected.
    send(phoneA, { type: "advance_segment" });
    await sleep(300);
    if (latestState(screen).currentSegmentIndex !== 0) {
      throw new Error("FAIL: a phone client was able to advance the segment");
    }
    console.log("PASS: phone-initiated advance_segment was rejected.");

    send(screen, { type: "advance_segment" });
    send(screen, { type: "advance_segment" });

    await waitForCondition(
      () => clients.every((c) => latestState(c)?.currentSegmentIndex === 2),
      5000,
      "all clients converge on currentSegmentIndex === 2",
    );

    const versions = clients.map((c) => latestState(c).stateVersion);
    const allSame = versions.every((v) => v === versions[0]);
    if (!allSame) {
      throw new Error(`FAIL: stateVersion diverged across clients: ${JSON.stringify(versions)}`);
    }
    console.log(`PASS: all 3 clients converged — currentSegmentIndex=2, stateVersion=${versions[0]} on every client. No divergence.`);

    for (const c of clients) c.ws.close();
    exitCode = 0;
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    exitCode = 1;
  } finally {
    try {
      process.kill(-wrangler.pid, "SIGKILL"); // whole process group, incl. workerd
    } catch {
      wrangler.kill("SIGKILL");
    }
    await sleep(500);
  }

  process.exit(exitCode);
}

const WATCHDOG_MS = 45_000;
const watchdog = setTimeout(() => {
  console.error(`TEST FAILED: watchdog fired after ${WATCHDOG_MS}ms — something hung.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main();
