#!/usr/bin/env node --experimental-strip-types
// Prompt-budget tests (guide-hardening wave 1, bug #3). Before the budget
// layer existed, a room could push 100 x 2,000-char submissions plus an
// unbounded transcript into a single guide-engine request — measured
// pre-fix at 438,801 chars for EVALUATOR. These checks pin the ceilings,
// the deterministic truncation (newest kept, explicit marker), the
// byte-identical pass-through for normal input, and determinism. Pure
// functions and a fake env; no network, no API key.
import assert from "node:assert/strict";
import {
  MAX_PROMPT_SUBMISSIONS,
  MAX_PROMPT_TRANSCRIPT_CHARS,
  MAX_PROMPT_USER_CONTENT_CHARS,
  MAX_SUBMISSION_CHARS,
  MAX_SUBMISSIONS_PER_SEGMENT,
  PROMPT_TRUNCATION_MARKER,
} from "../src/session-protocol.ts";
import { buildEvaluatorUserContent } from "../src/guide-engine/evaluator.ts";
import { buildProberUserContent } from "../src/guide-engine/prober.ts";
import { buildUserContent } from "../src/guide-engine/synthesizer.ts";
import { getRollingTranscriptWindow } from "../src/audio/transcript-window.ts";
import type { Env } from "../src/index.ts";
import type { SegmentSpec } from "../src/guide-engine/segment-schema.ts";

const segment: SegmentSpec = {
  key: "_test_budget_segment",
  lab: 1,
  title: "Budget test segment",
  planned_minutes: 10,
  input_mode: "phone_submit_then_discuss",
  objective: "Objective for the budget test.",
  rubric: [
    { id: "specificity", check: "names real mechanisms" },
    { id: "evidence", check: "cites numbers" },
  ],
  exit_criteria: ["min_submissions_met"],
  produces: [{ artifact: "_test_artifact" }],
  fallback_if_stuck: [],
};

const evaluatorOutput = {
  verdict: "thin" as const,
  per_criterion_scores: [],
  weakest_criterion: "evidence",
  evidence: "vague",
};

const normalSubmissions = [
  "Attendance fell 22% in the 18-34 group.",
  "The roof needs $80,000 within 18 months.",
];
const normalTranscript = "We discussed both numbers and agreed to revisit them.";

// Captured verbatim from the pre-budget-layer builders (fixed input:
// `segment`, `normalSubmissions`, `normalTranscript` as defined above).
// These are the byte-identity fixtures for check (c).
const EVALUATOR_NORMAL_EXPECTED =
  "Segment objective: Objective for the budget test.\n\nRubric (JSON, authoritative for this segment only):\n\n[\n  {\n    \"id\": \"specificity\",\n    \"check\": \"names real mechanisms\"\n  },\n  {\n    \"id\": \"evidence\",\n    \"check\": \"cites numbers\"\n  }\n]\n\nSubmissions (2):\n\n1. Attendance fell 22% in the 18-34 group.\n2. The roof needs $80,000 within 18 months.\n\nDiscussion transcript (current + prior segment):\nWe discussed both numbers and agreed to revisit them.";
const PROBER_NORMAL_EXPECTED =
  "Segment objective: Objective for the budget test.\n\nWeakest rubric criterion: evidence — cites numbers\n\nEvaluator's evidence: vague\n\nWhat the room actually said (2 submissions):\n\n1. Attendance fell 22% in the 18-34 group.\n2. The roof needs $80,000 within 18 months.\n\nWrite one probe question that names something specific from the submissions above.";
const SYNTHESIZER_NORMAL_EXPECTED =
  "Segment objective: Objective for the budget test.\n\nThis segment's curriculum-specific output concept (context only, NOT a valid \"kind\" value): _test_artifact\n\nSubmissions (index: text):\n\n[0] Attendance fell 22% in the 18-34 group.\n[1] The roof needs $80,000 within 18 months.\n\nTranscript window (index 0):\n[0] We discussed both numbers and agreed to revisit them.";
const WINDOW_NORMAL_EXPECTED = "prior words prior more\n\ncurrent words";

/** Deterministic tagged submissions: element i carries an unambiguous
 * `sub-iii-` tag so truncation checks can prove which end survived. */
const taggedSubmissions = (count: number, chars: number): string[] =>
  Array.from({ length: count }, (_, i) => {
    const tag = `sub-${String(i).padStart(3, "0")}-`;
    return tag + "x".repeat(chars - tag.length);
  });

const pathologicalSubmissions = taggedSubmissions(MAX_SUBMISSIONS_PER_SEGMENT, MAX_SUBMISSION_CHARS);
const pathologicalTranscript = "transcript-line ".repeat(14000);

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
const normalWindowEnv = makeAudioEnv({
  prior: [
    { sequence: 1, text: "prior words" },
    { sequence: 2, text: "prior more" },
  ],
  current: [{ sequence: 1, text: "current words" }],
});
const windowChunks = (prefix: string): AudioRow[] =>
  Array.from({ length: 100 }, (_, i) => {
    const tag = `${prefix}-${String(i).padStart(3, "0")}-`;
    return { sequence: i + 1, text: tag + "y".repeat(1190 - tag.length) };
  });
const bigWindowEnv = makeAudioEnv({
  prior: windowChunks("prior"),
  current: windowChunks("cur"),
});

let passed = 0;
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
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

await check("budget constants sit strictly below the protocol worst case", () => {
  assert.equal(MAX_PROMPT_SUBMISSIONS, 12);
  assert.equal(MAX_PROMPT_USER_CONTENT_CHARS, 24000);
  assert.equal(MAX_PROMPT_TRANSCRIPT_CHARS, 12000);
  assert.ok(
    MAX_PROMPT_USER_CONTENT_CHARS < MAX_SUBMISSIONS_PER_SEGMENT * MAX_SUBMISSION_CHARS,
    "the ceiling must be below the uncapped 100 x 2,000 worst case",
  );
});

await check("(a) pathological input: EVALUATOR payload is at or under the ceiling", () => {
  const content = buildEvaluatorUserContent({
    segment,
    submissions: pathologicalSubmissions,
    transcriptWindow: pathologicalTranscript,
  });
  assert.ok(
    content.length <= MAX_PROMPT_USER_CONTENT_CHARS,
    `payload ${content.length} chars exceeds ceiling ${MAX_PROMPT_USER_CONTENT_CHARS}`,
  );
});

await check("(a) pathological input: PROBER payload is at or under the ceiling", () => {
  const content = buildProberUserContent({ segment, evaluatorOutput, submissions: pathologicalSubmissions });
  assert.ok(
    content.length <= MAX_PROMPT_USER_CONTENT_CHARS,
    `payload ${content.length} chars exceeds ceiling ${MAX_PROMPT_USER_CONTENT_CHARS}`,
  );
});

await check("(a) pathological input: SYNTHESIZER payload is at or under the ceiling", () => {
  const content = buildUserContent({
    segment,
    submissions: pathologicalSubmissions,
    transcriptWindow: pathologicalTranscript,
  });
  assert.ok(
    content.length <= MAX_PROMPT_USER_CONTENT_CHARS,
    `payload ${content.length} chars exceeds ceiling ${MAX_PROMPT_USER_CONTENT_CHARS}`,
  );
});

await check("(b) EVALUATOR truncation keeps the newest submissions and emits the marker", () => {
  const content = buildEvaluatorUserContent({
    segment,
    submissions: pathologicalSubmissions,
    transcriptWindow: pathologicalTranscript,
  });
  assert.ok(content.includes(PROMPT_TRUNCATION_MARKER), "truncation marker missing");
  assert.ok(content.includes("sub-099-"), "newest submission was dropped");
  assert.ok(!content.includes("sub-000-"), "oldest submission must be elided");
});

await check("(b) PROBER truncation keeps the newest submissions and emits the marker", () => {
  const content = buildProberUserContent({ segment, evaluatorOutput, submissions: pathologicalSubmissions });
  assert.ok(content.includes(PROMPT_TRUNCATION_MARKER), "truncation marker missing");
  assert.ok(content.includes("sub-099-"), "newest submission was dropped");
  assert.ok(!content.includes("sub-000-"), "oldest submission must be elided");
});

await check("(b) SYNTHESIZER truncation keeps the newest submissions, marker, and original indices", () => {
  const content = buildUserContent({
    segment,
    submissions: pathologicalSubmissions,
    transcriptWindow: pathologicalTranscript,
  });
  assert.ok(content.includes(PROMPT_TRUNCATION_MARKER), "truncation marker missing");
  assert.ok(content.includes("sub-099-"), "newest submission was dropped");
  assert.ok(!content.includes("sub-000-"), "oldest submission must be elided");
  // Provenance indices must still address the full input array, so the
  // newest kept submission renders under its original index.
  assert.ok(content.includes("[99] sub-099-"), "original submission index was not preserved");
});

await check("(b) submission count cap keeps the newest and marks the elision", () => {
  const manyShort = taggedSubmissions(MAX_SUBMISSIONS_PER_SEGMENT, 40);
  const content = buildEvaluatorUserContent({ segment, submissions: manyShort });
  assert.ok(content.includes(PROMPT_TRUNCATION_MARKER), "truncation marker missing");
  assert.ok(content.includes("sub-099-"), "newest submission was dropped");
  assert.ok(!content.includes("sub-000-"), "oldest submission must be elided");
  assert.ok(!content.includes("sub-087-"), "only the newest 12 submissions should survive");
});

await check("(b) transcript window truncation keeps the newest text and emits the marker", async () => {
  const content = await getRollingTranscriptWindow(bigWindowEnv, "sess", "current", "prior");
  assert.ok(
    content.length <= MAX_PROMPT_TRANSCRIPT_CHARS,
    `window ${content.length} chars exceeds cap ${MAX_PROMPT_TRANSCRIPT_CHARS}`,
  );
  assert.ok(content.includes(PROMPT_TRUNCATION_MARKER), "truncation marker missing");
  assert.ok(content.includes("cur-099-"), "newest transcript text was dropped");
  assert.ok(!content.includes("prior-000-"), "oldest transcript text must be elided");
});

await check("(c) regular input passes through byte-identical: EVALUATOR", () => {
  const content = buildEvaluatorUserContent({
    segment,
    submissions: normalSubmissions,
    transcriptWindow: normalTranscript,
  });
  assert.equal(content, EVALUATOR_NORMAL_EXPECTED);
});

await check("(c) regular input passes through byte-identical: PROBER", () => {
  const content = buildProberUserContent({ segment, evaluatorOutput, submissions: normalSubmissions });
  assert.equal(content, PROBER_NORMAL_EXPECTED);
});

await check("(c) regular input passes through byte-identical: SYNTHESIZER", () => {
  const content = buildUserContent({
    segment,
    submissions: normalSubmissions,
    transcriptWindow: normalTranscript,
  });
  assert.equal(content, SYNTHESIZER_NORMAL_EXPECTED);
});

await check("(c) small transcript windows pass through byte-identical", async () => {
  const content = await getRollingTranscriptWindow(normalWindowEnv, "sess", "current", "prior");
  assert.equal(content, WINDOW_NORMAL_EXPECTED);
});

await check("(c) empty input still renders the (none) submission placeholder", () => {
  const content = buildEvaluatorUserContent({ segment, submissions: [] });
  assert.ok(content.includes("Submissions (0):\n\n(none)"), "empty-submissions placeholder changed");
});

await check("(d) determinism: same pathological input twice, identical payloads", async () => {
  assert.equal(
    buildEvaluatorUserContent({ segment, submissions: pathologicalSubmissions, transcriptWindow: pathologicalTranscript }),
    buildEvaluatorUserContent({ segment, submissions: pathologicalSubmissions, transcriptWindow: pathologicalTranscript }),
  );
  assert.equal(
    buildProberUserContent({ segment, evaluatorOutput, submissions: pathologicalSubmissions }),
    buildProberUserContent({ segment, evaluatorOutput, submissions: pathologicalSubmissions }),
  );
  assert.equal(
    buildUserContent({ segment, submissions: pathologicalSubmissions, transcriptWindow: pathologicalTranscript }),
    buildUserContent({ segment, submissions: pathologicalSubmissions, transcriptWindow: pathologicalTranscript }),
  );
  assert.equal(
    await getRollingTranscriptWindow(bigWindowEnv, "sess", "current", "prior"),
    await getRollingTranscriptWindow(bigWindowEnv, "sess", "current", "prior"),
  );
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("PROMPT BUDGET TESTS FAILED");
} else {
  console.log("ALL PROMPT BUDGET TESTS PASSED");
}
