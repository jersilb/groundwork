#!/usr/bin/env node --experimental-strip-types
// Parsing/validation robustness tests for EVALUATOR and PROBER, using a
// fixed fake LLM client. Proves the software is correct — schema
// validation, error handling, cross-referencing weakest_criterion against
// the real rubric. Does NOT measure real model judgment quality; that
// requires a live Anthropic key (docs/capability-gaps.md, 2026-07-27).
import assert from "node:assert/strict";
import { runEvaluator, EvaluatorParseError } from "../src/guide-engine/evaluator.ts";
import { runProber, ProberParseError } from "../src/guide-engine/prober.ts";
import { FixedFakeLlmClient } from "../src/guide-engine/testing/fake-llm-client.ts";
import type { SegmentSpec } from "../src/guide-engine/segment-schema.ts";

const segment: SegmentSpec = {
  key: "_test_segment",
  lab: 1,
  title: "Test segment",
  planned_minutes: 10,
  input_mode: "phone_submit_then_discuss",
  objective: "Synthetic objective for parsing tests.",
  rubric: [
    { id: "specificity", check: "placeholder check A" },
    { id: "evidence", check: "placeholder check B" },
  ],
  exit_criteria: ["min_submissions_met"],
  produces: [{ artifact: "_test_artifact" }],
  fallback_if_stuck: [],
};

let passed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS: ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

await check("EVALUATOR accepts well-formed JSON matching the schema", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      verdict: "thin",
      per_criterion_scores: [
        { id: "specificity", score: 0.3, note: "vague" },
        { id: "evidence", score: 0.2, note: "no numbers" },
      ],
      weakest_criterion: "evidence",
      evidence: "No submission names a measurable fact.",
    }),
  );
  const result = await runEvaluator({ segment, submissions: ["things are fine"] }, llm);
  assert.equal(result.verdict, "thin");
  assert.equal(result.weakest_criterion, "evidence");
});

await check("EVALUATOR rejects non-JSON output", async () => {
  const llm = new FixedFakeLlmClient("this is not json");
  await assert.rejects(() => runEvaluator({ segment, submissions: [] }, llm), EvaluatorParseError);
});

await check("EVALUATOR rejects JSON missing required fields", async () => {
  const llm = new FixedFakeLlmClient(JSON.stringify({ verdict: "on_track" }));
  await assert.rejects(() => runEvaluator({ segment, submissions: [] }, llm), EvaluatorParseError);
});

await check("EVALUATOR rejects an invalid verdict enum value", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      verdict: "sort_of_fine", // not a valid EvaluatorVerdict
      per_criterion_scores: [],
      weakest_criterion: "specificity",
      evidence: "n/a",
    }),
  );
  await assert.rejects(() => runEvaluator({ segment, submissions: [] }, llm), EvaluatorParseError);
});

await check("EVALUATOR rejects weakest_criterion not present in this segment's rubric", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      verdict: "thin",
      per_criterion_scores: [],
      weakest_criterion: "made_up_criterion_id",
      evidence: "n/a",
    }),
  );
  await assert.rejects(() => runEvaluator({ segment, submissions: [] }, llm), EvaluatorParseError);
});

await check("PROBER accepts well-formed JSON", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      probe: "Two of you mentioned declining volunteer counts — which teams specifically?",
      reason: "grounds the follow-up in what was actually submitted",
    }),
  );
  const evaluatorOutput = {
    verdict: "thin" as const,
    per_criterion_scores: [],
    weakest_criterion: "evidence",
    evidence: "vague",
  };
  const result = await runProber({ segment, evaluatorOutput, submissions: ["volunteers are down"] }, llm);
  assert.ok(result.probe.length > 0);
});

await check("PROBER rejects malformed JSON", async () => {
  const llm = new FixedFakeLlmClient("{not valid json");
  const evaluatorOutput = {
    verdict: "thin" as const,
    per_criterion_scores: [],
    weakest_criterion: "evidence",
    evidence: "vague",
  };
  await assert.rejects(() => runProber({ segment, evaluatorOutput, submissions: [] }, llm), ProberParseError);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("EVALUATOR/PROBER PARSING TESTS FAILED");
} else {
  console.log("ALL EVALUATOR/PROBER PARSING TESTS PASSED");
}
