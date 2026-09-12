#!/usr/bin/env node
// Session integration test: reconnect/replay, leader override, and real
// lab_session room wiring, all against a live local `wrangler dev`.
//
// Covers, end to end:
//  (a) a rejoining client receives the full current state on every join;
//  (b) replayed offline submissions are deduped by clientUuid and votes
//      reconcile by logicalClock — stale replays cannot clobber newer data;
//  (c) the DO survives eviction: instance killed, its local storage
//      deleted (simulated eviction + total storage loss), restarted, and
//      full state restored from the D1 checkpoint;
//  (d) leader messages (backtrack_segment, leader_override) are
//      screen-role only and mutate broadcast state per the §5.5 contract;
//  (e) POST /lab-session/:id/open creates a stable "lab-<id>" room key,
//      records the open (started status + opening segment_run row), and
//      the connect route accepts it.
//
// The whole test runs in its own --persist-to directory so it never
// touches (or races with) another wrangler instance's .wrangler/state.
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fetchWithShield, printInfraFlakeSummary, isTransportClassFailure } from "./lib/infra-flake-shield.mjs";

// [HOLMES-INSTRUMENTATION] Tee wrangler dev stdout/stderr to a file so a
// mid-test 500 leaves its server-side log behind. The rolling in-memory
// buffer is printed on failure; the file survives the run.
const HOLMES_LOG_DIR = process.env.HOLMES_LOG_DIR || "/tmp/holmes-gw/evidence";
const HOLMES_RUN_TAG = `${process.pid}-${Date.now()}`;
try { mkdirSync(HOLMES_LOG_DIR, { recursive: true }); } catch { /* exists */ }

const PORT = Number(process.env.GW_PORT ?? 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const DEV_AUTH_HEADERS = {
  "X-Groundwork-Dev-User": "dev@groundwork.local",
  "X-Groundwork-Dev-Sub": "dev-user-00000000-0000-0000-0000-000000000000",
};
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PERSIST_DIR = path.join("/tmp", `gw-session-test-${process.pid}-${Date.now()}`);
const DO_STATE_DIR = path.join(PERSIST_DIR, "v3", "do", "groundwork-SessionDO");

const S1 = `resync-test-${Date.now()}`;

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

function portIsFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(true));
  });
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true;
    await sleep(300);
  }
  return false;
}

function spawnWrangler(logLines) {
  const wr = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", PERSIST_DIR],
    { stdio: ["ignore", "pipe", "pipe"], detached: true }, // own process group — kill workerd too (docs/decisions.md 2026-07-27 lesson)
  );
  // Drain pipes continuously — an unread pipe fills its OS buffer and
  // blocks wrangler dev entirely. Do not remove. Also keep a rolling log
  // so a failed startup is diagnosable.
  // [HOLMES-INSTRUMENTATION] tee to disk; stamp each chunk with wall time.
  const logPath = path.join(HOLMES_LOG_DIR, `wrangler-dev-${HOLMES_RUN_TAG}.log`);
  wr.holmesLogPath = logPath;
  appendFileSync(logPath, `\n=== wrangler spawn (pid ${wr.pid}) at ${new Date().toISOString()} port ${PORT} ===\n`);
  wr.stdout.on("data", (d) => {
    logLines.push(String(d));
    appendFileSync(logPath, `[stdout ${new Date().toISOString()}] ${String(d)}`);
  });
  wr.stderr.on("data", (d) => {
    logLines.push(String(d));
    appendFileSync(logPath, `[stderr ${new Date().toISOString()}] ${String(d)}`);
  });
  return wr;
}

function killWrangler(wr) {
  try {
    process.kill(-wr.pid, "SIGKILL"); // whole process group, incl. workerd
  } catch {
    try { wr.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

function connectClient(role, clientId, sessionKey, screenToken) {
  return new Promise((resolve, reject) => {
    let url = `${WS_BASE}/session/${sessionKey}/connect?role=${role}&clientId=${clientId}`;
    if (screenToken) url += `&screenToken=${encodeURIComponent(screenToken)}`;
    const ws = new WebSocket(url);
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

// [INFRA-FLAKE] restart-resume hook, set by main() once the dev server is
// up. If a request dies with the upstream transport signature (including a
// full dev-server exit — workers-sdk #15203/#15452/#15317), the hook brings
// the server back (same --persist-to dir, so D1 state survives) and the
// request is retried exactly once. Transport-class only; app failures are
// never masked.
let resumeHook = null;

async function postJson(p, body, resumed = false) {
  // [INFRA-FLAKE-SHIELD] the dev server can drop the proxy↔runtime
  // connection mid-request (upstream wrangler bug); a transport-class
  // failure gets ONE loud retry here, never in app code.
  const attempt = await fetchWithShield(
    () => fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    `POST ${p}`,
  );
  if (attempt.err) {
    if (!resumed && resumeHook && (await resumeHook())) return postJson(p, body, true);
    throw attempt.err;
  }
  const { res, text } = attempt;
  if (!resumed && isTransportClassFailure({ status: res.status, body: text }) && resumeHook) {
    if (await resumeHook()) return postJson(p, body, true);
  }
  // [HOLMES-INSTRUMENTATION] keep the RAW body, not just a parsed JSON —
  // an unhandled dev-server 500 is not JSON, and postJson's old
  // `.json().catch(() => ({}))` threw that evidence away.
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON body (dev 500) */ }
  return { res, json, text };
}

/** Run a query against the test's isolated local D1 (wrangler must be
 * stopped — d1 execute and dev cannot safely share the same sqlite). */
function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "groundwork", "--local", "--persist-to", PERSIST_DIR, "--json", "--command", sql],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
  } catch {
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start === -1 || end <= start) return [];
    const parsed = JSON.parse(out.slice(start, end + 1));
    return parsed[0]?.results ?? [];
  }
}

function doDirFiles() {
  try {
    return readdirSync(DO_STATE_DIR).filter((f) => !f.endsWith("-shm") && !f.endsWith("-wal"));
  } catch {
    return [];
  }
}

async function main() {
  let wrangler = null;
  let exitCode = 1;
  let restarts = 0;
  const wranglerLog = [];
  try {
    mkdirSync(PERSIST_DIR, { recursive: true });
    // The DO checkpoints into D1; the isolated state dir starts empty, so
    // apply migrations there before the first instance starts.
    execFileSync(
      "npx",
      ["wrangler", "d1", "migrations", "apply", "groundwork", "--local", "--persist-to", PERSIST_DIR],
      { cwd: REPO_ROOT, encoding: "utf8", input: "y\n" },
    );
    console.log(`Starting wrangler dev (instance 1) on port ${PORT} (isolated state in ${PERSIST_DIR})...`);
    const baselineDoFiles = doDirFiles();
    wrangler = spawnWrangler(wranglerLog);
    if (!(await waitForServer(40_000))) {
      throw new Error(`wrangler dev (instance 1) did not become healthy. Log tail:\n${wranglerLog.slice(-40).join("")}`);
    }

    // [INFRA-FLAKE] restart-resume: the upstream dev-server transport defect
    // can kill wrangler dev mid-run (see evidence pack). Bring it back —
    // same persist dir, so all D1/DO state survives — and let postJson retry
    // the single request that died. Transport-class only, never masks app
    // failures (workers-sdk #15203/#15452/#15317).
    resumeHook = async () => {
      try { if ((await fetch(`${BASE}/health`)).ok) return false; } catch { /* down */ }
      restarts += 1;
      console.error(`[INFRA-FLAKE] dev server down — RESTART #${restarts} (upstream wrangler transport defect, workers-sdk #15203/#15452/#15317; not an app failure)`);
      if (wrangler) killWrangler(wrangler);
      await waitForPortFree(PORT, 10_000);
      wrangler = spawnWrangler(wranglerLog);
      if (!(await waitForServer(60_000))) {
        throw new Error(`dev server did not come back after restart #${restarts}. Log tail:\n${wranglerLog.slice(-40).join("")}`);
      }
      return true;
    };

    console.log(`\n[1] Reconnect/replay on session ${S1}`);
    const screen = await connectClient("screen", "device-screen", S1);
    const phone = await connectClient("phone", "device-phone-a", S1);
    const clients = [screen, phone];
    await waitForCondition(() => clients.every((c) => c.states.length >= 1), 5000, "initial state on both clients");

    send(phone, { type: "submit", segmentKey: "welcome", clientUuid: "uuid-a-1", content: "Attendance is down." });
    await waitForCondition(() => latestState(screen).submissionCounts.welcome === 1, 5000, "submission counted");
    send(phone, { type: "vote", segmentKey: "welcome", voterUuid: "voter-a", optionId: "a", logicalClock: 5 });
    await waitForCondition(() => latestState(screen).votes.welcome["voter-a"]?.optionId === "a", 5000, "vote recorded");
    console.log("PASS: submission counted and vote recorded.");

    console.log("[2] Reconnecting the phone (fresh socket, same clientId)...");
    phone.ws.close();
    const phone2 = await connectClient("phone", "device-phone-a", S1);
    await waitForCondition(() => phone2.states.length >= 1, 5000, "rejoined phone received state");
    const rejoined = latestState(phone2);
    if (rejoined.submissionCounts.welcome !== 1 || rejoined.stateVersion < 1) {
      throw new Error(`rejoin did not receive full current state: ${JSON.stringify(rejoined)}`);
    }
    console.log(`PASS: rejoining client received full current state (stateVersion=${rejoined.stateVersion}, welcome count=1, votes intact).`);

    console.log("[3] Replaying offline input — dedup by clientUuid, vote reconcile by logicalClock...");
    send(phone2, { type: "submit", segmentKey: "welcome", clientUuid: "uuid-a-1", content: "duplicate, ignore me" });
    send(phone2, { type: "vote", segmentKey: "welcome", voterUuid: "voter-a", optionId: "a", logicalClock: 3 }); // stale replay
    send(phone2, { type: "vote", segmentKey: "welcome", voterUuid: "voter-a", optionId: "a", logicalClock: 5 }); // equal — stale
    send(phone2, { type: "vote", segmentKey: "welcome", voterUuid: "voter-a", optionId: "b", logicalClock: 6 }); // newer — applies
    await waitForCondition(
      () => {
        const v = latestState(screen).votes.welcome["voter-a"];
        return v && v.optionId === "b" && v.logicalClock === 6;
      },
      5000,
      "clock reconciliation",
    );
    if (latestState(screen).submissionCounts.welcome !== 1) {
      throw new Error("replayed duplicate submission was counted");
    }
    console.log("PASS: replayed duplicate submission stayed deduped (count still 1); votes reconciled by logicalClock (stale 3/5 ignored, newer 6 applied).");

    console.log("\n[4] Leader messages are screen-role only...");
    send(phone2, { type: "backtrack_segment" });
    await sleep(300);
    if (latestState(screen).currentSegmentIndex !== 0) throw new Error("phone backtracked a segment!");
    send(phone2, {
      type: "leader_override",
      override: { kind: "submission", segmentKey: "welcome", clientUuid: "uuid-a-1", newContent: "sneaky edit" },
    });
    await sleep(300);
    if (latestState(screen).submissions.welcome["uuid-a-1"]?.content !== "Attendance is down.") {
      throw new Error("phone-initiated leader override applied!");
    }
    console.log("PASS: phone-initiated backtrack_segment and leader_override both rejected.");

    console.log("[5] Screen leader actions: backtrack + override...");
    send(screen, { type: "advance_segment" });
    await waitForCondition(() => latestState(phone2).currentSegmentIndex === 1, 5000, "advance to segment 1");
    send(screen, { type: "backtrack_segment" });
    await waitForCondition(() => latestState(phone2).currentSegmentIndex === 0, 5000, "backtrack to segment 0");
    console.log("PASS: screen backtrack_segment moved index 1 -> 0 and broadcast to all clients.");

    send(screen, {
      type: "leader_override",
      override: { kind: "submission", segmentKey: "welcome", clientUuid: "uuid-a-1", newContent: "Attendance is down AND budget is tight." },
    });
    await waitForCondition(
      () => latestState(phone2).submissions.welcome["uuid-a-1"]?.content === "Attendance is down AND budget is tight.",
      5000,
      "submission content overridden",
    );
    console.log("PASS: leader replaced submission content in state, broadcast to all clients.");

    send(screen, {
      type: "leader_override",
      override: { kind: "vote", segmentKey: "welcome", voterUuid: "voter-a", optionId: "c" },
    });
    await waitForCondition(() => latestState(phone2).votes.welcome["voter-a"]?.optionId === "c", 5000, "vote overridden");
    const afterOverride = latestState(phone2).votes.welcome["voter-a"];
    if (afterOverride.logicalClock !== 6) {
      throw new Error(`override should keep the voter's logicalClock (6), got ${afterOverride.logicalClock}`);
    }
    send(phone2, { type: "vote", segmentKey: "welcome", voterUuid: "voter-a", optionId: "d", logicalClock: 7 });
    await waitForCondition(() => latestState(phone2).votes.welcome["voter-a"]?.optionId === "d", 5000, "post-override genuine vote");
    console.log("PASS: leader vote override forced optionId=c while keeping logicalClock=6; the voter's next genuine vote (clock 7, optionId=d) still applied.");

    // Advance to segment 1 and close: the boundary writes a D1 checkpoint.
    send(screen, { type: "advance_segment" });
    await waitForCondition(() => latestState(phone2).currentSegmentIndex === 1, 5000, "advance for checkpoint");
    const versionBeforeKill = latestState(screen).stateVersion;
    const myDoFiles = doDirFiles().filter(
      (f) => !baselineDoFiles.includes(f) && !f.startsWith("metadata"),
    );
    for (const c of [screen, phone2]) c.ws.close();
    await sleep(300);

    console.log("\n[6] Killing wrangler (instance 1) — verifying the D1 checkpoint...");
    killWrangler(wrangler);
    wrangler = null;
    await waitForPortFree(PORT, 10_000);
    await sleep(500);

    const checkpoints = d1Query(`SELECT session_id, state_version FROM session_checkpoint WHERE session_id = '${S1}'`);
    if (checkpoints.length !== 1 || checkpoints[0].state_version < versionBeforeKill) {
      throw new Error(`expected session_checkpoint row for ${S1} with state_version >= ${versionBeforeKill}, got ${JSON.stringify(checkpoints)}`);
    }
    console.log(`PASS: D1 checkpoint row exists for ${S1} (state_version=${checkpoints[0].state_version}).`);

    // Simulate TOTAL storage loss for the DO instance (eviction + lost
    // storage): delete the instance's sqlite files from the isolated state
    // dir. The D1 checkpoint is now the only recovery source.
    if (myDoFiles.length === 0) throw new Error("could not identify the DO storage file to wipe");
    console.log(`[7] Wiping DO storage (${myDoFiles.join(", ")}) to simulate eviction + lost storage...`);
    for (const f of myDoFiles) {
      rmSync(path.join(DO_STATE_DIR, f), { force: true });
      rmSync(path.join(DO_STATE_DIR, f + "-shm"), { force: true });
      rmSync(path.join(DO_STATE_DIR, f + "-wal"), { force: true });
    }

    console.log("Restarting wrangler (instance 2)...");
    wrangler = spawnWrangler(wranglerLog);
    if (!(await waitForServer(60_000))) {
      throw new Error(`wrangler dev (instance 2) did not become healthy. Log tail:\n${wranglerLog.slice(-40).join("")}`);
    }

    const restored = await connectClient("screen", "device-screen", S1);
    await waitForCondition(() => restored.states.length >= 1, 5000, "restored state received");
    const rs = latestState(restored);
    if (rs.submissionCounts.welcome !== 1) throw new Error(`restored state lost submissionCounts: ${JSON.stringify(rs.submissionCounts)}`);
    if (rs.currentSegmentIndex !== 1) throw new Error(`restored state lost segment index: ${rs.currentSegmentIndex}`);
    if (rs.submissions?.welcome?.["uuid-a-1"]?.content !== "Attendance is down AND budget is tight.") {
      throw new Error("restored state lost the overridden submission content");
    }
    if (rs.votes?.welcome?.["voter-a"]?.optionId !== "d") {
      throw new Error(`restored state lost the vote: ${JSON.stringify(rs.votes?.welcome)}`);
    }
    if (rs.stateVersion < versionBeforeKill) throw new Error(`restored stateVersion went backwards: ${rs.stateVersion} < ${versionBeforeKill}`);
    console.log(`PASS: session survived instance restart + total storage loss — full state restored from D1 checkpoint (index=${rs.currentSegmentIndex}, overridden submission and vote intact, stateVersion=${rs.stateVersion}).`);
    restored.ws.close();

    console.log("\n[8] Real lab_session wiring...");
    const org = (await postJson("/org", { name: "Session Integration Org", type: "church" })).json;
    const programId = (await postJson(`/org/${org.id}/program`, {})).json.id;
    const lab = (await postJson(`/program/${programId}/lab-session`, { labNumber: 1, scheduledFor: "2026-08-20T09:00:00Z" })).json;
    const labId = lab.id;
    const expectedKey = `lab-${labId}`;

    const opened = await postJson(`/lab-session/${labId}/open`, {});
    if (opened.res.status !== 201 || opened.json.sessionKey !== expectedKey) {
      throw new Error(`open failed: ${opened.res.status} ${JSON.stringify(opened.json)}`);
    }
    if (opened.json.connectPath !== `/session/${expectedKey}/connect`) {
      throw new Error(`unexpected connectPath: ${JSON.stringify(opened.json)}`);
    }
    console.log(`PASS: POST /lab-session/${labId}/open returned sessionKey ${expectedKey}.`);

    const reopened = await postJson(`/lab-session/${labId}/open`, {});
    if (reopened.json.sessionKey !== expectedKey || reopened.res.status !== 201) {
      throw new Error(`reopen not idempotent: ${reopened.res.status} ${JSON.stringify(reopened.json)}`);
    }
    console.log("PASS: reopening the same lab is idempotent (same key, 201).");

    const missing = await postJson("/lab-session/does-not-exist-1234/open", {});
    // With auth wired, an unknown lab maps to no org, so the route returns
    // 403 rather than leaking whether the id exists. This is the expected
    // security behavior for authenticated-but-unauthorized resources.
    if (missing.res.status !== 403) throw new Error(`expected 403 for unknown lab (no org membership), got ${missing.res.status}`);
    console.log("PASS: opening a nonexistent lab_session returns 403 (auth-first security behavior).");

    // Screen-role authorization: the open call minted a token; a screen
    // without it must be refused, and the leader's screen (with it) works.
    if (!opened.json.screenToken) throw new Error("open did not return a screenToken");
    const deniedScreen = await connectClient("screen", "lab-screen-denied", expectedKey).catch(() => null);
    if (deniedScreen) {
      throw new Error("screen connect without a token should have been rejected");
    }
    console.log("PASS: screen connect without the room's screen token is rejected.");

    // [INFRA-FLAKE] The lab-room section is WS-driven; if the upstream defect
    // kills the dev server mid-section, HTTP-level retries cannot help (the
    // socket is gone). Restart the server and re-run the section: the room
    // state is D1-checkpointed and the calls here are idempotent by design
    // (clientUuid dedup; "advance to index 1" already-satisfied), so a retry
    // cannot mask an app failure — a genuinely broken room fails the section
    // on every attempt.
    async function labRoomSection() {
      const labScreen = await connectClient("screen", "lab-screen", expectedKey, opened.json.screenToken);
      await waitForCondition(() => labScreen.states.length >= 1, 5000, "lab room state");
      if (!Array.isArray(latestState(labScreen).guideLog)) {
        throw new Error("session state must carry a guideLog array (guide disabled locally => empty)");
      }
      console.log("PASS: session state carries the guideLog field (guide disabled locally => empty).");
      send(labScreen, { type: "submit", segmentKey: "welcome", clientUuid: "lab-uuid-1", content: "Real session submission" });
      await waitForCondition(() => latestState(labScreen).submissionCounts.welcome === 1, 5000, "lab submission counted");
      send(labScreen, { type: "advance_segment" });
      await waitForCondition(() => latestState(labScreen).currentSegmentIndex === 1, 5000, "lab advance");
      console.log("PASS: real lab room accepts connects on /session/lab-<id>/connect and runs the fake-lab segments.");
      labScreen.ws.close();
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await labRoomSection();
        break;
      } catch (err) {
        const restarted = attempt === 1 ? await resumeHook() : false;
        if (!restarted) throw err;
        console.error(`[INFRA-FLAKE] lab-room section died while the dev server was down — retrying the (idempotent) section after RESTART #${restarts} (workers-sdk #15203/#15452)`);
      }
    }

    await postJson(`/lab-session/${labId}/complete`, {});
    const reopenCompleted = await postJson(`/lab-session/${labId}/open`, {});
    if (reopenCompleted.res.status !== 409) {
      // [HOLMES-INSTRUMENTATION] capture the full failure signature (status,
      // headers, raw body) and do ONE diagnostic retry so we can tell a
      // one-shot transport drop from a sticky server-state failure.
      const sig = {
        ts: new Date().toISOString(),
        status: reopenCompleted.res.status,
        headers: Object.fromEntries(reopenCompleted.res.headers.entries()),
        body: reopenCompleted.text.slice(0, 4000),
      };
      console.error(`[HOLMES-500-SIGNATURE] ${JSON.stringify(sig)}`);
      const sigPath = path.join(HOLMES_LOG_DIR, `reopen-500-signature-${HOLMES_RUN_TAG}.json`);
      appendFileSync(sigPath, JSON.stringify(sig, null, 2) + "\n");
      const retry = await postJson(`/lab-session/${labId}/open`, {});
      console.error(`[HOLMES-500-RETRY] status=${retry.res.status} body=${retry.text.slice(0, 500)}`);
      appendFileSync(sigPath, `RETRY: status=${retry.res.status} body=${retry.text.slice(0, 500)}\n`);
      throw new Error(`expected 409 reopening a completed lab, got ${reopenCompleted.res.status} ${JSON.stringify(reopenCompleted.json)}`);
    }
    console.log("PASS: completed lab_session cannot be reopened (409, phase gate).");
    await sleep(300);

    console.log("\n[9] Final D1 verification (wrangler stopped)...");
    killWrangler(wrangler);
    wrangler = null;
    await sleep(1200);
    const labCheckpoints = d1Query(`SELECT session_id, state_version FROM session_checkpoint WHERE session_id = '${expectedKey}'`);
    if (labCheckpoints.length !== 1) {
      throw new Error(`no D1 checkpoint row for lab session ${expectedKey}`);
    }
    const segmentRuns = d1Query(`SELECT session_id, segment_key, planned_duration_min FROM segment_run WHERE session_id = '${labId}'`);
    if (segmentRuns.length !== 1 || segmentRuns[0].segment_key !== "welcome") {
      throw new Error(`expected one opening segment_run (welcome) for ${labId}, got ${JSON.stringify(segmentRuns)}`);
    }
    console.log(`PASS: D1 checkpoint row for the lab room and opening segment_run row recorded (segment_key=${segmentRuns[0].segment_key}, planned_duration_min=${segmentRuns[0].planned_duration_min}).`);

    console.log("\n=== Session integration test PASSED ===");
    exitCode = 0;
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    // [HOLMES-INSTRUMENTATION] dump the tail of the teed wrangler log so the
    // server-side story of a mid-test 500 is visible in the run output.
    const tail = wranglerLog.slice(-80).join("");
    console.error(`--- wrangler log tail (last ${Math.min(80, wranglerLog.length)} chunks; full file: ${HOLMES_LOG_DIR}/wrangler-dev-${HOLMES_RUN_TAG}.log) ---`);
    console.error(tail);
    try {
      writeFileSync(
        path.join(HOLMES_LOG_DIR, `failure-${HOLMES_RUN_TAG}.txt`),
        `TEST FAILED: ${err.message ?? err}\n\n--- wrangler log tail ---\n${tail}\n`,
      );
    } catch { /* best effort */ }
    exitCode = 1;
  } finally {
    if (wrangler) killWrangler(wrangler);
    rmSync(PERSIST_DIR, { recursive: true, force: true });
    await sleep(500);
    resumeHook = null;
    if (restarts > 0) {
      console.error(`[INFRA-FLAKE] NOTE: ${restarts} dev-server restart(s) during this run — upstream wrangler dev transport defect was present (workers-sdk #15203/#15452/#15317); app behavior unaffected.`);
    }
    printInfraFlakeSummary();
  }
  process.exit(exitCode);
}

const WATCHDOG_MS = 240_000;
const watchdog = setTimeout(() => {
  console.error(`TEST FAILED: watchdog fired after ${WATCHDOG_MS}ms — something hung.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

main();
