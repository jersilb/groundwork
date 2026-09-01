#!/usr/bin/env node --experimental-strip-types
// Six-hour simulation — build plan §6 R2 acceptance, deterministic.
//
// A scripted leader runs the FULL reference itinerary against the pure
// runtime with an injected clock. No network, no LLM, no Durable Object.
// The LLM-outage scenario is structural, not simulated: every spine
// recommendation here comes from deterministic thresholds, exactly as the
// production alarm tick does when ANTHROPIC_API_KEY is absent.
//
// Asserted (per the R2 acceptance list):
//   1. the itinerary executes in order
//   2. every scheduled break is taken (or an override is recorded)
//   3. drift detection fires at 15, 30, and 60 minutes
//   4. the closing buffer is protected (recommendation + gate)
//   5. the session cannot silently complete with missing outputs
//   6. a mid-session restart (JSON round-trip) resumes without state loss
//   7. degraded scenarios have deterministic documented paths
import assert from "node:assert/strict";
import { SPINE_REFERENCE_PLAN } from "../src/session-plan.ts";
import {
  applyAction,
  auditOutputs,
  computeClock,
  createRuntimeState,
  cumulativeOverrunMinutes,
  normalizeRuntime,
  spineTick,
  type SpineRuntime,
  type TransitionContext,
  type SessionClockState,
} from "../src/session-runtime.ts";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${checks} — ${name}`);
}

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const PLAN = SPINE_REFERENCE_PLAN;
const PARTICIPANTS = 9;

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return { now: T0, elapsedSegmentMinutes: 0, submissionCount: 0, voteCount: 0, minSubmissions: 2, ...overrides };
}

interface WalkState {
  rt: SpineRuntime;
  now: number;
  /** ISO/ms the current segment's clock started (mirrors the DO's
   * segmentStartedAt: reset at boundaries and at break end). */
  segmentStartedAt: number;
  tickMessages: number;
  recommendations: number;
}

function tick(state: WalkState): void {
  const clock = computeClock(PLAN, state.rt, { now: state.now, segmentStartedAt: state.segmentStartedAt, currentSegmentIndex: state.rt.currentSegmentIndex });
  const result = spineTick(state.rt, clock, PLAN.segments[state.rt.currentSegmentIndex].key);
  state.tickMessages += result.guideMessages.length;
  state.recommendations += result.recommendations.length;
}

/** One scripted segment: submissions land, the leader lets it run for
 * `runFor` minutes (may exceed planned), ticks the alarm, then advances. */
function runSegment(state: WalkState, index: number, runFor: number, votes = 0): void {
  assert.equal(state.rt.currentSegmentIndex, index, `itinerary must execute in order: expected segment ${index}`);
  const isVote = PLAN.segments[index].inputMode === "vote_then_discuss";
  const vc = isVote ? PARTICIPANTS : votes;
  // alarm tick mid-segment, then advance at runFor
  state.now += runFor * MIN * 0.5;
  tick(state);
  const result = applyAction(
    PLAN,
    state.rt,
    { type: "advance_segment" },
    ctx({ now: state.now + (runFor - runFor * 0.5) * MIN, elapsedSegmentMinutes: runFor, submissionCount: PARTICIPANTS, voteCount: vc }),
  );
  assert.ok(result.ok, `advance segment ${index}: ${!result.ok ? result.reason : ""}`);
  if (result.ok) {
    state.rt = result.runtime;
    state.now += (runFor - runFor * 0.5) * MIN;
    state.segmentStartedAt = state.now; // boundary refresh (mirrors the DO)
  }
}

/** Take the break anchored after the segment the walk just completed. */
function takeBreak(state: WalkState, minutes = 15): void {
  const b = applyAction(PLAN, state.rt, { type: "start_break" }, ctx({ now: state.now }));
  assert.ok(b.ok, `break should start here: ${!b.ok ? b.reason : ""}`);
  state.rt = b.runtime;
  state.now += minutes * MIN;
  tick(state); // segElapsed is frozen during the break (runtime freeze rule)
  const e = applyAction(PLAN, state.rt, { type: "end_break" }, ctx({ now: state.now }));
  assert.ok(e.ok, `break should end cleanly after ${minutes} min: ${!e.ok ? e.reason : ""}`);
  state.rt = e.runtime;
  state.segmentStartedAt = state.now; // re-entry: fresh segment window (D7)
}

function startWalk(): WalkState {
  const rt = createRuntimeState(PLAN, T0);
  const s = applyAction(PLAN, rt, { type: "start_session" }, ctx({ now: T0 }));
  assert.ok(s.ok);
  return { rt: s.runtime, now: T0, segmentStartedAt: T0, tickMessages: 0, recommendations: 0 };
}

console.log("=== Six-hour simulation — cooperative group with realistic drift ===");

check("full itinerary executes with every break taken on time", () => {
  // Drift script: s2 runs +15, s3 runs +15 more (cumulative 30), s8 runs +30
  // (cumulative 60). The room recovers nothing — exactly the "behind" case.
  const state = startWalk();
  const overrun: Record<number, number> = { 1: 15, 2: 15, 7: 30 };
  for (let i = 0; i < PLAN.segments.length; i++) {
    if (i === PLAN.segments.length - 1) break; // final segment handled by close
    runSegment(state, i, PLAN.segments[i].plannedMinutes + (overrun[i] ?? 0), i === 5 ? 0 : 0);
    const anchorBreak = PLAN.breaks.find((b) => b.afterSegmentKey === PLAN.segments[i].key);
    if (anchorBreak) takeBreak(state, anchorBreak.plannedMinutes);
  }
  // The state right before the close: all segments but the last complete.
  assert.equal(state.rt.currentSegmentIndex, PLAN.segments.length - 1);
  const breaksTaken = Object.keys(state.rt.breakActualMinutes);
  assert.equal(breaksTaken.length, 3, `all three breaks taken, got ${breaksTaken.length}`);
  for (const id of breaksTaken) {
    const spec = PLAN.breaks.find((b) => b.id === id)!;
    assert.ok(
      state.rt.breakActualMinutes[id] >= spec.minimumMinutes,
      `break ${id} met its protected minimum`,
    );
  }
  // No forced overrides anywhere in the cooperative walk.
  assert.ok(!state.rt.events.some((e) => e.kind === "override"), "cooperative run has no overrides");
  state.rt.outputs = state.rt.outputs.map((o) =>
    ["out.initiatives", "out.commitments", "out.review_cadence"].includes(o.key)
      ? { ...o, status: "complete" as const, completedAt: new Date(state.now).toISOString(), by: "leader" }
      : o,
  );
  const close = applyAction(PLAN, state.rt, { type: "end_session" }, ctx({ now: state.now }));
  assert.ok(close.ok, `close after complete audit: ${!close.ok ? close.reason : ""}`);
  assert.equal(close.runtime.phase, "complete");
  assert.ok(!close.runtime.completedWithMissingOutputs);
});

check("drift detection fires at 15, 30, and 60 minutes — once each", () => {
  const state = startWalk();
  const overrun: Record<number, number> = { 1: 15, 2: 15, 7: 30 };
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    runSegment(state, i, PLAN.segments[i].plannedMinutes + (overrun[i] ?? 0));
    const anchorBreak = PLAN.breaks.find((b) => b.afterSegmentKey === PLAN.segments[i].key);
    if (anchorBreak) takeBreak(state, anchorBreak.plannedMinutes);
  }
  // One tick on the final segment (index 8): cumulative overrun 60 → the
  // 60-minute level fires; the walk's mid-segment ticks already fired 15
  // (mid-s3) and 30 (mid-s8). Exactly three notices, ascending once each.
  tick(state);
  assert.ok(Math.abs(cumulativeOverrunMinutes(state.rt, PLAN) - 60) < 0.5, `cumulative overrun 60, got ${cumulativeOverrunMinutes(state.rt, PLAN)}`);
  const driftNotices = state.rt.events.filter((e) => e.kind === "guide_message" && e.summary.includes("Drift notice"));
  const levels = driftNotices.map((e) => Number((e.payload as { drift: number }).drift));
  assert.deepEqual(levels, [15, 30, 60], `threshold ladder must be 15→30→60, got ${levels.join(",")}`);
  assert.equal(state.rt.lastDriftThresholdAnnounced, 60, "the 60-minute threshold is the last announced");
});

check("closing buffer is protected: recommendation raised and gate holds", () => {
  const state = startWalk();
  const overrun: Record<number, number> = { 1: 15, 2: 15, 7: 30 };
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    runSegment(state, i, PLAN.segments[i].plannedMinutes + (overrun[i] ?? 0));
    const anchorBreak = PLAN.breaks.find((b) => b.afterSegmentKey === PLAN.segments[i].key);
    if (anchorBreak) takeBreak(state, anchorBreak.plannedMinutes);
  }
  // 60 minutes of drift consumed the buffer: with 60 lost, the remaining
  // schedule fits inside the 15-minute closing buffer → pressure.
  tick(state);
  const protection = state.rt.recommendations.find((r) => r.reason === "closing buffer protection");
  assert.ok(protection, "closing-buffer recommendation was raised");
  assert.equal(protection!.status, "pending", "the leader has not decided it yet (§5.5)");
  // The gate itself: completion still requires the audit.
  const blocked = applyAction(PLAN, state.rt, { type: "end_session" }, ctx({ now: state.now }));
  assert.ok(!blocked.ok, "completion remains gated on the closing audit even under pressure");
});

check("restart mid-session: JSON round-trip resumes with no state loss", () => {
  const state = startWalk();
  runSegment(state, 0, PLAN.segments[0].plannedMinutes);
  runSegment(state, 1, PLAN.segments[1].plannedMinutes + 15); // overrun lands at advance
  tick(state); // first tick after the overrun: cumulative drift +15 → announces
  assert.equal(state.rt.lastDriftThresholdAnnounced, 15);
  // === the DO is evicted here; state comes back from a checkpoint ===
  const restored = normalizeRuntime(JSON.parse(JSON.stringify(state.rt)));
  assert.ok(restored, "runtime restores from JSON");
  const state2: WalkState = { rt: restored!, now: state.now, segmentStartedAt: state.now, tickMessages: 0, recommendations: 0 };
  // Continue the itinerary from segment 2 — no re-announced 15-min drift.
  const messagesBefore = state2.rt.events.filter((e) => e.kind === "guide_message" && e.summary.includes("Drift notice")).length;
  runSegment(state2, 2, PLAN.segments[2].plannedMinutes);
  assert.equal(
    state2.rt.events.filter((e) => e.kind === "guide_message" && e.summary.includes("Drift notice")).length,
    messagesBefore,
    "no duplicate drift notice after restart (L5 discipline survives restore)",
  );
  assert.equal(state2.rt.lastDriftThresholdAnnounced, 15, "threshold watermark preserved");
});

check("silent completion is impossible: the audit blocks the close", () => {
  const state = startWalk();
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    runSegment(state, i, PLAN.segments[i].plannedMinutes);
    const anchorBreak = PLAN.breaks.find((b) => b.afterSegmentKey === PLAN.segments[i].key);
    if (anchorBreak) takeBreak(state, anchorBreak.plannedMinutes);
  }
  const audit = auditOutputs(state.rt);
  assert.ok(audit.missing.length > 0, "human-judgment outputs are still open");
  const blocked = applyAction(PLAN, state.rt, { type: "end_session" }, ctx({ now: state.now }));
  assert.ok(!blocked.ok && blocked.reason.includes(audit.missing[0]), "the rejection names the first missing output");
});

console.log("=== Degraded scenarios — deterministic documented paths ===");

check("scenario: LLM outage — the spine still speaks (deterministic tick)", () => {
  const state = startWalk();
  // No LlmClient anywhere in this harness: every message below came from
  // thresholds. Force a 20-minute drift and tick.
  runSegment(state, 0, PLAN.segments[0].plannedMinutes);
  runSegment(state, 1, PLAN.segments[1].plannedMinutes + 20);
  tick(state);
  assert.ok(state.rt.recommendations.some((r) => r.action.type === "time_check"), "drift recommendation queued without any LLM");
  // The broadcast path in the DO catches all LLM failures; nothing here can
  // throw — the invariant is structural.
});

check("scenario: instructor skips a segment — outputs skipped, close still honest", () => {
  const state = startWalk();
  runSegment(state, 0, PLAN.segments[0].plannedMinutes);
  const skip = applyAction(PLAN, state.rt, { type: "skip_segment" }, ctx({ now: state.now }));
  assert.ok(skip.ok);
  state.rt = skip.runtime;
  assert.equal(state.rt.currentSegmentIndex, 2);
  const skippedOutputs = state.rt.outputs.filter((o) => o.segmentKey === PLAN.segments[1].key);
  assert.ok(skippedOutputs.every((o) => o.status === "skipped"));
  // Skipped outputs are recorded as skipped — they do NOT silently block the
  // close as "missing"; the event log carries the skip decision.
  const audit = auditOutputs(state.rt);
  assert.ok(!audit.missing.some((k) => skippedOutputs.some((o) => o.key === k)));
  assert.ok(state.rt.events.some((e) => e.summary.includes("skipped by the leader")));
});

check("scenario: break extension — budget shifts, minimum still protected", () => {
  const state = startWalk();
  runSegment(state, 0, PLAN.segments[0].plannedMinutes);
  runSegment(state, 1, PLAN.segments[1].plannedMinutes);
  runSegment(state, 2, PLAN.segments[2].plannedMinutes);
  const b = applyAction(PLAN, state.rt, { type: "start_break" }, ctx({ now: state.now }));
  state.rt = b.runtime!;
  const ext = applyAction(PLAN, state.rt, { type: "extend_break", minutes: 10 }, ctx({ now: state.now }));
  assert.ok(ext.ok && ext.runtime.breakState!.extraMinutes === 10);
  state.now += 24 * MIN;
  tick(state);
  // 24 min elapsed vs 25-min budget (15+10): no overdue speech.
  const overBefore = state.rt.events.filter((e) => e.summary.includes("Break-over notice")).length;
  assert.equal(overBefore, 0);
  state.now += 3 * MIN; // 27 > 25 → overdue fires once
  tick(state);
  assert.equal(state.rt.events.filter((e) => e.summary.includes("Break-over notice")).length, 1);
  const e = applyAction(PLAN, state.rt, { type: "end_break" }, ctx({ now: state.now }));
  assert.ok(e.ok, "end after the extended budget needs no force");
  state.rt = e.runtime;
  tick(state);
  assert.equal(state.rt.events.filter((ev) => ev.summary.includes("Break-over notice")).length, 1, "no repeat after end (L5)");
});

check("scenario: forced early break end is recorded, session continues", () => {
  const state = startWalk();
  runSegment(state, 0, PLAN.segments[0].plannedMinutes);
  runSegment(state, 1, PLAN.segments[1].plannedMinutes);
  runSegment(state, 2, PLAN.segments[2].plannedMinutes);
  const b = applyAction(PLAN, state.rt, { type: "start_break" }, ctx({ now: state.now }));
  state.rt = b.runtime!;
  state.now += 6 * MIN;
  const e = applyAction(PLAN, state.rt, { type: "end_break", force: true }, ctx({ now: state.now }));
  assert.ok(e.ok && e.runtime.phase === "active", "re-entry lands back in active (transient posture)");
  assert.ok(e.runtime.events.some((ev) => ev.kind === "override" && ev.summary.includes("brk-1")));
});

check("scenario: participant corrects the Guide — parked, never mutating", () => {
  const state = startWalk();
  const before = JSON.stringify(state.rt.outputs);
  const fb = applyAction(PLAN, state.rt, { type: "park_issue", text: "The summary merged two groups' disagreements.", source: "participant", aboutMessageId: "gm-42" }, ctx({ now: state.now }));
  assert.ok(fb.ok);
  assert.equal(JSON.stringify(fb.runtime.outputs), before);
  assert.ok(fb.runtime.parkedIssues.some((i) => i.source === "participant"));
});

check("final segment runs under closing protection and closes cleanly", () => {
  const state = startWalk();
  const overrun: Record<number, number> = { 1: 15, 2: 15, 7: 30 };
  for (let i = 0; i < PLAN.segments.length - 1; i++) {
    runSegment(state, i, PLAN.segments[i].plannedMinutes + (overrun[i] ?? 0));
    const anchorBreak = PLAN.breaks.find((b) => b.afterSegmentKey === PLAN.segments[i].key);
    if (anchorBreak) takeBreak(state, anchorBreak.plannedMinutes);
  }
  // Closing phase active on the final segment.
  assert.equal(state.rt.phase, "closing");
  // Leader confirms the three human-judgment outputs, then closes.
  for (const key of ["out.initiatives", "out.commitments", "out.review_cadence"]) {
    const m = applyAction(PLAN, state.rt, { type: "mark_output", outputKey: key }, ctx({ now: state.now }));
    assert.ok(m.ok);
    state.rt = m.runtime;
  }
  const close = applyAction(PLAN, state.rt, { type: "end_session" }, ctx({ now: state.now }));
  assert.ok(close.ok, `close: ${!close.ok ? close.reason : ""}`);
  assert.equal(close.runtime.phase, "complete");
  const audit = auditOutputs(close.runtime);
  assert.equal(audit.missing.length, 0, "no required output left unaccounted");
});

console.log(`\nPASS — ${checks} six-hour simulation checks green.`);
