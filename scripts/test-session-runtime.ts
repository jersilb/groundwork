#!/usr/bin/env node --experimental-strip-types
// Session-runtime gate — the deterministic state machine, clock arithmetic,
// break protections, output audit, event log, and recommendation lifecycle
// (build plan §6 R0/R2 test list). Pure functions only: no network, no LLM,
// no Durable Object. The caller injects `now`, so every check is exact.
import assert from "node:assert/strict";
import { SPINE_REFERENCE_PLAN } from "../src/session-plan.ts";
import {
  applyAction,
  auditOutputs,
  computeClock,
  createRuntimeState,
  cumulativeOverrunMinutes,
  markVoteAnnounced,
  normalizeRuntime,
  spineTick,
  voteQuorumReached,
  type SpineRuntime,
  type TransitionContext,
  enqueueGuideRecommendation,
} from "../src/session-runtime.ts";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${checks} — ${name}`);
}

const MIN = 60_000;
const T0 = 1_700_000_000_000; // fixed epoch for deterministic timestamps
const PLAN = SPINE_REFERENCE_PLAN;

function freshRuntime(): SpineRuntime {
  return createRuntimeState(PLAN, T0);
}

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    now: T0,
    elapsedSegmentMinutes: 0,
    submissionCount: 0,
    voteCount: 0,
    minSubmissions: 2,
    ...overrides,
  };
}

function startedRuntime(): SpineRuntime {
  const rt = freshRuntime();
  const r = applyAction(PLAN, rt, { type: "start_session" }, ctx());
  assert.ok(r.ok, "start_session should succeed from setup");
  return r.ok ? r.runtime : rt;
}

/** Advance through segments with a per-segment minute budget, returning the
 * runtime and the `now` cursor. Simulates the leader pressing advance. */
function advanceThrough(rt: SpineRuntime, now: number, segmentIndex: number, minutes: number, subCounts = 9, voteCounts = 0) {
  const key = PLAN.segments[segmentIndex].key;
  const result = applyAction(
    PLAN,
    rt,
    { type: "advance_segment" },
    ctx({ now: now + minutes * MIN, elapsedSegmentMinutes: minutes, submissionCount: subCounts, voteCount: voteCounts }),
  );
  assert.ok(result.ok, `advance of ${key} should succeed: ${!result.ok ? result.reason : ""}`);
  return { runtime: result.ok ? result.runtime : rt, now: now + minutes * MIN };
}

console.log("=== Session runtime gate — state machine ===");

check("start_session transitions setup → active and logs it", () => {
  const rt = freshRuntime();
  const r = applyAction(PLAN, rt, { type: "start_session" }, ctx());
  assert.ok(r.ok);
  assert.equal(r.runtime.phase, "active");
  assert.ok(r.runtime.events.some((e) => e.kind === "phase" && e.actor === "leader"));
});

check("advance_segment is illegal in setup and during a break", () => {
  const rt = freshRuntime();
  const r1 = applyAction(PLAN, rt, { type: "advance_segment" }, ctx());
  assert.ok(!r1.ok && r1.reason.includes("start the session"));
  const started = startedRuntime();
  // advance to the first break boundary (after s3, index 2 → cursor at 3)
  let cur = started;
  let now = T0;
  for (const i of [0, 1, 2]) ({ runtime: cur, now } = advanceThrough(cur, now, i, PLAN.segments[i].plannedMinutes));
  const b = applyAction(PLAN, cur, { type: "start_break" }, ctx({ now }));
  assert.ok(b.ok, `break at the s3 boundary should start: ${!b.ok ? b.reason : ""}`);
  const r3 = applyAction(PLAN, b.runtime, { type: "advance_segment" }, ctx({ now }));
  assert.ok(!r3.ok && r3.reason.includes("end the break"));
  // A break is NOT available mid-segment away from its anchor.
  const ended = applyAction(PLAN, b.runtime, { type: "end_break", force: true }, ctx({ now: now + 11 * MIN }));
  assert.ok(ended.ok);
  const r4 = applyAction(PLAN, ended.runtime, { type: "advance_segment" }, ctx({ now }));
  assert.ok(r4.ok, "advance resumes after the break");
  // A break is NOT available away from any anchor: fresh runtime, sit on s2
  // (anchors are s3, s5, s7 — neither s1 nor s2 qualifies).
  const onS2 = advanceThrough(startedRuntime(), T0, 0, PLAN.segments[0].plannedMinutes).runtime;
  const strayBreak = applyAction(PLAN, onS2, { type: "start_break" }, ctx({ now }));
  assert.ok(!strayBreak.ok && strayBreak.reason.includes("no break is scheduled"), "no break is anchored at the s1/s2 boundary");
});

check("advance at the final segment is rejected in favor of end_session", () => {
  let rt = startedRuntime();
  let now = T0;
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    ({ runtime: rt, now } = advanceThrough(rt, now, i, PLAN.segments[i].plannedMinutes));
    if (i === 2 || i === 4 || i === 6) {
      const b = applyAction(PLAN, rt, { type: "start_break" }, ctx({ now }));
      assert.ok(b.ok);
      rt = b.runtime;
      now += PLAN.breaks.find((br) => br.id === (rt.breakState as { breakId: string }).breakId)!.plannedMinutes * MIN;
      const e = applyAction(PLAN, rt, { type: "end_break" }, ctx({ now }));
      assert.ok(e.ok);
      rt = e.runtime;
      // reentry → active on the next advance
    }
  }
  const r = applyAction(PLAN, rt, { type: "advance_segment" }, ctx({ now }));
  assert.ok(!r.ok && r.reason.includes("end_session"), `final advance should redirect to end_session, got: ${!r.ok ? r.reason : "ok"}`);
  assert.equal(rt.currentSegmentIndex, PLAN.segments.length - 1);
});

check("skip_segment marks the segment skipped and its outputs skipped", () => {
  let rt = startedRuntime();
  let now = T0;
  ({ runtime: rt, now } = advanceThrough(rt, now, 0, PLAN.segments[0].plannedMinutes));
  const r = applyAction(PLAN, rt, { type: "skip_segment" }, ctx({ now, submissionCount: 0 }));
  assert.ok(r.ok);
  rt = r.runtime;
  assert.equal(rt.currentSegmentIndex, 2);
  const s1outputs = rt.outputs.filter((o) => o.segmentKey === PLAN.segments[1].key);
  assert.ok(s1outputs.length > 0 && s1outputs.every((o) => o.status === "skipped"));
  const audit = auditOutputs(rt);
  assert.ok(audit.skipped.length > 0, "skipped outputs appear in the skipped bucket, not missing");
});

check("end_break is protected below the minimum; force records an override", () => {
  let rt = startedRuntime();
  let now = T0;
  for (const i of [0, 1, 2]) ({ runtime: rt, now } = advanceThrough(rt, now, i, PLAN.segments[i].plannedMinutes));
  const b = applyAction(PLAN, rt, { type: "start_break" }, ctx({ now }));
  assert.ok(b.ok, `break anchors at the s3 boundary: ${!b.ok ? b.reason : ""}`);
  rt = b.runtime;
  const tooEarly = applyAction(PLAN, rt, { type: "end_break" }, ctx({ now: now + 5 * MIN }));
  assert.ok(!tooEarly.ok && tooEarly.reason.includes("protected minimum break"));
  const forced = applyAction(PLAN, rt, { type: "end_break", force: true }, ctx({ now: now + 5 * MIN }));
  assert.ok(forced.ok);
  rt = forced.runtime;
  assert.ok(
    rt.events.some((e) => e.kind === "override" && e.summary.includes("ended early by leader override")),
    "forced early end must be recorded as an override event",
  );
  // After the minimum, a plain end works without an override record.
  let rt2 = startedRuntime();
  let now2 = T0;
  for (const i of [0, 1, 2]) ({ runtime: rt2, now: now2 } = advanceThrough(rt2, now2, i, PLAN.segments[i].plannedMinutes));
  const b2 = applyAction(PLAN, rt2, { type: "start_break" }, ctx({ now: now2 }));
  rt2 = b2.runtime!;
  const onTime = applyAction(PLAN, rt2, { type: "end_break" }, ctx({ now: now2 + 15 * MIN }));
  assert.ok(onTime.ok);
  assert.ok(!onTime.runtime.events.some((e) => e.kind === "override"), "on-time end is not an override");
  assert.ok(Math.abs((onTime.runtime.breakActualMinutes["brk-1"] ?? 0) - 15) < 0.01, "break actual minutes recorded");
});

check("extend_break extends the budget and rejects nonsense", () => {
  let rt = startedRuntime();
  let now = T0;
  for (const i of [0, 1, 2]) ({ runtime: rt, now } = advanceThrough(rt, now, i, PLAN.segments[i].plannedMinutes));
  const b = applyAction(PLAN, rt, { type: "start_break" }, ctx({ now }));
  rt = b.runtime!;
  const bad = applyAction(PLAN, rt, { type: "extend_break", minutes: 0 }, ctx({ now }));
  assert.ok(!bad.ok && bad.reason.includes("positive whole number"));
  const ok = applyAction(PLAN, rt, { type: "extend_break", minutes: 5 }, ctx({ now }));
  assert.ok(ok.ok && ok.runtime.breakState!.extraMinutes === 5);
  // 15 planned + 5 extension → clock budget is 20; 3 min elapsed of it
  const clock = computeClock(PLAN, ok.runtime, { now: now + 3 * MIN, segmentStartedAt: now, currentSegmentIndex: 3 });
  assert.equal(clock.breakState!.plannedMinutes, 20);
  assert.ok(Math.abs(clock.breakState!.elapsedMinutes - 3) < 0.01);
});

check("breakout lifecycle: only for its anchor segment, and back to active", () => {
  let rt = startedRuntime();
  let now = T0;
  ({ runtime: rt, now } = advanceThrough(rt, now, 0, PLAN.segments[0].plannedMinutes));
  const wrongAnchor = applyAction(PLAN, rt, { type: "start_breakout" }, ctx({ now }));
  assert.ok(!wrongAnchor.ok && wrongAnchor.reason.includes("no breakout is configured"));
  // s4 (index 3) carries the themes breakout — but the walk below is at s2;
  // the anchor must also reject when the CURRENT segment is s2.
  const onS2 = applyAction(PLAN, rt, { type: "start_breakout" }, ctx({ now }));
  assert.ok(!onS2.ok, "s2 has no breakout");
  ({ runtime: rt, now } = advanceThrough(rt, now, 1, PLAN.segments[1].plannedMinutes));
  ({ runtime: rt, now } = advanceThrough(rt, now, 2, PLAN.segments[2].plannedMinutes));
  const bo = applyAction(PLAN, rt, { type: "start_breakout" }, ctx({ now }));
  assert.ok(bo.ok, `breakout on s4 should start: ${!bo.ok ? bo.reason : ""}`);
  rt = bo.runtime;
  assert.equal(rt.phase, "breakout");
  const end = applyAction(PLAN, rt, { type: "end_breakout" }, ctx({ now: now + 10 * MIN }));
  assert.ok(end.ok && end.runtime.phase === "active");
  assert.ok(end.runtime.events.some((e) => e.kind === "breakout"));
});

check("human-led round trip", () => {
  let rt = startedRuntime();
  const enter = applyAction(PLAN, rt, { type: "enter_human_led" }, ctx());
  assert.ok(enter.ok && enter.runtime.phase === "recovery" && enter.runtime.guideMode === "human_led");
  const back = applyAction(PLAN, enter.runtime, { type: "return_to_ai_led" }, ctx());
  assert.ok(back.ok && back.runtime.phase === "active" && back.runtime.guideMode === "ai_led");
  const stray = applyAction(PLAN, back.runtime, { type: "return_to_ai_led" }, ctx());
  assert.ok(!stray.ok, "return_to_ai_led outside recovery is rejected");
});

console.log("=== Output audit & closing gate ===");

check("closing gate blocks silent completion with missing outputs", () => {
  let rt = startedRuntime();
  let now = T0;
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    ({ runtime: rt, now } = advanceThrough(rt, now, i, PLAN.segments[i].plannedMinutes, 9, i === 5 ? 9 : 0));
    if (i === 2 || i === 4 || i === 6) {
      const b = applyAction(PLAN, rt, { type: "start_break" }, ctx({ now }));
      rt = b.runtime!;
      const e = applyAction(PLAN, rt, { type: "end_break" }, ctx({ now: now + 15 * MIN }));
      rt = e.runtime!;
      now += 15 * MIN;
    }
  }
  // Statement/ranking outputs auto-completed; owners/actions/cadence did not.
  const audit = auditOutputs(rt);
  assert.ok(audit.missing.length > 0, "human-judgment outputs remain missing without leader marks");
  const blocked = applyAction(PLAN, rt, { type: "end_session" }, ctx({ now }));
  assert.ok(!blocked.ok, "silent completion must be blocked");
  assert.ok(blocked.ok === false && blocked.reason.includes("required output"));
  const forced = applyAction(PLAN, rt, { type: "end_session", force: true }, ctx({ now }));
  assert.ok(forced.ok);
  assert.equal(forced.runtime.phase, "complete");
  assert.equal(forced.runtime.completedWithMissingOutputs, true);
  assert.ok(forced.runtime.events.some((e) => e.kind === "override" && e.summary.includes("missing required output")));
});

check("leader mark_output completes the human-judgment outputs", () => {
  let rt = startedRuntime();
  let now = T0;
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    ({ runtime: rt, now } = advanceThrough(rt, now, i, PLAN.segments[i].plannedMinutes, 9, i === 5 ? 9 : 0));
    if (i === 2 || i === 4 || i === 6) {
      const b = applyAction(PLAN, rt, { type: "start_break" }, ctx({ now }));
      rt = b.runtime!;
      const e = applyAction(PLAN, rt, { type: "end_break" }, ctx({ now: now + 15 * MIN }));
      rt = e.runtime!;
      now += 15 * MIN;
    }
  }
  for (const key of ["out.initiatives", "out.commitments", "out.review_cadence"]) {
    const m = applyAction(PLAN, rt, { type: "mark_output", outputKey: key }, ctx({ now }));
    assert.ok(m.ok, `mark_output ${key}: ${!m.ok ? m.reason : ""}`);
    rt = m.runtime;
  }
  const clean = applyAction(PLAN, rt, { type: "end_session" }, ctx({ now }));
  assert.ok(clean.ok, `clean close after marks: ${!clean.ok ? clean.reason : ""}`);
  assert.ok(!clean.runtime.completedWithMissingOutputs);
});

console.log("=== Clock arithmetic & drift ledger ===");

check("clock drift counts completed actuals, breaks, and the running segment", () => {
  let rt = startedRuntime();
  let now = T0;
  // s1 on time (20), s2 runs 15 over (45→60): drift +15
  ({ runtime: rt, now } = advanceThrough(rt, now, 0, PLAN.segments[0].plannedMinutes));
  ({ runtime: rt, now } = advanceThrough(rt, now, 1, PLAN.segments[1].plannedMinutes + 15));
  const clock = computeClock(PLAN, rt, { now, segmentStartedAt: now, currentSegmentIndex: rt.currentSegmentIndex });
  assert.ok(Math.abs(clock.driftMinutes - 15) < 0.01, `drift should be +15, got ${clock.driftMinutes}`);
  assert.ok(Math.abs(cumulativeOverrunMinutes(rt, PLAN) - 15) < 0.01);
  assert.equal(clock.closingPressure, false);
});

check("cumulative overrun counts completed segments AND breaks", () => {
  let rt = startedRuntime();
  rt.segmentActualMinutes["s2-current-reality"] = 60; // +15
  rt.segmentActualMinutes["s3-purpose-clarity"] = 60; // +15 → 30
  rt.breakActualMinutes["brk-1"] = 20; // +5 → 35
  assert.ok(Math.abs(cumulativeOverrunMinutes(rt, PLAN) - 35) < 0.01);
});

check("closing pressure flips inside the closing buffer", () => {
  const rt = startedRuntime();
  // Put the ledger right before the final segment: all eight segments done
  // on time, all three breaks taken on time.
  rt.segmentActualMinutes = Object.fromEntries(PLAN.segments.slice(0, -1).map((s) => [s.key, s.plannedMinutes]));
  rt.breakActualMinutes = Object.fromEntries(PLAN.breaks.map((b) => [b.id, b.plannedMinutes]));
  const clock = computeClock(PLAN, rt, { now: T0, segmentStartedAt: T0, currentSegmentIndex: PLAN.segments.length - 1 });
  assert.equal(clock.closingPressure, true, "remaining planned time (15m) is within the 15m buffer");
  // One segment of drift pushes it deeper inside the buffer.
  rt.segmentActualMinutes["s3-purpose-clarity"] = PLAN.segments[2].plannedMinutes + 15;
  const clock2 = computeClock(PLAN, rt, { now: T0, segmentStartedAt: T0, currentSegmentIndex: PLAN.segments.length - 1 });
  assert.equal(clock2.closingPressure, true);
  assert.ok(Math.abs(clock2.driftMinutes - 15) < 0.01, `drift reflects the +15 overrun, got ${clock2.driftMinutes}`);
});

console.log("=== Events, recommendations, and durability ===");

check("event log is capped and keeps the newest entries", () => {
  const rt = startedRuntime();
  const base = rt.events.length;
  for (let i = 0; i < 600; i++) {
    rt.events.push({ id: `e${i}`, seq: base + i, at: new Date(T0).toISOString(), kind: "system", actor: "system", summary: `synthetic ${i}` });
  }
  // Re-run normalize+cap via a synthetic append: simulate the cap by trimming
  // through applyAction (park_issue appends through the real cap path).
  for (let i = 0; i < 520; i++) {
    applyAction(PLAN, rt, { type: "park_issue", text: `parked ${i}`, source: "leader" }, ctx());
  }
  assert.ok(rt.events.length <= 500, `event log capped at MAX_EVENT_LOG_ENTRIES, got ${rt.events.length}`);
  const last = rt.events[rt.events.length - 1];
  assert.ok(last.summary.includes("parked 519"), "newest event survives the cap");
});

check("recommendation lifecycle: decide once, edit records text, re-decide rejected", () => {
  let rt = startedRuntime();
  const rec = {
    id: "rec-1",
    action: { type: "time_check" as const, minutesRemaining: 30, text: "We are behind; compress next." },
    reason: "drift 15",
    status: "pending" as const,
  };
  rt.recommendations.push(rec);
  const d1 = applyAction(PLAN, rt, { type: "decide_recommendation", recommendationId: "rec-1", decision: "edited", editedText: "We are behind; trim the close by 5." }, ctx());
  assert.ok(d1.ok && d1.runtime.recommendations[0].status === "edited");
  assert.equal(d1.runtime.recommendations[0].editedText, "We are behind; trim the close by 5.");
  const d2 = applyAction(PLAN, rt, { type: "decide_recommendation", recommendationId: "rec-1", decision: "accepted" }, ctx());
  assert.ok(!d2.ok && d2.reason.includes("already decided"));
  const d3 = applyAction(PLAN, rt, { type: "decide_recommendation", recommendationId: "nope", decision: "accepted" }, ctx());
  assert.ok(!d3.ok && d3.reason.includes("unknown recommendation"));
  const d4 = applyAction(PLAN, rt, { type: "decide_recommendation", recommendationId: "rec-1", decision: "pending" as never }, ctx());
  assert.ok(!d4.ok, "pending is not a decision");
});

check("participant correction parks an issue without mutating outputs", () => {
  const rt = startedRuntime();
  const before = JSON.stringify(rt.outputs);
  const r = applyAction(PLAN, rt, { type: "park_issue", text: "That summary missed what Group B said.", source: "participant", aboutMessageId: "gm-1" }, ctx());
  assert.ok(r.ok);
  assert.equal(JSON.stringify(r.runtime.outputs), before, "corrections never touch outputs");
  assert.ok(r.runtime.parkedIssues.some((i) => i.source === "participant" && i.aboutMessageId === "gm-1"));
  const tooLong = applyAction(PLAN, rt, { type: "park_issue", text: "x".repeat(501), source: "participant" }, ctx());
  assert.ok(!tooLong.ok && tooLong.reason.includes("500-character"));
});

check("JSON round-trip preserves behavior (resume-after-restart)", () => {
  let rt = startedRuntime();
  rt.segmentActualMinutes["s2-current-reality"] = 60;
  rt.lastDriftThresholdAnnounced = 15;
  const restored = normalizeRuntime(JSON.parse(JSON.stringify(rt)));
  assert.ok(restored);
  // A fresh tick at the same drift must NOT re-announce the 15-minute level.
  const clock = computeClock(PLAN, restored, { now: T0, segmentStartedAt: T0, currentSegmentIndex: 2 });
  const tick = spineTick(restored, { ...clock, driftMinutes: 16 }, "s3-purpose-clarity");
  assert.equal(tick.guideMessages.filter((m) => m.kind === "time_check" && (m.detail ?? "").includes("drift 16")).length, 0, "15-min threshold already announced");
  assert.ok(restored.lastDriftThresholdAnnounced === 15 || restored.lastDriftThresholdAnnounced >= 15);
});

check("normalizeRuntime backfills older checkpoints", () => {
  const partial = { planId: PLAN.id, planVersion: PLAN.version, phase: "active", phaseStartedAt: new Date(T0).toISOString(), guideMode: "ai_led", segmentState: "active", currentSegmentIndex: 2 };
  const rt = normalizeRuntime(partial);
  assert.ok(rt);
  assert.ok(Array.isArray(rt!.outputs) && Array.isArray(rt!.events));
  assert.equal(rt!.currentSegmentIndex, 2);
  assert.equal(normalizeRuntime(null), null);
  assert.equal(normalizeRuntime("nope"), null);
});

check("vote quorum: reached once every connected phone has voted, announced once", () => {
  const rt = startedRuntime();
  assert.equal(voteQuorumReached(rt, "s6-prioritization", 5, 9), false, "5 of 9 is not quorum");
  assert.equal(voteQuorumReached(rt, "s6-prioritization", 9, 9), true, "9 of 9 is quorum");
  markVoteAnnounced(rt, "s6-prioritization");
  assert.equal(voteQuorumReached(rt, "s6-prioritization", 9, 9), false, "already announced");
  assert.equal(voteQuorumReached(rt, "s6-prioritization", 9, 0), false, "no phones connected — no quorum signal");
});


check("enqueueGuideRecommendation bridges probe/evaluator/pacer/synthesis to console queue", () => {
  const rt = startedRuntime();
  const probe = enqueueGuideRecommendation(rt, {
    id: "gm-probe-1",
    kind: "probe",
    text: "What specifically drains energy on Tuesday nights?",
    detail: "thin",
    segmentKey: "s2-current-reality",
    createdAt: new Date(T0).toISOString(),
  });
  assert.ok(probe);
  assert.equal(probe!.action.type, "ask_question");
  assert.equal(rt.recommendations.filter((r) => r.status === "pending").length, 1);

  const evaluator = enqueueGuideRecommendation(rt, {
    id: "gm-eval-1",
    kind: "evaluator",
    text: "There's unresolved disagreement in the room on this question.",
    segmentKey: "s2-current-reality",
    createdAt: new Date(T0).toISOString(),
  });
  assert.ok(evaluator && evaluator.action.type === "request_human_intervention");

  const pacer = enqueueGuideRecommendation(rt, {
    id: "gm-pacer-1",
    kind: "pacer",
    text: "We are past the planned time for this segment.",
    segmentKey: "s2-current-reality",
    createdAt: new Date(T0).toISOString(),
  });
  assert.ok(pacer && pacer.action.type === "time_check");

  const synthesis = enqueueGuideRecommendation(rt, {
    id: "gm-syn-1",
    kind: "synthesis",
    text: "Draft plan notes are saved.",
    detail: "theme",
    segmentKey: "s2-current-reality",
    createdAt: new Date(T0).toISOString(),
  });
  assert.ok(synthesis && synthesis.action.type === "summarize");

  // Announcements are not console-actionable via this bridge.
  const announcement = enqueueGuideRecommendation(rt, {
    id: "gm-ann-1",
    kind: "announcement",
    text: "Break is over whenever you are ready.",
    segmentKey: "s2-current-reality",
    createdAt: new Date(T0).toISOString(),
  });
  assert.equal(announcement, null);

  // Dedupes identical pending text / same id.
  const dup = enqueueGuideRecommendation(rt, {
    id: "gm-probe-1",
    kind: "probe",
    text: "What specifically drains energy on Tuesday nights?",
    segmentKey: "s2-current-reality",
    createdAt: new Date(T0).toISOString(),
  });
  assert.equal(dup, null);
  assert.equal(rt.recommendations.filter((r) => r.status === "pending").length, 4);
});

console.log(`\nPASS — ${checks} runtime checks green.`);

