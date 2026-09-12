#!/usr/bin/env node
// Real end-to-end test for the Phase 6 gate, as literally stated in the
// build plan: "a simulated org completes Lab 1, receives nudges, and runs
// a monthly review." Unlike Phases 1/3/5's gates, this one needs no
// physical device, no human judgment, and no service this sandbox can't
// reach — it's genuinely fully verifiable here.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fetchWithShield, printInfraFlakeSummary } from "./lib/infra-flake-shield.mjs";

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;

// [HOLMES-INSTRUMENTATION] tee wrangler dev output so a mid-test 500 leaves
// its server-side story behind (this file previously drained the pipe).
const LOG_PATH = path.join(process.env.HOLMES_LOG_DIR || "/tmp/holmes-gw/evidence", `phase6-${process.pid}.wrangler.log`);
try { mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch { /* exists */ }

const DEV_AUTH_HEADERS = {
  "X-Groundwork-Dev-User": "dev@groundwork.local",
  "X-Groundwork-Dev-Sub": "dev-user-00000000-0000-0000-0000-000000000000",
};

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

async function postJson(path_, body) {
  // [INFRA-FLAKE-SHIELD] ONE loud retry on the exact upstream dev-server
  // transport signature (wrangler ProxyWorker connection drop) — see
  // scripts/lib/infra-flake-shield.mjs. Never retries app errors.
  const attempt = await fetchWithShield(
    () => fetch(`${BASE}${path_}`, {
      method: "POST",
      headers: { ...DEV_AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    `POST ${path_}`,
  );
  if (attempt.err) throw attempt.err;
  const { res, text } = attempt;
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON body (dev 500 page) */ }
  return { res, json, text };
}

async function main() {
  console.log(`Starting wrangler dev on port ${PORT}...`);
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // [HOLMES-INSTRUMENTATION] tee to disk instead of silently draining.
  wrangler.stdout.on("data", (d) => { try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${String(d)}`); } catch { /* ignore */ } });
  wrangler.stderr.on("data", (d) => { try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${String(d)}`); } catch { /* ignore */ } });

  let exitCode = 1;

  try {
    const up = await waitForServer(30_000);
    if (!up) throw new Error("wrangler dev did not become healthy in time");
    console.log("Server up.\n");

    console.log("1. Create org...");
    const { res: orgRes, json: orgJson } = await postJson("/org", { name: "Test Fixture Org", type: "church" });
    if (!orgRes.ok) throw new Error(`FAIL: org creation failed: ${JSON.stringify(orgJson)}`);
    const orgId = orgJson.id;
    console.log(`PASS: org created (${orgId}).`);

    console.log("2. Create leader user...");
    const { res: userRes, json: userJson } = await postJson(`/org/${orgId}/users`, {
      email: "leader@example.org",
      name: "Test Leader",
      role: "leader",
    });
    if (!userRes.ok) throw new Error(`FAIL: user creation failed: ${JSON.stringify(userJson)}`);
    console.log(`PASS: leader user created (${userJson.id}).`);

    console.log("3. Create program...");
    const { res: progRes, json: progJson } = await postJson(`/org/${orgId}/program`, {});
    if (!progRes.ok) throw new Error(`FAIL: program creation failed: ${JSON.stringify(progJson)}`);
    const programId = progJson.id;
    console.log(`PASS: program created (${programId}), current_lab=0.`);

    console.log("4. Attempt to schedule Lab 2 before Lab 1 — must be rejected (phase gate)...");
    const { res: badLabRes, json: badLabJson } = await postJson(`/program/${programId}/lab-session`, {
      labNumber: 2,
      scheduledFor: "2026-08-01T09:00:00Z",
    });
    if (badLabRes.status !== 409) {
      throw new Error(`FAIL: expected 409 scheduling lab 2 out of order, got ${badLabRes.status}: ${JSON.stringify(badLabJson)}`);
    }
    console.log("PASS: out-of-order lab scheduling correctly rejected.");

    console.log("5. Schedule Lab 1...");
    const { res: lab1Res, json: lab1Json } = await postJson(`/program/${programId}/lab-session`, {
      labNumber: 1,
      scheduledFor: "2026-08-01T09:00:00Z",
    });
    if (!lab1Res.ok) throw new Error(`FAIL: lab 1 scheduling failed: ${JSON.stringify(lab1Json)}`);
    const lab1Id = lab1Json.id;
    console.log(`PASS: Lab 1 scheduled (${lab1Id}).`);

    console.log("6. Complete Lab 1...");
    const { res: completeRes } = await postJson(`/lab-session/${lab1Id}/complete`, {});
    if (!completeRes.ok) throw new Error(`FAIL: completing lab 1 failed with ${completeRes.status}`);
    const progCheckRes = await fetch(`${BASE}/program/${programId}`, { headers: DEV_AUTH_HEADERS });
    const progState = await progCheckRes.json();
    if (progState.current_lab !== 1 || progState.status !== "in_progress") {
      throw new Error(`FAIL: expected program.current_lab=1, status=in_progress after Lab 1, got ${JSON.stringify(progState)}`);
    }
    console.log(`PASS: program advanced to current_lab=1 after completing Lab 1. Program now unlocks Lab 2.`);

    console.log("7. Create an initiative with an overdue step...");
    const { res: initRes, json: initJson } = await postJson(`/program/${programId}/initiative`, {
      title: "Rebuild volunteer pipeline",
      whyNow: "Sign-ups fell 35% this quarter.",
    });
    if (!initRes.ok) throw new Error(`FAIL: initiative creation failed: ${JSON.stringify(initJson)}`);
    const initiativeId = initJson.id;
    const pastDue = new Date(Date.now() - 5 * 86_400_000).toISOString(); // 5 days ago
    const { res: stepRes, json: stepJson } = await postJson(`/initiative/${initiativeId}/step`, {
      description: "Contact the 12 volunteers who lapsed since March",
      dueDate: pastDue,
    });
    if (!stepRes.ok) throw new Error(`FAIL: step creation failed: ${JSON.stringify(stepJson)}`);
    console.log(`PASS: initiative + overdue step created (due ${pastDue}).`);

    console.log("8. Confirm the step shows up as overdue...");
    const overdueRes = await fetch(`${BASE}/program/${programId}/overdue-steps`, { headers: DEV_AUTH_HEADERS });
    const overdueJson = await overdueRes.json();
    if (overdueJson.steps.length !== 1) {
      throw new Error(`FAIL: expected 1 overdue step, got ${overdueJson.steps.length}`);
    }
    console.log("PASS: overdue-step detection correct.");

    console.log("9. COACH generates a nudge for the overdue step...");
    const { res: nudgeRes, json: nudgeJson } = await postJson(`/program/${programId}/coach/nudges`, {});
    if (!nudgeRes.ok) throw new Error(`FAIL: nudge generation failed: ${JSON.stringify(nudgeJson)}`);
    if (nudgeJson.nudges.length !== 1) {
      throw new Error(`FAIL: expected 1 nudge, got ${nudgeJson.nudges.length}`);
    }
    console.log(`PASS: COACH generated a nudge (personalized=${nudgeJson.personalized} — ${nudgeJson.personalized ? "real Anthropic call" : "template fallback, no key"}):`);
    console.log(`  "${nudgeJson.nudges[0].message}"`);

    console.log("10. Run a monthly review cycle...");
    const { res: reviewRes, json: reviewJson } = await postJson(`/program/${programId}/review-cycle`, {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });
    if (!reviewRes.ok) throw new Error(`FAIL: review cycle creation failed: ${JSON.stringify(reviewJson)}`);
    const reviewId = reviewJson.id;

    const { res: completeReviewRes, json: completeReviewJson } = await postJson(`/review-cycle/${reviewId}/complete`, {
      programId,
    });
    if (!completeReviewRes.ok) throw new Error(`FAIL: review cycle completion failed: ${JSON.stringify(completeReviewJson)}`);
    if (completeReviewJson.snapshot.overdueStepCount !== 1) {
      throw new Error(`FAIL: expected health snapshot overdueStepCount=1, got ${JSON.stringify(completeReviewJson.snapshot)}`);
    }
    console.log(`PASS: monthly review completed with a real, computed health snapshot: ${JSON.stringify(completeReviewJson.snapshot)}`);

    console.log("\n=== Phase 6 gate satisfied: simulated org completed Lab 1, received a nudge, and ran a monthly review. ===");
    exitCode = 0;
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
    printInfraFlakeSummary();
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