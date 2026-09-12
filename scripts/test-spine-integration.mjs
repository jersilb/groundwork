#!/usr/bin/env node
// Session-spine integration smoke (build plan §6 R0/R2): a live local
// `wrangler dev` with SESSION_SPINE=true runs the six-hour reference plan,
// and a screen-role client drives the real protocol end to end:
//
//   start_session → advance → start_break → protected end_break rejected →
//   extend_break → end_break ok → advance → start_breakout → end_breakout →
//   end_session blocked on missing outputs → force-close recorded as override.
//
// Proves the DO wiring (state shape, runtime persistence, screen gating,
// error reasons reaching the client) — the pure gates prove the machine;
// this proves the plumbing. Runs in its own --persist-to directory.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { wsJsonFrame, printInfraFlakeSummary, isTransportText } from "./lib/infra-flake-shield.mjs";

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PERSIST_DIR = path.join("/tmp", `gw-spine-test-${process.pid}-${Date.now()}`);
const SESSION_KEY = `spine-smoke-${Date.now()}`;

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

// L1 lesson: detached process group + drained pipes, or wrangler wedges.
function spawnWrangler(logLines) {
  const wr = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", PERSIST_DIR, "--var", "SESSION_SPINE:true", "--var", "GUIDE_ENABLED:false"],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  wr.stdout.on("data", (d) => logLines.push(String(d)));
  wr.stderr.on("data", (d) => logLines.push(String(d)));
  return wr;
}

function killWrangler(wr) {
  try {
    process.kill(-wr.pid, "SIGKILL");
  } catch {
    try { wr.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

function connectScreen(sessionKey) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/session/${sessionKey}/connect?role=screen&clientId=spine-smoke-screen`);
    const client = { ws, states: [], errors: [] };
    ws.addEventListener("message", (ev) => {
      // [INFRA-FLAKE-SHIELD v2] WS frames parse through the shield (transport
      // frames counted + dropped; other non-JSON throws — never silent).
      const msg = wsJsonFrame(ev.data, "ws:spine-screen");
      if (!msg) return;
      if (msg.type === "state") client.states.push(msg.state);
      if (msg.type === "error") client.errors.push(msg.message);
    });
    ws.addEventListener("open", () => resolve(client));
    ws.addEventListener("error", reject);
  });
}

function send(client, message) {
  client.ws.send(JSON.stringify(message));
}

function latest(client) {
  return client.states[client.states.length - 1];
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function act(client, action, label) {
  // Wait for the server to ACT (stateVersion bump) or REJECT (error) — a
  // fixed sleep races the broadcast on a cold DO, exactly like the room
  // screen's pending-advance pattern.
  const versionBefore = latest(client)?.stateVersion ?? 0;
  const errorsBefore = client.errors.length;
  send(client, { type: "spine_action", action, actionId: label });
  await waitFor(
    () => (latest(client)?.stateVersion ?? 0) > versionBefore || client.errors.length > errorsBefore,
    5_000,
    `${label} applied or rejected`,
  );
  return { state: latest(client), rejected: client.errors.length > errorsBefore, reason: client.errors.slice(errorsBefore).join("; ") };
}

async function main() {
  const logLines = [];
  let wrangler = null;
  let failures = 0;
  const ok = (label, cond, detail) => {
    if (cond) console.log(`PASS: ${label}`);
    else {
      failures += 1;
      console.error(`FAIL: ${label}${detail ? " — " + detail : ""}`);
    }
  };

  try {
    if (!(await waitForPortFree(PORT, 10_000))) throw new Error(`port ${PORT} busy`);
    wrangler = spawnWrangler(logLines);
    if (!(await waitForServer(120_000))) {
      throw new Error("wrangler dev did not come up — log tail:\n" + logLines.slice(-30).join(""));
    }

    const screen = await connectScreen(SESSION_KEY);
    await waitFor(() => screen.states.length >= 1, 10_000, "initial state");

    const s0 = latest(screen);
    ok("spine state carries the six-hour plan", s0.runtime?.planId === "groundwork.reference.six-hour" && s0.segments.length === 9);
    ok("runtime starts in setup with an event log", s0.runtime.phase === "setup" && Array.isArray(s0.runtime.events) && s0.runtime.events.length >= 1);

    // start_session → active
    let r = await act(screen, { type: "start_session" }, "start");
    ok("start_session moves setup → active", r.state.runtime.phase === "active", r.reason);

    // advance s1 (welcome) with two submissions riding the normal path —
    // the demo spec's floor is 2, and the auto-audit needs the floor met.
    send(screen, { type: "submit", segmentKey: "s1-welcome", clientUuid: "u1", content: "Orientation acknowledged by the team." });
    send(screen, { type: "submit", segmentKey: "s1-welcome", clientUuid: "u2", content: "We know who leads and how corrections work." });
    await waitFor(() => latest(screen).submissionCounts["s1-welcome"] === 2, 5000, "submissions counted");
    r = await act(screen, { type: "advance_segment" }, "adv1");
    ok(
      "advance lands on segment 2 with the ledger entry recorded",
      r.state.currentSegmentIndex === 1 && "s1-welcome" in r.state.runtime.segmentActualMinutes,
      r.reason,
    );
    ok("statement output auto-completed on the submission floor", r.state.runtime.outputs.some((o) => o.key === "out.orientation_ack" && o.status === "complete"), JSON.stringify(r.state.runtime.outputs));

    // walk to the first break boundary (s2, s3)
    r = await act(screen, { type: "advance_segment" }, "adv2");
    ok("advance to s3", r.state.currentSegmentIndex === 2, r.reason);
    r = await act(screen, { type: "advance_segment" }, "adv3");
    ok("advance to s4 (break boundary)", r.state.currentSegmentIndex === 3, r.reason);

    // break lifecycle
    r = await act(screen, { type: "start_break" }, "brk-start");
    ok("break starts at the anchored boundary", r.state.runtime.phase === "break" && r.state.runtime.breakState?.breakId === "brk-1", r.reason);
    ok("the room heard the break announcement", (r.state.guideLog ?? []).some((m) => m.kind === "announcement"));
    r = await act(screen, { type: "end_break" }, "brk-early");
    ok("end_break below the protected minimum is rejected with a readable reason", r.rejected && r.reason.includes("protected minimum break"), r.reason);
    r = await act(screen, { type: "extend_break", minutes: 5 }, "brk-ext");
    ok("extend_break lands", r.state.runtime.breakState?.extraMinutes === 5, r.reason);
    r = await act(screen, { type: "end_break", force: true }, "brk-force");
    ok("forced early end lands and is recorded as an override", r.state.runtime.phase === "active" && r.state.runtime.events.some((e) => e.kind === "override"), r.reason);

    // breakout on s4
    r = await act(screen, { type: "start_breakout" }, "bo-start");
    ok("breakout starts on its anchor segment", r.state.runtime.phase === "breakout" && r.state.runtime.breakoutState?.breakoutId === "bo-themes", r.reason);
    r = await act(screen, { type: "end_breakout" }, "bo-end");
    ok("breakout returns the room to active", r.state.runtime.phase === "active", r.reason);

    // human-led round trip
    r = await act(screen, { type: "enter_human_led" }, "floor");
    ok("take the floor enters human-led recovery", r.state.runtime.phase === "recovery" && r.state.runtime.guideMode === "human_led", r.reason);
    r = await act(screen, { type: "return_to_ai_led" }, "ai-back");
    ok("return to AI-led restores the room", r.state.runtime.phase === "active" && r.state.runtime.guideMode === "ai_led", r.reason);

    // phone-role gate: a phone may not run leader actions — the phone's own
    // socket gets the rejection (§5.5).
    const phone = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/session/${SESSION_KEY}/connect?role=phone&clientId=spine-smoke-phone`);
      const phoneClient = { ws, errors: [] };
      ws.addEventListener("message", (ev) => {
        const msg = wsJsonFrame(ev.data, "ws:spine-phone");
        if (!msg) return;
        if (msg.type === "error") phoneClient.errors.push(msg.message);
      });
      ws.addEventListener("open", () => resolve(phoneClient));
      ws.addEventListener("error", reject);
    });
    phone.ws.send(JSON.stringify({ type: "spine_action", action: { type: "advance_segment" } }));
    await sleep(250);
    ok("phones cannot run instructor actions (§5.5)", phone.errors.some((e) => e.includes("only the shared screen")), phone.errors.join("; "));
    phone.ws.close();

    // participant correction over the wire (from the screen connection —
    // phones may also send it; the DO treats it identically: parked, never mutating)
    send(screen, { type: "guide_feedback", aboutMessageId: "gm-x", text: "The probe missed our second theme." });
    await sleep(250);
    ok("participant correction parks an issue", latest(screen).runtime.parkedIssues.some((i) => i.source === "participant"));

    // closing gate: run to the final segment, then attempt a silent close
    for (let i = 0; i < 8; i++) {
      r = await act(screen, { type: "advance_segment" }, `adv-${i}`);
      if (!r.state || r.state.currentSegmentIndex === 8) break;
    }
    ok("walk reaches the final segment under closing protection", latest(screen).runtime.phase === "closing", "advance loop");
    r = await act(screen, { type: "end_session" }, "close-blocked");
    ok("silent completion is blocked with the missing list", r.rejected && r.reason.includes("required output"), r.reason);
    r = await act(screen, { type: "end_session", force: true }, "close-force");
    ok("forced close completes and records the gap", r.state.runtime.phase === "complete" && r.state.runtime.completedWithMissingOutputs === true, r.reason);

    // restart resilience: kill the instance, wipe nothing, restart, rejoin
    killWrangler(wrangler);
    wrangler = null;
    await waitForPortFree(PORT, 15_000);
    wrangler = spawnWrangler(logLines);
    if (!(await waitForServer(120_000))) throw new Error("wrangler restart failed");
    const rejoined = await connectScreen(SESSION_KEY);
    await waitFor(() => rejoined.states.length >= 1, 10_000, "restored state");
    const rs = latest(rejoined);
    ok("spine session survives DO eviction with runtime intact", rs.runtime?.phase === "complete" && rs.runtime.completedWithMissingOutputs === true && rs.runtime.events.length > 0);
    rejoined.ws.close();
    screen.ws.close();

    console.log(failures === 0 ? "\n=== Spine integration smoke PASSED ===" : `\n=== ${failures} spine smoke check(s) FAILED ===`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (err) {
    console.error("SMOKE ERROR:", err instanceof Error ? err.message : err);
    console.error(logLines.slice(-25).join(""));
    process.exitCode = isTransportText(err?.message ?? "") ? 3 : 1;
  } finally {
    if (wrangler) killWrangler(wrangler);
    printInfraFlakeSummary();
  }
}

await main();
