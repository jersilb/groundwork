#!/usr/bin/env node
// Real end-to-end test for Phase 5: real claude-opus-5, real HTTP routes,
// real D1 artifact versioning, real one-pager assembly.
//
// What this proves: the full pipeline works end-to-end against a live
// model, provenance verification runs against real (not fake) model
// output, and re-synthesizing supersedes the prior artifact correctly.
//
// What this does NOT and cannot prove: the literal Phase 5 gate ("a full
// simulated lab produces a one-page plan requiring fewer than 5 leader
// edits") — "fewer than 5 edits" is a human leader's judgment call, not
// something to fake a verdict for. Logged as a capability gap, same
// category as the Phase 1 physical-device gate: this needs a real person.
import { spawn, execFileSync } from "node:child_process";

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const DEV_AUTH_HEADERS = {
  "X-Groundwork-Dev-User": "dev@groundwork.local",
  "X-Groundwork-Dev-Sub": "dev-user-00000000-0000-0000-0000-000000000000",
};
const SESSION_KEY = `phase5-test-${Date.now()}`;

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

const SEGMENT = {
  key: "current_reality_test",
  lab: 1,
  title: "Current reality (test)",
  planned_minutes: 45,
  input_mode: "phone_submit_then_discuss",
  min_submissions: 3,
  objective: "Surface specific, evidence-based signals about organizational health.",
  rubric: [
    { id: "specificity", check: "Names a concrete observable" },
    { id: "evidence", check: "Points to something measurable" },
  ],
  exit_criteria: ["min_submissions_met"],
  produces: [{ artifact: "current_reality_map" }, { artifact: "risk_register" }],
  fallback_if_stuck: [],
};

const SUBMISSIONS_ROUND_1 = [
  "Attendance dropped from 340 to 265 over the last 12 months, a 22% decline concentrated in the 18-34 age group.",
  "The facility's roof needs an estimated $80,000 in repairs within 18 months per the last inspection.",
  "Two of the five leadership team seats have turned over in the past year.",
];

const SUBMISSIONS_ROUND_2 = [
  ...SUBMISSIONS_ROUND_1,
  "Volunteer sign-ups fell from 48 to 31 this quarter, and exit surveys cite scheduling conflicts as the top reason.",
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("SKIPPED: ANTHROPIC_API_KEY not set in this shell. Source .dev.vars first.");
    process.exit(1);
  }

  console.log(`Starting wrangler dev on port ${PORT}...`);
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  wrangler.stdout.on("data", () => {});
  wrangler.stderr.on("data", () => {});

  let exitCode = 1;

  try {
    const up = await waitForServer(30_000);
    if (!up) throw new Error("wrangler dev did not become healthy in time");
    console.log("Server up.");

    console.log("Round 1: synthesizing from 3 submissions against real claude-opus-5...");
    const res1 = await fetch(`${BASE}/session/${SESSION_KEY}/synthesize`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ segment: SEGMENT, submissions: SUBMISSIONS_ROUND_1 }),
    });
    if (!res1.ok) {
      // Auth gate (src/index.ts) rejects non-GET requests without the dev
      // bypass headers — read the body as text so a 401/422 reports cleanly.
      throw new Error(`FAIL: synthesize round 1 returned ${res1.status}: ${(await res1.text()).slice(0, 300)}`);
    }
    const json1 = await res1.json();
    if (json1.artifacts.length === 0) {
      throw new Error("FAIL: round 1 produced zero artifacts");
    }
    console.log(`PASS: round 1 produced ${json1.artifacts.length} artifact(s), all with server-verified real provenance (fabricated quotes would have been rejected with 422).`);
    for (const a of json1.artifacts) {
      console.log(`  [${a.kind}] ${a.content}`);
    }

    const res1Plan = await fetch(`${BASE}/session/${SESSION_KEY}/plan`, {
      headers: { ...DEV_AUTH_HEADERS },
    });
    if (!res1Plan.ok) {
      throw new Error(`FAIL: GET plan returned ${res1Plan.status}: ${(await res1Plan.text()).slice(0, 300)}`);
    }
    const plan1 = await res1Plan.json();
    const totalItems = plan1.plan.sections.reduce((n, s) => n + s.items.length, 0);
    if (totalItems !== json1.artifacts.length) {
      throw new Error(`FAIL: one-pager has ${totalItems} total items across sections, expected ${json1.artifacts.length}`);
    }
    console.log(`PASS: one-pager assembled with ${plan1.plan.sections.length} section(s), ${totalItems} item(s) total — multiple same-kind artifacts (e.g. two risks) correctly listed together, not overwriting each other.`);
    const firstArtifactId = json1.savedArtifactIds[0];
    const firstArtifactKind = json1.artifacts[0].kind;

    console.log("\nRound 2: re-synthesizing with an additional submission (should supersede, not duplicate)...");
    const res2 = await fetch(`${BASE}/session/${SESSION_KEY}/synthesize`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ segment: SEGMENT, submissions: SUBMISSIONS_ROUND_2 }),
    });
    if (!res2.ok) {
      throw new Error(`FAIL: synthesize round 2 returned ${res2.status}: ${(await res2.text()).slice(0, 300)}`);
    }
    const json2 = await res2.json();
    console.log(`PASS: round 2 produced ${json2.artifacts.length} artifact(s).`);

    exitCode = 0;
    // SINGULAR_KINDS mirrors src/synthesis/plan-artifact-store.ts: an org
    // has exactly one purpose/vision (supersede on re-synthesis), but
    // potentially many risks/drivers/strategies/values/assumptions
    // (additive — each is independent, never "the same artifact" as
    // another of the same kind). Real bug found testing against live
    // Opus, 2026-07-27: a real synthesis pass produced two distinct
    // `risk` artifacts in one round; the original version-by-kind logic
    // would have wrongly superseded one with the other.
    const SINGULAR_KINDS = new Set(["purpose", "vision"]);
    console.log(`\nChecking D1 for versioning correctness on kind="${firstArtifactKind}" (${SINGULAR_KINDS.has(firstArtifactKind) ? "singular — expect supersede" : "plural — expect additive, no supersede"})...`);
    try {
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
          `SELECT id, kind, version, superseded_by FROM session_plan_artifact WHERE session_id = '${SESSION_KEY}' AND kind = '${firstArtifactKind}' ORDER BY version ASC`,
        ],
        { encoding: "utf8" },
      );
      const rows = JSON.parse(out)[0]?.results ?? [];
      console.log(`  Rows for kind="${firstArtifactKind}":`, rows);
      const first = rows.find((r) => r.id === firstArtifactId);
      if (!first) {
        console.error(`FAIL: round-1 artifact ${firstArtifactId} not found in D1 at all.`);
        exitCode = 1;
      } else if (SINGULAR_KINDS.has(firstArtifactKind)) {
        if (!first.superseded_by) {
          console.error("FAIL: singular kind — expected the round-1 artifact to be superseded after round 2.");
          exitCode = 1;
        } else {
          console.log("PASS: singular-kind artifact correctly superseded by round 2's re-synthesis.");
        }
      } else {
        if (first.superseded_by) {
          console.error("FAIL: plural kind — round-1 artifact should NOT be superseded; it's a distinct item, not a prior version.");
          exitCode = 1;
        } else {
          console.log("PASS: plural-kind artifact correctly left untouched — round 2's output is additive, not a replacement.");
        }
      }
    } catch (err) {
      console.error("Could not query D1 for versioning verification:", err.message ?? err);
      exitCode = 1;
    }
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    exitCode = 1;
  } finally {
    try {
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {
      wrangler.kill("SIGKILL");
    }
    await sleep(500);
  }

  process.exit(exitCode);
}

const WATCHDOG_MS = 90_000;
const watchdog = setTimeout(() => {
  console.error(`TEST FAILED: watchdog fired after ${WATCHDOG_MS}ms — something hung.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

main();