#!/usr/bin/env node
// Self-test for the infra-flake shield (v2). Runs WITHOUT any dev server.
//
// Fixes the exact CI-34672204710 failure bytes as fixtures and asserts:
//   1. the OLD naive CLI parse (indexOf("[")/lastIndexOf("]")) FAILS on the
//      polluted stdout — that was the position-191 parse error;
//   2. d1Rows (string-aware extraction) SUCCEEDS on the same bytes;
//   3. fetchJsonWithShield retries transport bodies once and parses clean ones;
//   4. app-class errors are never retried/masked;
//   5. wsJsonFrame counts+drops transport frames, passes JSON, throws on
//      genuine protocol garbage.
import assert from "node:assert/strict";
import {
  d1Rows,
  extractJsonPayload,
  fetchJsonWithShield,
  infraFlake,
  isTransportClassFailure,
  isTransportError,
  isTransportText,
  parseJsonText,
  printInfraFlakeSummary,
  wsJsonFrame,
} from "./lib/infra-flake-shield.mjs";

let failed = 0;
const ok = (label, fn) => {
  try {
    fn();
    console.log(`PASS: ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${label} — ${err.message}`);
  }
};

// ---- Fixture A: the exact polluted stdout shape from CI run 34672204710 ----
// (the session-integration [6] d1 checkpoint query: WRANGLER_LOG=debug writes
// the 🪵 line + .env notes to stdout and a trailing telemetry line whose
// "argsUsed":[...] array supplies a `]` AFTER the payload).
const POLLUTED_STDOUT = `🪵  Writing logs to "/home/runner/.config/.wrangler/logs/wrangler-2026-09-12_04-08-33_772.log"
.env file not found at "/home/runner/work/groundwork/groundwork/.env". Continuing... For more details, refer to https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
.env file not found at "/home/runner/work/groundwork/groundwork/.env.local". Continuing... For more details, refer to https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
[
  {
    "results": [
      {
        "session_id": "resync-test-1789186109471",
        "state_version": 2
      }
    ],
    "success": true,
    "meta": {
      "duration": 0.33,
      "changes": 0,
      "last_row_id": 0,
      "changed_db": false,
      "size_after": 102400,
      "rows_read": 1,
      "rows_written": 0
    }
  }
]
Metrics dispatcher: Posting data {"deviceId":"0455e1c7-16cf-4615-91d6-5fcbde29bb69","event":"wrangler command completed","timestamp":1789186114140,"properties":{"amplitude_session_id":1789186114120,"amplitude_event_id":1,"wranglerVersion":"4.123.0","wranglerMajorVersion":4,"wranglerMinorVersion":123,"wranglerPatchVersion":0,"osPlatform":"Linux","osVersion":"ubuntu","nodeVersion":22,"packageManager":"npm","isFirstUsage":false,"configFileType":"toml","isCI":true,"isPagesCI":false,"isWorkersCI":true,"isInteractive":false,"hasAssets":true,"agent":null,"argsUsed":["command","json","local","persistTo"],"argsCombination":"command, json, local, persistTo","sanitizedCommand":"d1 execute","sanitizedArgs":{"local":true,"json":true},"durationMs":149,"currentAgentSkillsInstalled":null}}
`;

ok("OLD naive parse FAILS on the polluted stdout (this was position-191)", () => {
  let oldError = null;
  try {
    JSON.parse(POLLUTED_STDOUT);
  } catch {
    try {
      const start = POLLUTED_STDOUT.indexOf("[");
      const end = POLLUTED_STDOUT.lastIndexOf("]");
      JSON.parse(POLLUTED_STDOUT.slice(start, end + 1));
    } catch (e2) {
      oldError = e2.message;
    }
  }
  assert.ok(oldError, "the old two-step parse was expected to throw");
  assert.match(oldError, /non-whitespace character after JSON/);
  console.log(`      old error (as seen in CI): ${oldError}`);
});

ok("d1Rows extracts the real rows from the same polluted stdout", () => {
  const rows = d1Rows(POLLUTED_STDOUT, "fixture d1 checkpoint query");
  assert.deepEqual(rows, [{ session_id: "resync-test-1789186109471", state_version: 2 }]);
});

ok("extractJsonPayload handles junk before + after and ANSI codes", () => {
  const noisy = `\u001b[36;1msome preamble\u001b[0m\n  [\n  {"results":[{"a":1}]}\n]\ntrailing {"x":{"y"]":[1]}}`;
  const payload = extractJsonPayload(noisy, { preferType: "array" });
  assert.ok(payload, "payload expected");
  assert.deepEqual(payload.value, [{ results: [{ a: 1 }] }]);
});

ok("extractJsonPayload prefers the array when telemetry objects precede it", () => {
  const noiseFirst = `Metrics dispatcher: Posting data {"a":[1,2],"b":"x]y"}\n[{"results":[]}]\n`;
  const payload = extractJsonPayload(noiseFirst, { preferType: "array" });
  assert.ok(payload);
  assert.deepEqual(payload.value, [{ results: [] }]);
});

ok("d1Rows throws loudly (raw snippet) on unparseable output", () => {
  let threw = null;
  try {
    d1Rows("total garbage, no json here", "fixture garbage");
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "expected a throw");
  assert.match(threw.message, /could not extract JSON/);
  assert.match(threw.message, /total garbage/);
});

ok("d1Rows tags a transport-looking CLI failure as transport", () => {
  let threw = null;
  try {
    d1Rows("Error: Network connection lost.\n    at async Object.fetch", "fixture transport");
  } catch (e) {
    threw = e;
  }
  assert.ok(threw);
  assert.equal(isTransportError(threw), true);
});

ok("transport vs app 500 bodies classify correctly (text-first)", () => {
  assert.equal(isTransportText("Error: Network connection lost.\n at entry.worker.js"), true);
  assert.equal(isTransportText("Error: Network connection lost."), true);
  assert.equal(isTransportClassFailure({ status: 500, body: "Error: Network connection lost." }), true);
  assert.equal(isTransportClassFailure({ status: 500, body: '{"error":"app bug"}' }), false);
  assert.equal(isTransportClassFailure({ status: 409, body: "lab completed" }), false);
});

// ---- fetchJsonWithShield: retry only on transport, never on app errors ----
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const transportRes = () => new Response("Error: Network connection lost.\n    at async Object.fetch (entry.worker.js:4733:22)", { status: 500 });

ok("fetchJsonWithShield retries a transport 500 once and parses the retry", async () => {
  let calls = 0;
  const eventsBefore = infraFlake.events, maskedBefore = infraFlake.masked;
  const r = await fetchJsonWithShield(async () => {
    calls += 1;
    return calls === 1 ? transportRes() : jsonRes({ ok: true });
  }, "selftest-transport-retry");
  assert.equal(calls, 2);
  assert.equal(r.parsed, true);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(infraFlake.events, eventsBefore + 1);
  assert.equal(infraFlake.masked, maskedBefore + 1);
});

ok("fetchJsonWithShield does NOT retry an app-class 500", async () => {
  let calls = 0;
  const r = await fetchJsonWithShield(async () => {
    calls += 1;
    return new Response('{"error":"real app bug"}', { status: 500 });
  }, "selftest-app-500");
  assert.equal(calls, 1);
  assert.equal(r.parsed, false);
  assert.equal(r.transport, false);
  assert.equal(r.res.status, 500);
});

ok("fetchJsonWithShield surfaces transport class after a failed retry", async () => {
  const r = await fetchJsonWithShield(async () => transportRes(), "selftest-transport-persist");
  assert.equal(r.parsed, false);
  assert.equal(r.transport, true);
  assert.equal(r.text.includes("Network connection lost"), true);
});

// ---- wsJsonFrame ----
ok("wsJsonFrame passes valid JSON frames", () => {
  assert.deepEqual(wsJsonFrame('{"type":"state","state":{"x":1}}', "selftest-ws"), { type: "state", state: { x: 1 } });
});

ok("wsJsonFrame counts + drops a transport-class frame, never silent", () => {
  const before = infraFlake.wsEvents;
  const out = wsJsonFrame("Error: Network connection lost.", "selftest-ws-transport");
  assert.equal(out, null);
  assert.equal(infraFlake.wsEvents, before + 1);
});

ok("wsJsonFrame throws on a genuine non-JSON protocol frame", () => {
  assert.throws(() => wsJsonFrame("<html>not json</html>", "selftest-ws-garbage"), /protocol defect/);
});

ok("printInfraFlakeSummary prints when events occurred", () => {
  assert.ok(infraFlake.events > 0);
  printInfraFlakeSummary();
});

console.log(failed === 0 ? "\n=== SHIELD SELF-TEST PASSED ===" : `\n=== SHIELD SELF-TEST FAILED (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
