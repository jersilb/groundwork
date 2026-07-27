#!/usr/bin/env node --experimental-strip-types
// Deterministic test for SYNTHESIZER's provenance verification — the part
// that makes "provenance is a feature, not debug tooling" real rather than
// aspirational. Uses a fixed fake LLM client so this doesn't need a live
// API key or cost tokens; it's testing our own verification logic, not
// model quality.
import assert from "node:assert/strict";
import { runSynthesizer, ProvenanceVerificationError } from "../src/guide-engine/synthesizer.ts";
import { FixedFakeLlmClient } from "../src/guide-engine/testing/fake-llm-client.ts";
import type { SegmentSpec } from "../src/guide-engine/segment-schema.ts";

const segment: SegmentSpec = {
  key: "_test_synth_segment",
  lab: 1,
  title: "Test segment",
  planned_minutes: 20,
  input_mode: "phone_submit_then_discuss",
  objective: "Synthetic objective for provenance tests.",
  rubric: [{ id: "specificity", check: "placeholder" }],
  exit_criteria: ["min_submissions_met"],
  produces: [{ artifact: "current_reality_map" }],
  fallback_if_stuck: [],
};

const submissions = [
  "Attendance dropped 22% over the last year, mostly in the 18-34 age group.",
  "The facility roof needs an estimated $80,000 in repairs within 18 months.",
];

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

await check("accepts an artifact whose provenance quote is a real verbatim substring", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      artifacts: [
        {
          kind: "risk",
          content: "The facility's roof is a near-term financial risk.",
          provenance: [{ type: "submission", index: 1, quote: "$80,000 in repairs within 18 months" }],
        },
      ],
    }),
  );
  const result = await runSynthesizer({ segment, submissions }, llm);
  assert.equal(result.artifacts.length, 1);
});

await check("REJECTS an artifact whose provenance quote is fabricated (not a real substring)", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      artifacts: [
        {
          kind: "risk",
          content: "Volunteer burnout is a major concern.",
          // This quote does not appear anywhere in the actual submissions —
          // a plausible-sounding fabrication is exactly the failure mode
          // provenance verification exists to catch.
          provenance: [{ type: "submission", index: 0, quote: "volunteers are burning out fast" }],
        },
      ],
    }),
  );
  await assert.rejects(() => runSynthesizer({ segment, submissions }, llm), ProvenanceVerificationError);
});

await check("REJECTS a provenance reference with an out-of-range submission index", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      artifacts: [
        {
          kind: "driver",
          content: "Something.",
          provenance: [{ type: "submission", index: 99, quote: "anything" }],
        },
      ],
    }),
  );
  await assert.rejects(() => runSynthesizer({ segment, submissions }, llm), ProvenanceVerificationError);
});

await check("REJECTS a transcript quote that doesn't appear in the transcript window", async () => {
  const llm = new FixedFakeLlmClient(
    JSON.stringify({
      artifacts: [
        {
          kind: "assumption",
          content: "The team assumes growth will resume.",
          provenance: [{ type: "transcript", index: 0, quote: "we all agree things will turn around" }],
        },
      ],
    }),
  );
  await assert.rejects(
    () => runSynthesizer({ segment, submissions, transcriptWindow: "Someone mentioned optimism about next year." }, llm),
    ProvenanceVerificationError,
  );
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("SYNTHESIZER PROVENANCE TESTS FAILED");
} else {
  console.log("ALL SYNTHESIZER PROVENANCE TESTS PASSED");
}
