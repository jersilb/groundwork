#!/usr/bin/env node --experimental-strip-types
// Guide runtime tests — the orchestration layer that turns PACER,
// EVALUATOR/PROBER, and SYNTHESIZER into a live facilitator inside the
// SessionDO. All LLM-backed behavior runs against fake clients (parsing
// and orchestration are the contract here; model judgment is the eval
// harness's job). No network, no API key.
import assert from "node:assert/strict";
import {
  appendGuideMessage,
  computeExitCriteria,
  defaultSpecFor,
  evaluateAndMaybeProbe,
  runPacerTick,
  synthesizeSegment,
} from "../src/guide-engine/session-guide.ts";
import { parseSegmentSpec } from "../src/guide-engine/segment-schema.ts";
import { HeuristicFakeLlmClient } from "../src/guide-engine/testing/fake-llm-client.ts";
import type { SegmentDef } from "../src/session-protocol.ts";

const FAKE_SEGMENT: SegmentDef = { key: "warmup", title: "Warm-up question", plannedMinutes: 10 };

let passed = 0;
function check(label: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS: ${label}`);
      passed += 1;
    })
    .catch((err) => {
      console.error(`FAIL: ${label}`);
      console.error(err);
      process.exitCode = 1;
    });
}

await check("defaultSpecFor produces a schema-valid SegmentSpec", () => {
  const spec = defaultSpecFor(FAKE_SEGMENT);
  // The real parser must accept what the guide feeds EVALUATOR/SYNTHESIZER.
  assert.deepEqual(parseSegmentSpec(spec), spec);
  assert.ok(spec.rubric.some((r) => r.id === "specific"));
  assert.ok(spec.rubric.some((r) => r.id === "honest"));
  assert.ok(spec.rubric.some((r) => r.id === "relevant"));
});

await check("computeExitCriteria reflects the submission floor only", () => {
  const spec = defaultSpecFor(FAKE_SEGMENT);
  assert.deepEqual(computeExitCriteria(spec, 1), { min_submissions_met: false });
  assert.deepEqual(computeExitCriteria(spec, 2), { min_submissions_met: true });
});

await check("appendGuideMessage caps the log", () => {
  let log = appendGuideMessage(undefined, { id: "a", kind: "pacer", text: "1", segmentKey: "s", createdAt: "x" });
  for (let i = 0; i < 40; i++) {
    log = appendGuideMessage(log, { id: "m" + i, kind: "probe", text: "t", segmentKey: "s", createdAt: "x" });
  }
  assert.equal(log.length, 25);
  assert.equal(log[log.length - 1].id, "m39");
});

await check("pacer tick: deterministic warn without an LLM", async () => {
  const spec = defaultSpecFor(FAKE_SEGMENT);
  // submissionCount below the spec's min_submissions floor keeps exit
  // criteria unmet — otherwise PACER would correctly advance instead.
  const { message, action } = await runPacerTick(
    { segment: FAKE_SEGMENT, elapsedSegmentMin: 9.5, remainingSessionBudgetMin: 40, submissionCount: 1, submissions: [], sessionId: "s" },
    spec,
    null,
  );
  assert.equal(action, "warn");
  assert.ok(message?.kind === "pacer");
});

await check("pacer tick stays silent when the action repeats (no nagging)", async () => {
  const spec = defaultSpecFor(FAKE_SEGMENT);
  const ctx = { segment: FAKE_SEGMENT, elapsedSegmentMin: 9.5, remainingSessionBudgetMin: 40, submissionCount: 1, submissions: [], sessionId: "s" };
  const first = await runPacerTick(ctx, spec, null);
  const second = await runPacerTick(ctx, spec, null, first.action);
  assert.equal(second.message, null);
});

// A single fake client that answers according to which agent is asking —
// EVALUATOR (verdict JSON) vs PROBER (probe JSON) vs SYNTHESIZER.
const guideLlm = new HeuristicFakeLlmClient((params) => {
  if (params.system.includes("EVALUATOR")) {
    return JSON.stringify({
      verdict: "thin",
      per_criterion_scores: params.system.includes("EVALUATOR")
        ? [{ id: "specific", score: 0.2, note: "answers stay generic" }, { id: "honest", score: 0.5, note: "candid" }, { id: "relevant", score: 0.9, note: "on topic" }]
        : [],
      weakest_criterion: "specific",
      evidence: "Submissions say 'communicate better' without any mechanism.",
    });
  }
  if (params.system.includes("PROBER")) {
    // The probe must be shaped by the user content (which carries the
    // submissions), so assert on that by echoing a marker.
    const named = params.messages[0].content.includes("the parking lot floods every Sunday");
    return JSON.stringify({
      probe: named
        ? "You mentioned the parking lot floods every Sunday — what would fixing that cost, and who decides?"
        : "generic probe (should not happen)",
      reason: "names the specific pain the room raised",
    });
  }
  throw new Error("unexpected agent prompt in this test");
});

await check("thin verdict triggers a PROBER probe naming room specifics", async () => {
  const spec = defaultSpecFor(FAKE_SEGMENT);
  const ctx = {
    segment: FAKE_SEGMENT,
    elapsedSegmentMin: 2,
    remainingSessionBudgetMin: 40,
    submissionCount: 3,
    submissions: ["I think the parking lot floods every Sunday and it's embarrassing.", "We could communicate better."],
    sessionId: "s",
  };
  const { message, output } = await evaluateAndMaybeProbe(ctx, spec, guideLlm);
  assert.equal(output?.verdict, "thin");
  assert.ok(message?.kind === "probe");
  assert.ok(message.text.includes("parking lot floods"), "probe must name the specific submission");
});

await check("on_track verdict produces no message (no interruption)", async () => {
  const onTrackLlm = new HeuristicFakeLlmClient((params) => {
    assert.ok(params.system.includes("EVALUATOR"));
    return JSON.stringify({
      verdict: "on_track",
      per_criterion_scores: [
        { id: "specific", score: 0.9, note: "names real programs" },
        { id: "honest", score: 0.8, note: "candid" },
        { id: "relevant", score: 1, note: "on topic" },
      ],
      weakest_criterion: "honest",
      evidence: "Submissions name specific dates and costs.",
    });
  });
  const spec = defaultSpecFor(FAKE_SEGMENT);
  const { message } = await evaluateAndMaybeProbe(
    { segment: FAKE_SEGMENT, elapsedSegmentMin: 2, remainingSessionBudgetMin: 40, submissionCount: 3, submissions: ["Specific input with dates and costs."], sessionId: "s" },
    spec,
    onTrackLlm,
  );
  assert.equal(message, null);
});

await check("synthesis persists verified artifacts and reports the count", async () => {
  const synthLlm = new HeuristicFakeLlmClient(() =>
    JSON.stringify({
      artifacts: [
        {
          kind: "risk",
          content: "The Sunday parking lot floods and the congregation notices.",
          provenance: [{ type: "submission", index: 0, quote: "parking lot floods every Sunday" }],
        },
      ],
    }),
  );
  const saved: string[] = [];
  const { message, artifactCount } = await synthesizeSegment(
    { segment: FAKE_SEGMENT, elapsedSegmentMin: 11, remainingSessionBudgetMin: 40, submissionCount: 1, submissions: ["The parking lot floods every Sunday."], sessionId: "sess-1" },
    defaultSpecFor(FAKE_SEGMENT),
    synthLlm,
    async (artifacts) => {
      for (const a of artifacts) saved.push(a.kind);
    },
  );
  assert.equal(artifactCount, 1);
  assert.deepEqual(saved, ["risk"]);
  assert.ok(message.kind === "synthesis");
  assert.ok(message.text.includes("1 item"));
});

await check("synthesis with fabricated provenance throws (hard failure, not a warning)", async () => {
  const lyingLlm = new HeuristicFakeLlmClient(() =>
    JSON.stringify({
      artifacts: [
        {
          kind: "vision",
          content: "Something the room never said.",
          provenance: [{ type: "submission", index: 0, quote: "quote that appears nowhere in the input" }],
        },
      ],
    }),
  );
  await assert.rejects(
    synthesizeSegment(
      { segment: FAKE_SEGMENT, elapsedSegmentMin: 11, remainingSessionBudgetMin: 40, submissionCount: 1, submissions: ["The parking lot floods every Sunday."], sessionId: "sess-1" },
      defaultSpecFor(FAKE_SEGMENT),
      lyingLlm,
      async () => assert.fail("must not persist unverified artifacts"),
    ),
  );
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("GUIDE RUNTIME TESTS FAILED");
} else {
  console.log("ALL GUIDE RUNTIME TESTS PASSED");
}
