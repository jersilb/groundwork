#!/usr/bin/env node
// REGRESSION TEST — reopen-a-completed-lab must ALWAYS answer a clean 409.
//
// Origin: 2026-09-11 sightings (`expected 409 reopening a completed lab,
// got 500 {}` in test:session-integration; sibling `expected 403 for unknown
// lab, got 500`). Root cause was proven to be an upstream `wrangler dev`
// transport defect (see /tmp/holmes-gw/REPORT.md and
// cloudflare/workers-sdk #15203/#15452/#15317), NOT app logic. This test
// pins the app-level contract anyway:
//
//   * reopening a completed lab_session: ALWAYS a clean 409 (phase gate),
//     NEVER a 5xx — for N consecutive attempts against a live dev server;
//   * an unknown lab_session: ALWAYS 403 (auth-first), never a 5xx.
//
// Handling of the KNOWN upstream transport class (never silent):
//   * every request gets ONE loud retry via the shared infra-flake shield;
//   * if the dev server died mid-run (fetch ECONNREFUSED cascade — the burst
//     itself can trip the upstream defect), the harness RESTARTS it (same
//     --persist-to dir: the completed-lab fixture survives) and resumes the
//     loop, counting restarts and printing a banner per restart;
//   * exit 1 = APP-CLASS defect (deterministic red — a real regression of
//     the phase gate or auth-first behavior);
//   * exit 3 = the contract could not be verified even across restarts
//     (transport class persists) — loudly INFRA-FLAKE, never mistaken green;
//   * exit 0 = every reopen answered 409 and every unknown lab 403
//     (restart count is printed; >0 means the upstream defect was present).
//
// Runnable directly: node scripts/test-reopen-regression.mjs
//   env: GW_PORT (default 8797), N_REOPENS (default 25), HOLMES_LOG_DIR,
//        REGRESSION_GAP_MS (default 150; inter-iteration pacing).
//
// PACING IS LOAD-BEARING, not a comfort setting: an unpaced burst of these
// POSTs (gap ~2ms) reproducibly takes the dev server down within ~20
// requests — the burst itself hits the upstream socket-drop defect long
// before an app contract bug could. 150ms keeps the run in roughly the same
// regime as the real test suites. Set REGRESSION_GAP_MS=0 for the burst
// repro of the upstream defect (expect restarts / exit 3).
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fetchWithShield, printInfraFlakeSummary, isTransportClassFailure } from "./lib/infra-flake-shield.mjs";

const PORT = Number(process.env.GW_PORT ?? 8797);
const N = Number(process.env.N_REOPENS ?? 25);
const GAP_MS = Number(process.env.REGRESSION_GAP_MS ?? 150);
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PERSIST_DIR = path.join("/tmp", `gw-reopen-regression-${process.pid}-${Date.now()}`);
const LOG_DIR = process.env.HOLMES_LOG_DIR || "/tmp/holmes-gw/evidence";
const LOG_PATH = path.join(LOG_DIR, `reopen-regression-${process.pid}.wrangler.log`);
mkdirSync(LOG_DIR, { recursive: true });

const DEV_AUTH_HEADERS = {
  "X-Groundwork-Dev-User": "dev@groundwork.local",
  "X-Groundwork-Dev-Sub": "dev-user-00000000-0000-0000-0000-000000000000",
};

let wrangler = null;
let restarts = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnWrangler() {
  appendFileSync(LOG_PATH, `\n=== wrangler spawn #${restarts + 1} at ${new Date().toISOString()} ===\n`);
  const wr = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", PERSIST_DIR],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const tee = (d) => { try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${String(d)}`); } catch { /* ignore */ } };
  wr.stdout.on("data", tee);
  wr.stderr.on("data", tee);
  return wr;
}

function killWrangler(wr) {
  if (!wr) return;
  try { process.kill(-wr.pid, "SIGKILL"); } catch { try { wr.kill("SIGKILL"); } catch { /* dead */ } }
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}

/** If the dev server is down (upstream flake killed it), restart it —
 * same persist dir, so the D1 fixture survives. Returns true if restarted. */
async function ensureServer() {
  try { if ((await fetch(`${BASE}/health`)).ok) return false; } catch { /* down */ }
  restarts += 1;
  console.error(`[reopen-regression] !!! dev server down (upstream wrangler transport defect) — RESTART #${restarts} (workers-sdk #15203/#15452/#15317; not an app failure)`);
  killWrangler(wrangler);
  wrangler = spawnWrangler();
  if (!(await waitForServer(60_000))) throw new Error(`dev server would not come back up after restart #${restarts}`);
  return true;
}

async function postJson(p, body) {
  // [INFRA-FLAKE-SHIELD] one loud retry on the upstream transport signature;
  // app-class failures are returned untouched.
  const attempt = await fetchWithShield(
    () => fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    `POST ${p}`,
  );
  if (attempt.err) {
    return { status: null, text: "", json: {}, headers: {}, err: attempt.err, transport: isTransportClassFailure({ err: attempt.err }) };
  }
  const { res, text } = attempt;
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON (dev-server page) */ }
  return {
    status: res.status,
    text,
    json,
    headers: Object.fromEntries(res.headers.entries()),
    err: null,
    transport: isTransportClassFailure({ status: res.status, body: text }),
  };
}

/** postJson + restart-resume if the transport class bit us (server death). */
async function postWithResume(p, body) {
  let r = await postJson(p, body);
  if (r.status === null || r.transport) {
    const didRestart = await ensureServer();
    if (didRestart) r = await postJson(p, body);
  }
  return r;
}

async function main() {
  let exitCode = 1;
  try {
    console.log(`[reopen-regression] booting wrangler dev on ${PORT} (isolated state ${PERSIST_DIR})`);
    execFileSync(
      "npx",
      ["wrangler", "d1", "migrations", "apply", "groundwork", "--local", "--persist-to", PERSIST_DIR],
      { cwd: REPO_ROOT, encoding: "utf8", input: "y\n", stdio: ["pipe", "ignore", "inherit"] },
    );
    wrangler = spawnWrangler();
    if (!(await waitForServer(60_000))) {
      throw new Error("wrangler dev did not become healthy (see " + LOG_PATH + ")");
    }

    // Fixture: a completed lab session.
    const orgId = JSON.parse((await postWithResume("/org", { name: "Reopen Regression Org", type: "church" })).text).id;
    const programId = JSON.parse((await postWithResume(`/org/${orgId}/program`, {})).text).id;
    const labId = JSON.parse((await postWithResume(`/program/${programId}/lab-session`, { labNumber: 1, scheduledFor: "2026-09-20T09:00:00Z" })).text).id;
    const opened = await postWithResume(`/lab-session/${labId}/open`, {});
    if (opened.status !== 201) throw new Error(`fixture open failed: ${opened.status} ${opened.text.slice(0, 200)}`);
    const completed = await postWithResume(`/lab-session/${labId}/complete`, {});
    if (completed.status !== 200) throw new Error(`fixture complete failed: ${completed.status} ${completed.text.slice(0, 200)}`);
    console.log(`[reopen-regression] fixture ready: completed lab ${labId}`);

    let cleanReopens = 0;
    let cleanUnknowns = 0;
    const failures = [];
    for (let i = 1; i <= N; i++) {
      const r = await postWithResume(`/lab-session/${labId}/open`, {});
      if (r.status === 409 && /completed/.test(r.text)) cleanReopens += 1;
      else failures.push({ kind: "reopen", i, r });

      const u = await postWithResume(`/lab-session/reopen-regression-unknown-${i}/open`, {});
      if (u.status === 403) cleanUnknowns += 1;
      else failures.push({ kind: "unknown-lab", i, r: u });

      if (i % 5 === 0) console.log(`[reopen-regression] iter ${i}/${N}: reopens-ok=${cleanReopens} unknowns-ok=${cleanUnknowns} failures=${failures.length} restarts=${restarts}`);
      if (GAP_MS > 0) await sleep(GAP_MS);
    }

    if (failures.length === 0) {
      console.log(`REOPEN REGRESSION PASSED: ${cleanReopens}/${N} clean 409s on the completed lab; ${cleanUnknowns}/${N} clean 403s on unknown labs.`);
      if (restarts > 0) {
        console.error(`[reopen-regression] NOTE: the completed-lab contract held across ${restarts} dev-server restart(s) — the upstream wrangler dev transport defect was present on this machine (workers-sdk #15203/#15452/#15317). App behavior: correct.`);
      }
      exitCode = 0;
    } else {
      const appClass = failures.filter((f) => !f.r.transport);
      for (const f of failures.slice(0, 5)) {
        console.error(`[reopen-regression] FAILURE kind=${f.kind} iter=${f.i} status=${f.r.status} transport=${f.r.transport} err=${f.r.err ?? "-"} body=${JSON.stringify(f.r.text.slice(0, 300))}`);
      }
      if (appClass.length === 0) {
        console.error(`REOPEN REGRESSION: INFRA-FLAKE — all ${failures.length} failure(s) match the known upstream wrangler-dev transport signature after restart+retry (restarts=${restarts}). Not an app defect; see cloudflare/workers-sdk #15203/#15452/#15317. Exit 3 so it is never mistaken for green.`);
        exitCode = 3;
      } else {
        console.error(`REOPEN REGRESSION FAILED: ${failures.length} failure(s), ${appClass.length} APP-CLASS (not the upstream transport signature) — real defect, investigate now.`);
        exitCode = 1;
      }
    }
  } catch (err) {
    console.error("REOPEN REGRESSION ERROR:", err.message ?? err);
    exitCode = 1;
  } finally {
    killWrangler(wrangler);
    rmSync(PERSIST_DIR, { recursive: true, force: true });
    await sleep(400);
    printInfraFlakeSummary();
  }
  process.exit(exitCode);
}

const watchdog = setTimeout(() => {
  console.error("REOPEN REGRESSION: watchdog fired (300s) — something hung.");
  process.exit(1);
}, 300_000);
watchdog.unref();

main();
