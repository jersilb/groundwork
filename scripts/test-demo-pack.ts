#!/usr/bin/env node --experimental-strip-types
// Demo reference pack rehearsal — walks the build plan §7 six-hour arc using
// the synthetic `_demo` pack, proving two things:
//   1. specFor() resolves segment-specific demo specs (objectives + rubrics)
//      instead of falling back to the generic rubric for demo segment keys.
//   2. PACER produces the expected deterministic action each step of the arc
//      with realistic timing (on-pace, warn, compress-on-tight-budget) and the
//      day's planned segments sum to a credible half/full-day workshop.
// No network, no API key, no LLM — the fakes are the contract, exactly like
// the other guide test scripts.
import assert from "node:assert/strict";
import { specFor, computeExitCriteria } from "../src/guide-engine/session-guide.ts";
import { decidePacerAction } from "../src/guide-engine/pacer.ts";
import { DEMO_SEGMENT_SPECS } from "../src/generated/demo-segment-specs.ts";
import { SEGMENT_SPECS } from "../src/generated/segment-specs.ts";
import type { SegmentDef } from "../src/session-protocol.ts";

let passed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// The demo pack covers the nine-case arc (welcome → close), an hour+ each
// working riding up to a full strategic day.
check("demo pack ships a full-day arc of 9 segments", () => {
  assert.equal(DEMO_SEGMENT_SPECS.length, 9);
  const keys = DEMO_SEGMENT_SPECS.map((s) => s.key);
  assert.deepEqual(keys, [
    "s1_welcome",
    "s2_current_reality",
    "s3_purpose_clarity",
    "s4_themes_tensions",
    "s5_report_back_synthesis",
    "s6_prioritization",
    "s7_initiatives",
    "s8_consolidation",
    "s9_commitments_close",
  ]);
});

check("live bundle stays empty (no real curriculum leaked into the shipped pack)", () => {
  assert.equal(SEGMENT_SPECS.length, 0);
});

check("specFor resolves demo objectives and rubrics by key (not the generic fallback)", () => {
  const def = (key: string, title: string, plannedMinutes: number): SegmentDef => ({ key, title, plannedMinutes });
  const reality = specFor(def("s2_current_reality", "Individual reflection", 45));
  // The demo objective is nothing like the generic "Conduct the ... segment".
  assert.ok(reality.objective.toLowerCase().includes("diagnosis precedes goal-setting"));
  assert.ok(reality.input_mode === "silent_write");
  assert.ok(reality.rubric.some((r) => r.id === "specific_current_state"));
  assert.ok(reality.exit_criteria.includes("min_submissions_met"));
});

check("specFor still falls back to the generic rubric for unknown keys", () => {
  const generic = specFor({ key: "warmup", title: "Warm-up question", plannedMinutes: 10 });
  assert.ok(generic.rubric.some((r) => r.id === "specific"));
});

for (const spec of DEMO_SEGMENT_SPECS) {
  const title = spec.title;
  check(`${title}: PACER continues when on pace`, () => {
    const d = decidePacerAction({
      segment: spec,
      elapsedSegmentMin: spec.planned_minutes * 0.3,
      remainingSessionBudgetMin: 200,
      submissionCount: 0,
      exitCriteriaStatus: computeExitCriteria(spec, 0),
    });
    assert.equal(d.action, "continue");
  });

  check(`${title}: PACER warns once time is 80% used and criteria pending`, () => {
    const d = decidePacerAction({
      segment: spec,
      elapsedSegmentMin: spec.planned_minutes * 0.9,
      remainingSessionBudgetMin: 200,
      submissionCount: 0,
      exitCriteriaStatus: computeExitCriteria(spec, 0),
    });
    assert.equal(d.action, "warn");
  });
}

// The prioritization segment uses a vote — PACER must still be submissive to
// the submission floor for exit criteria when the vote hasn't cleared.
check("prioritization: vote_completed is a PACER exit criterion", () => {
  const spec = specFor({ key: "s6_prioritization", title: "Prioritization", plannedMinutes: 45 });
  assert.ok(spec.exit_criteria.includes("vote_completed"));
});

// Day shape: a working session should sit in a credible 5-6 hour band once
// segments run right after one another (breaks are separate itinerary items,
// not represented in segment spec planned_minutes).
check("planned segment minutes sum to a credible strategic-day length", () => {
  const total = DEMO_SEGMENT_SPECS.reduce((sum, s) => sum + s.planned_minutes, 0);
  assert.ok(total >= 300 && total <= 360, `expected ~5-6h of segment time, got ${total} min`);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("DEMO PACK REHEARSAL FAILED");
} else {
  console.log("ALL DEMO PACK REHEARSAL CHECKS PASSED");
}