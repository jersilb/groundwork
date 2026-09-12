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
import { getRollingTranscriptWindow } from "../src/audio/transcript-window.ts";
import { MAX_PROMPT_TRANSCRIPT_CHARS, PROMPT_TRUNCATION_MARKER } from "../src/session-protocol.ts";
import type { Env } from "../src/index.ts";

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

// A fake audio DB that makes getRollingTranscriptWindow truncate: the joined
// window far exceeds MAX_PROMPT_TRANSCRIPT_CHARS, so capTranscriptWindow
// emits the truncation marker (this is the budget layer's real output — the
// pre-wave suite never coupled truncation to verification, which is exactly
// how the marker-as-provenance hole shipped).
type AudioRow = { sequence: number; text: string | null };
function makeAudioEnv(rowsBySegment: Record<string, AudioRow[]>): Env {
  return {
    DB: {
      prepare: () => ({
        bind: (_sessionId: string, segmentKey: string) => ({
          all: async () => ({ results: rowsBySegment[segmentKey] ?? [] }),
        }),
      }),
    },
  } as unknown as Env;
}
const windowChunks = (prefix: string): AudioRow[] =>
  Array.from({ length: 100 }, (_, i) => {
    const tag = `${prefix}-${String(i).padStart(3, "0")}-`;
    return { sequence: i + 1, text: tag + "y".repeat(1190 - tag.length) };
  });
const bigWindowEnv = makeAudioEnv({ prior: windowChunks("prior"), current: windowChunks("cur") });

await check("a truncated transcript window cannot source-verify the truncation marker (budget ↔ verifier coupling)", async () => {
  const window = await getRollingTranscriptWindow(bigWindowEnv, "sess", "current", "prior");
  assert.ok(window.length <= MAX_PROMPT_TRANSCRIPT_CHARS, "precondition: the window is capped");
  assert.ok(window.includes(PROMPT_TRUNCATION_MARKER), "precondition: the cap emitted the truncation marker");

  // The marker is SYSTEM boilerplate, not room speech. Quoting the whole
  // marker, a phrase from inside it, or a partial fragment must never pass
  // provenance — the reviewer's probe verified an artifact with the marker
  // as its entire cited source.
  for (const quote of [PROMPT_TRUNCATION_MARKER, "older material elided", "[prompt budget: older"]) {
    const llm = new FixedFakeLlmClient(
      JSON.stringify({
        artifacts: [{ kind: "risk", content: "Marker-quoted artifact.", provenance: [{ type: "transcript", index: 0, quote }] }],
      }),
    );
    await assert.rejects(
      () => runSynthesizer({ segment, submissions, transcriptWindow: window }, llm),
      ProvenanceVerificationError,
      `quote "${quote}" must not verify against the truncation marker`,
    );
  }

  // Parity: the same quote against a raw, client-supplied window (the manual
  // POST /session/:id/synthesize route) is rejected too — one artifact, one
  // verification outcome, regardless of caller.
  const manualRouteLlm = new FixedFakeLlmClient(
    JSON.stringify({
      artifacts: [{ kind: "risk", content: "Marker-quoted artifact.", provenance: [{ type: "transcript", index: 0, quote: PROMPT_TRUNCATION_MARKER }] }],
    }),
  );
  await assert.rejects(
    () => runSynthesizer({ segment, submissions, transcriptWindow: "The room talked about the budget." }, manualRouteLlm),
    ProvenanceVerificationError,
    "the marker must not verify when there is no marker at all, either",
  );

  // ...and real speech from the surviving tail still verifies. No
  // false-positive rejection: the fix must not reject a genuine quote.
  const realQuote = "cur-099-";
  assert.ok(window.includes(realQuote), "precondition: the newest tail text survived the cap");
  const okLlm = new FixedFakeLlmClient(
    JSON.stringify({
      artifacts: [{ kind: "risk", content: "Tail-quoted artifact.", provenance: [{ type: "transcript", index: 0, quote: realQuote }] }],
    }),
  );
  const accepted = await runSynthesizer({ segment, submissions, transcriptWindow: window }, okLlm);
  assert.equal(accepted.artifacts.length, 1, "genuine room speech must still verify (no false rejection)");
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("SYNTHESIZER PROVENANCE TESTS FAILED");
} else {
  console.log("ALL SYNTHESIZER PROVENANCE TESTS PASSED");
}
