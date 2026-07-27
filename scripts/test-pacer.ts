#!/usr/bin/env node --experimental-strip-types
// Pure logic tests for PACER's deterministic path — no LLM, no network.
import assert from "node:assert/strict";
import { decidePacerAction, type PacerInput } from "../src/guide-engine/pacer.ts";
import type { SegmentSpec } from "../src/guide-engine/segment-schema.ts";

const segment: SegmentSpec = {
  key: "_test_pacer_segment",
  lab: 1,
  title: "Test segment for PACER",
  planned_minutes: 10,
  input_mode: "phone_submit_then_discuss",
  min_submissions: 5,
  objective: "Synthetic objective for PACER unit tests.",
  rubric: [{ id: "specificity", check: "placeholder" }],
  exit_criteria: ["min_submissions_met"],
  produces: [{ artifact: "_test_artifact" }],
  fallback_if_stuck: [],
};

function baseInput(overrides: Partial<PacerInput>): PacerInput {
  return {
    segment,
    elapsedSegmentMin: 0,
    remainingSessionBudgetMin: 60,
    submissionCount: 0,
    exitCriteriaStatus: { min_submissions_met: false },
    ...overrides,
  };
}

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

check("early in segment, criteria pending -> continue", () => {
  const d = decidePacerAction(baseInput({ elapsedSegmentMin: 2 }));
  assert.equal(d.action, "continue");
});

check("80%+ of planned time, criteria pending -> warn with message", () => {
  const d = decidePacerAction(baseInput({ elapsedSegmentMin: 9, submissionCount: 2 }));
  assert.equal(d.action, "warn");
  assert.ok(d.message_to_room?.includes("2/5"));
});

check("over time, session has slack -> extend, not compress", () => {
  const d = decidePacerAction(baseInput({ elapsedSegmentMin: 11, remainingSessionBudgetMin: 50 }));
  assert.equal(d.action, "extend");
});

check("over time, session budget tight -> compress", () => {
  const d = decidePacerAction(baseInput({ elapsedSegmentMin: 11, remainingSessionBudgetMin: 5 }));
  assert.equal(d.action, "compress");
});

check("major overrun, budget tight -> advance regardless of exit criteria", () => {
  const d = decidePacerAction(baseInput({ elapsedSegmentMin: 14, remainingSessionBudgetMin: 5 }));
  assert.equal(d.action, "advance");
});

check("exit criteria met -> advance immediately, even if early", () => {
  const d = decidePacerAction(
    baseInput({ elapsedSegmentMin: 3, exitCriteriaStatus: { min_submissions_met: true } }),
  );
  assert.equal(d.action, "advance");
  assert.equal(d.rationale, "exit criteria satisfied");
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("PACER TESTS FAILED");
} else {
  console.log("ALL PACER TESTS PASSED");
}
