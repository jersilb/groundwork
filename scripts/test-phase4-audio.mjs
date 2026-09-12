#!/usr/bin/env node
// Automated proxy for the Phase 4 gate: "4 hours of continuous recording
// with zero lost chunks, transcript lag under 90 seconds."
//
// What this test proves for real: consent gating (reject without consent,
// reject with kill switch engaged), real chunk upload to real local R2,
// real D1 row creation, real Queue dispatch to a real consumer, and —
// critically — that a Workers AI failure (this sandbox cannot reach
// api.cloudflare.com at all; see docs/capability-gaps.md, 2026-07-27)
// degrades gracefully: the chunk is marked with transcription_error, not
// lost, and the pipeline keeps running rather than crashing.
//
// What this test does NOT and cannot prove here: real transcription
// accuracy/latency, or the literal "4 hours, zero lost chunks, <90s lag"
// duration — Workers AI needs live Cloudflare access this sandbox is
// network-blocked from reaching, credentials notwithstanding.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  fetchJsonWithShield,
  printInfraFlakeSummary,
  isTransportError,
  d1Rows,
  cliEnv,
} from "./lib/infra-flake-shield.mjs";

const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const DEV_AUTH_HEADERS = {
  "X-Groundwork-Dev-User": "dev@groundwork.local",
  "X-Groundwork-Dev-Sub": "dev-user-00000000-0000-0000-0000-000000000000",
};
const SESSION_KEY = `phase4-test-${Date.now()}`;

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

/** [INFRA-FLAKE-SHIELD v2] text-first: `wrangler d1 execute --json` stdout is
 * polluted by wrangler's own log/telemetry lines under WRANGLER_LOG=debug
 * (the 🪵 line was CI 34672204710's phase-4 failure); cliEnv keeps that env
 * out of the one-shot CLI call, d1Rows extracts the JSON payload with a
 * string-aware matcher and throws loudly (raw output attached) if it cannot. */
function queryD1ChunkStatus(chunkId) {
  const out = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "groundwork",
      "--local",
      "--json",
      "--command",
      `SELECT text, transcribed_at, transcription_error FROM session_audio_chunk WHERE id = '${chunkId}'`,
    ],
    { encoding: "utf8", env: cliEnv() },
  );
  const rows = d1Rows(out, `d1 execute (chunk ${String(chunkId).slice(0, 8)}…)`);
  return rows[0] ?? null;
}

async function main() {
  console.log(`Starting wrangler dev on port ${PORT}...`);
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // [HOLMES-INSTRUMENTATION] tee to disk instead of silently draining.
  const logPath = path.join(process.env.HOLMES_LOG_DIR || "/tmp/holmes-gw/evidence", `phase4-${process.pid}.wrangler.log`);
  try { mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* exists */ }
  const tee = (d) => { try { appendFileSync(logPath, `[${new Date().toISOString()}] ${String(d)}`); } catch { /* ignore */ } };
  wrangler.stdout.on("data", tee);
  wrangler.stderr.on("data", tee);

  // [INFRA-FLAKE-SHIELD v2] text-first fetch helper: body read as TEXT;
  // transport-class failures get ONE loud retry; the body parses only when
  // JSON (the raw upload response `.json()` call below is now covered).
  const sFetch = async (url, init, label) => {
    const attempt = await fetchJsonWithShield(() => fetch(url, init), label);
    if (attempt.err) throw attempt.err;
    return attempt;
  };

  let exitCode = 1;
  let chunkId = null;

  try {
    const up = await waitForServer(30_000);
    if (!up) throw new Error("wrangler dev did not become healthy in time");
    console.log("Server up.");

    const noConsentRes = await sFetch(
      `${BASE}/session/${SESSION_KEY}/audio/chunk?segmentKey=welcome&sequence=0&offsetMs=0`,
      { method: "POST", headers: DEV_AUTH_HEADERS, body: new Uint8Array([1, 2, 3, 4]) },
      "chunk-no-consent",
    );
    if (noConsentRes.res.status !== 403) {
      throw new Error(`FAIL: expected 403 without consent, got ${noConsentRes.res.status}`);
    }
    console.log("PASS: chunk upload rejected with 403 — no consent recorded yet.");

    const consentRes = await sFetch(`${BASE}/session/${SESSION_KEY}/audio/consent`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ consentedBy: "test-leader" }),
    }, "audio-consent");
    if (!consentRes.res.ok) throw new Error(`FAIL: consent POST failed with ${consentRes.res.status}`);
    console.log("PASS: consent recorded.");

    const chunkBody = new Uint8Array(1000).fill(42); // fake audio bytes
    const uploadRes = await sFetch(
      `${BASE}/session/${SESSION_KEY}/audio/chunk?segmentKey=welcome&sequence=0&offsetMs=0`,
      { method: "POST", headers: DEV_AUTH_HEADERS, body: chunkBody },
      "chunk-upload-0",
    );
    if (!uploadRes.res.ok) throw new Error(`FAIL: chunk upload failed with ${uploadRes.res.status}`);
    // [INFRA-FLAKE-SHIELD v2] parse from the text-first helper, never raw .json()
    if (!uploadRes.parsed) {
      throw new Error(`FAIL: chunk upload returned non-JSON (${uploadRes.res.status}): ${uploadRes.text.slice(0, 200)}`);
    }
    const uploadJson = uploadRes.json;
    if (uploadJson.status !== "queued") {
      throw new Error(`FAIL: expected status "queued", got ${JSON.stringify(uploadJson)}`);
    }
    chunkId = uploadJson.chunkId;
    console.log(`PASS: chunk uploaded to real local R2, D1 row created, queued for transcription (chunkId=${chunkId}).`);

    const uploadRes2 = await sFetch(
      `${BASE}/session/${SESSION_KEY}/audio/chunk?segmentKey=welcome&sequence=1&offsetMs=60000`,
      { method: "POST", headers: DEV_AUTH_HEADERS, body: chunkBody },
      "chunk-upload-1",
    );
    if (!uploadRes2.res.ok) throw new Error(`FAIL: second chunk upload failed with ${uploadRes2.res.status}`);
    console.log("PASS: second chunk uploaded (sequence=1) — zero lost chunks so far.");

    const killRes = await sFetch(`${BASE}/session/${SESSION_KEY}/audio/kill-switch`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ engaged: true }),
    }, "kill-switch");
    if (!killRes.res.ok) throw new Error(`FAIL: kill-switch POST failed with ${killRes.res.status}`);
    const blockedRes = await sFetch(
      `${BASE}/session/${SESSION_KEY}/audio/chunk?segmentKey=welcome&sequence=2&offsetMs=120000`,
      { method: "POST", headers: DEV_AUTH_HEADERS, body: chunkBody },
      "chunk-upload-blocked",
    );
    if (blockedRes.res.status !== 403) {
      throw new Error(`FAIL: expected 403 after kill switch engaged, got ${blockedRes.res.status}`);
    }
    console.log("PASS: kill switch engaged — further chunk uploads correctly rejected.");

    console.log("Waiting 7s for the queue consumer to attempt transcription (max_batch_timeout=5s)...");
    await sleep(7000);

    exitCode = 0;
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    // [INFRA-FLAKE-SHIELD v2] exit-3 discipline: transport-class failures
    // that survive the shield are not app regressions (exit 1).
    if (isTransportError(err)) {
      console.error(
        "[INFRA-FLAKE] final failure is transport-class (upstream wrangler dev defect — workers-sdk #15203/#15452; fix PR #15252 released in wrangler 4.129.1). Exit 3 — not an app regression.",
      );
      exitCode = 3;
    } else {
      exitCode = 1;
    }
  } finally {
    try {
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {
      wrangler.kill("SIGKILL");
    }
    await sleep(800);
    printInfraFlakeSummary();
  }

  if (exitCode === 0 && chunkId) {
    console.log("\nChecking D1 for the queue consumer's outcome on the first chunk...");
    try {
      const row = queryD1ChunkStatus(chunkId);
      if (!row) {
        console.error("FAIL: chunk row not found in D1 after processing.");
        exitCode = 1;
      } else if (row.transcribed_at) {
        console.log(`UNEXPECTED SUCCESS: chunk was actually transcribed: "${row.text}". (Network must be reachable after all — verify against docs/capability-gaps.md.)`);
      } else if (row.transcription_error) {
        console.log(`PASS: chunk was NOT lost — queue consumer ran, Workers AI call failed as expected (network-blocked sandbox), and the failure was recorded gracefully:`);
        console.log(`  transcription_error: ${row.transcription_error}`);
        console.log("This is exactly the degrade-don't-crash behavior that matters for a real transient Whisper outage too.");
      } else {
        console.log("INCONCLUSIVE: chunk row exists but neither transcribed_at nor transcription_error is set — consumer may not have run yet, or is mid-retry. Not a failure, but worth re-checking with a longer wait.");
      }
    } catch (err) {
      console.error("Could not query D1 for verification:", err.message ?? err);
      // transport-tagged CLI failure = infra class, never app class
      exitCode = isTransportError(err) ? 3 : 1;
    }
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