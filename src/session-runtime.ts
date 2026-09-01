import type { SessionPlan, RecoveryStrategy } from "./session-plan.ts";
import type { GuideMessage, GuideMessageKind } from "./session-protocol.ts";

// ---------------------------------------------------------------------------
// Session runtime — build plan §5.2/§5.3/§5.4, implemented PURE.
//
// Every mutation of the session spine flows through `applyAction`, a pure
// transition function: no I/O, no clocks of its own (the caller injects
// `now` and the observed segment clock), no LLM. The SessionDO applies the
// returned runtime to its durable state, persists, broadcasts, and
// checkpoints — this module can never fail silently or invent time.
//
// §5.5 / D2: every state transition here is a leader action or an explicit
// `{force}` override. The Guide's contributions enter as SPEECH (published
// guide messages) and queued recommendations — decided by the leader through
// `decide_recommendation`, never auto-applied.
//
// Serialization: every type here is plain JSON — a runtime restored from a
// checkpoint behaves identically (resume-after-restart is a data property,
// not a code path).
// ---------------------------------------------------------------------------

export type SpinePhase =
  | "setup"
  | "active"
  | "break"
  | "breakout"
  | "reentry"
  | "recovery"
  | "closing"
  | "complete";

export type GuideMode = "ai_led" | "human_led" | "paused";
export type SegmentState = "active" | "complete" | "skipped" | "parked";
export type OutputState = "pending" | "in_progress" | "complete" | "skipped";

export interface OutputStatus {
  key: string;
  segmentKey: string;
  title: string;
  kind: string;
  required: boolean;
  status: OutputState;
  completedAt?: string;
  by?: string;
}

export interface ParkedIssue {
  id: string;
  text: string;
  source: "leader" | "guide" | "participant";
  aboutMessageId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface RecommendationEntry {
  id: string;
  action: GuideAction;
  reason: string;
  status: "pending" | "accepted" | "edited" | "dismissed" | "deferred";
  editedText?: string;
  decidedAt?: string;
  decidedBy?: string;
}

export type EventKind =
  | "system"
  | "phase"
  | "segment"
  | "break"
  | "breakout"
  | "output"
  | "recommendation"
  | "override"
  | "guide_message"
  | "feedback";

export interface SessionEvent {
  id: string;
  seq: number;
  at: string;
  kind: EventKind;
  actor: "leader" | "guide" | "system" | `participant:${string}`;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface BreakRuntime {
  breakId: string;
  startedAt: string;
  plannedMinutes: number;
  minimumMinutes: number;
  extraMinutes: number;
}

export interface BreakoutRuntime {
  breakoutId: string;
  startedAt: string;
  durationMinutes: number;
}

export interface SpineRuntime {
  planId: string;
  planVersion: string;
  phase: SpinePhase;
  phaseStartedAt: string;
  guideMode: GuideMode;
  segmentState: SegmentState;
  /** Index into the plan's segment list — the DO mirrors its own
   * currentSegmentIndex into the runtime on every boundary crossing. */
  currentSegmentIndex: number;
  breakState?: BreakRuntime;
  breakoutState?: BreakoutRuntime;
  outputs: OutputStatus[];
  parkedIssues: ParkedIssue[];
  recommendations: RecommendationEntry[];
  events: SessionEvent[];
  /** Per-segment actual minutes recorded at boundaries — the drift ledger. */
  segmentActualMinutes: Record<string, number>;
  breakActualMinutes: Record<string, number>;
  /** Highest drift threshold the room has already been told about. */
  lastDriftThresholdAnnounced: 0 | 15 | 30 | 60;
  /** Segment keys whose vote-quorum announcement already fired (L5 dedupe). */
  voteCompletedAnnouncedFor: Record<string, true>;
  /** Last one-shot instructor action applied (transport-level dedupe for
   * reconnect replays; set by the DO, never by the pure runtime). */
  lastAppliedActionId?: string;
  completedWithMissingOutputs?: boolean;
}

export const MAX_EVENT_LOG_ENTRIES = 500;

/** Typed Guide actions (§5.3). These are SPEECH or queued recommendations —
 * applying one to state happens only through a leader action (D2/D9). */
export type GuideAction =
  | { type: "introduce"; text: string }
  | { type: "announce_segment"; segmentKey: string; text: string }
  | { type: "ask_question"; text: string }
  | { type: "time_check"; minutesRemaining: number; text: string }
  | { type: "announce_break"; breakId: string; minutes: number; text: string }
  | { type: "launch_breakout"; breakoutId: string; text: string }
  | { type: "request_confirmation"; outputKeys: string[]; text: string }
  | { type: "summarize"; text: string; provenance: string[] }
  | { type: "recommend_recovery"; strategy: RecoveryStrategy; reason: string }
  | { type: "request_human_intervention"; reason: string }
  | { type: "pause"; reason: string };

/** Leader (screen-role) actions, plus the participant correction channel
 * (`park_issue` with source "participant" — an event + queue entry, never a
 * state mutation). Everything else is screen-gated in the DO. */
export type SpineAction =
  | { type: "start_session" }
  | { type: "pause_session"; reason?: string }
  | { type: "resume_session" }
  | { type: "advance_segment" }
  | { type: "backtrack_segment" }
  | { type: "skip_segment" }
  | { type: "repeat_segment" }
  | { type: "start_break" }
  | { type: "extend_break"; minutes: number }
  | { type: "end_break"; force?: boolean }
  | { type: "start_breakout" }
  | { type: "end_breakout" }
  | { type: "enter_human_led" }
  | { type: "return_to_ai_led" }
  | { type: "park_issue"; text: string; source: "leader" | "guide" | "participant"; aboutMessageId?: string }
  | { type: "mark_output"; outputKey: string }
  | { type: "decide_recommendation"; recommendationId: string; decision: "accepted" | "edited" | "dismissed" | "deferred"; editedText?: string }
  | { type: "end_session"; force?: boolean };

export interface TransitionContext {
  /** Wall-clock the caller injects (tests inject a fake clock). */
  now: number;
  /** Elapsed minutes in the current segment (from the segment clock). */
  elapsedSegmentMinutes: number;
  /** Observed counts for the current segment — the auto-audit inputs (D10). */
  submissionCount: number;
  voteCount: number;
  /** Minimum submissions the current segment's spec requires (from specFor). */
  minSubmissions: number;
}

export type TransitionResult =
  | { ok: true; runtime: SpineRuntime; events: SessionEvent[]; guideMessage?: GuideMessage }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Construction & serialization
// ---------------------------------------------------------------------------

function makeEvent(seq: number, now: number, kind: EventKind, actor: SessionEvent["actor"], summary: string, payload?: Record<string, unknown>): SessionEvent {
  return { id: crypto.randomUUID(), seq, at: new Date(now).toISOString(), kind, actor, summary, payload };
}

function appendEvent(rt: SpineRuntime, event: SessionEvent): void {
  rt.events.push(event);
  if (rt.events.length > MAX_EVENT_LOG_ENTRIES) {
    rt.events.splice(0, rt.events.length - MAX_EVENT_LOG_ENTRIES);
  }
}

export function createRuntimeState(plan: SessionPlan, now: number): SpineRuntime {
  const outputs: OutputStatus[] = [];
  const seen = new Set<string>();
  for (const seg of plan.segments) {
    for (const req of seg.requiredOutputs) {
      if (seen.has(req.key)) continue;
      seen.add(req.key);
      outputs.push({ key: req.key, segmentKey: req.segmentKey, title: req.title, kind: req.kind, required: req.required, status: "pending" });
    }
  }
  // Closing-only outputs (paranoia: validation already guarantees they are
  // produced by some segment, but never trust cross-checks twice).
  for (const req of plan.closing.requiredOutputs) {
    if (seen.has(req.key)) continue;
    seen.add(req.key);
    outputs.push({ key: req.key, segmentKey: req.segmentKey, title: req.title, kind: req.kind, required: req.required, status: "pending" });
  }
  const rt: SpineRuntime = {
    planId: plan.id,
    planVersion: plan.version,
    phase: "setup",
    phaseStartedAt: new Date(now).toISOString(),
    guideMode: "ai_led",
    segmentState: "active",
    currentSegmentIndex: 0,
    outputs,
    parkedIssues: [],
    recommendations: [],
    events: [],
    segmentActualMinutes: {},
    breakActualMinutes: {},
    lastDriftThresholdAnnounced: 0,
    voteCompletedAnnouncedFor: {},
  };
  appendEvent(rt, makeEvent(0, now, "system", "system", `Session plan loaded: ${plan.id} v${plan.version} (${plan.plannedMinutes} minutes)`));
  return rt;
}

/** Defensive restore: backfill fields added after earlier checkpoints so a
 * runtime written by an older build hydrates cleanly (same discipline as the
 * DO's normalizeState). Returns the input object when complete. */
export function normalizeRuntime(raw: unknown): SpineRuntime | null {
  if (!raw || typeof raw !== "object") return null;
  const rt = raw as SpineRuntime;
  if (typeof rt.planId !== "string" || typeof rt.phase !== "string") return null;
  rt.outputs ??= [];
  rt.parkedIssues ??= [];
  rt.recommendations ??= [];
  rt.events ??= [];
  rt.segmentActualMinutes ??= {};
  rt.breakActualMinutes ??= {};
  rt.lastDriftThresholdAnnounced ??= 0;
  rt.voteCompletedAnnouncedFor ??= {};
  rt.currentSegmentIndex ??= 0;
  return rt;
}

// ---------------------------------------------------------------------------
// Clock — build plan §5.2 "SessionClock". Pure arithmetic over the ledger.
// ---------------------------------------------------------------------------

export interface SessionClockState {
  plannedTotalMinutes: number;
  elapsedTotalMinutes: number;
  /** What the schedule says should be consumed by now (through the current
   * segment/break, planned values). */
  plannedThroughNowMinutes: number;
  /** Positive = behind schedule, negative = ahead. */
  driftMinutes: number;
  segmentElapsedMinutes: number;
  segmentPlannedMinutes: number;
  breakState?: { plannedMinutes: number; elapsedMinutes: number };
  breakoutState?: { plannedMinutes: number; elapsedMinutes: number };
  closingBufferMinutes: number;
  /** True when the remaining schedule fits inside the closing buffer. */
  closingPressure: boolean;
}

function minutesBetween(fromIso: string, now: number): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, (now - from) / 60_000);
}

export function computeClock(
  plan: SessionPlan,
  rt: SpineRuntime,
  opts: { now: number; segmentStartedAt: string; currentSegmentIndex: number },
): SessionClockState {
  const segment = plan.segments[Math.min(opts.currentSegmentIndex, plan.segments.length - 1)];

  let elapsedTotal = 0;
  for (const actual of Object.values(rt.segmentActualMinutes)) {
    elapsedTotal += actual;
  }
  let plannedThrough = 0;
  for (const seg of plan.segments) {
    if (seg.key in rt.segmentActualMinutes) plannedThrough += seg.plannedMinutes;
  }
  for (const [id, actual] of Object.entries(rt.breakActualMinutes)) {
    elapsedTotal += actual;
    const planned = plan.breaks.find((b) => b.id === id)?.plannedMinutes ?? 0;
    plannedThrough += planned;
  }

  // During a break the segment clock is frozen at break start — break time
  // is its own budget, never silently consumed from the next segment's
  // window. The DO restarts the segment clock at break end (fresh window
  // after re-entry), so this freeze only covers the break itself.
  const segElapsed =
    rt.phase === "break" && rt.breakState
      ? minutesBetween(opts.segmentStartedAt, Date.parse(rt.breakState.startedAt) || opts.now)
      : minutesBetween(opts.segmentStartedAt, opts.now);
  elapsedTotal += segElapsed;
  // "Planned consumed by now" counts the current segment only as far as its
  // clock has actually run — drift is an instant-by-instant comparison
  // against the schedule, not a running overrun tally (that tally lives in
  // cumulativeOverrunMinutes and feeds PACER's budget).
  plannedThrough += Math.min(segElapsed, segment.plannedMinutes);

  let breakState: SessionClockState["breakState"];
  if (rt.phase === "break" && rt.breakState) {
    const breakElapsed = minutesBetween(rt.breakState.startedAt, opts.now);
    const breakBudget = rt.breakState.plannedMinutes + rt.breakState.extraMinutes;
    elapsedTotal += breakElapsed;
    plannedThrough += Math.min(breakElapsed, breakBudget);
    breakState = { plannedMinutes: breakBudget, elapsedMinutes: breakElapsed };
  }

  let breakoutState: SessionClockState["breakoutState"];
  if (rt.phase === "breakout" && rt.breakoutState) {
    const breakoutElapsed = minutesBetween(rt.breakoutState.startedAt, opts.now);
    breakoutState = { plannedMinutes: rt.breakoutState.durationMinutes, elapsedMinutes: breakoutElapsed };
  }

  const remainingPlanned = Math.max(0, plan.plannedMinutes - plannedThrough);
  return {
    plannedTotalMinutes: plan.plannedMinutes,
    elapsedTotalMinutes: Math.round(elapsedTotal * 10) / 10,
    plannedThroughNowMinutes: plannedThrough,
    driftMinutes: Math.round((elapsedTotal - plannedThrough) * 10) / 10,
    segmentElapsedMinutes: Math.round(segElapsed * 10) / 10,
    segmentPlannedMinutes: segment.plannedMinutes,
    breakState,
    breakoutState,
    closingBufferMinutes: plan.closing.bufferMinutes,
    closingPressure: remainingPlanned <= plan.closing.bufferMinutes,
  };
}

/** Cumulative positive overrun of completed segments — PACER's budget input
 * so an extend decision can never quietly consume the next segment's time. */
export function cumulativeOverrunMinutes(rt: SpineRuntime, plan: SessionPlan): number {
  let overrun = 0;
  for (const [key, actual] of Object.entries(rt.segmentActualMinutes)) {
    const planned = plan.segments.find((s) => s.key === key)?.plannedMinutes ?? 0;
    overrun += Math.max(0, actual - planned);
  }
  for (const [id, actual] of Object.entries(rt.breakActualMinutes)) {
    const spec = plan.breaks.find((b) => b.id === id);
    if (!spec) continue;
    overrun += Math.max(0, actual - (spec.plannedMinutes + (rt.breakState?.breakId === id ? rt.breakState.extraMinutes : 0)));
  }
  return Math.round(overrun * 10) / 10;
}

// ---------------------------------------------------------------------------
// Output audit & closing gate
// ---------------------------------------------------------------------------

export interface OutputAudit {
  complete: string[];
  missing: string[];
  skipped: string[];
}

export function auditOutputs(rt: SpineRuntime): OutputAudit {
  const complete: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  for (const o of rt.outputs) {
    if (o.status === "complete") complete.push(o.key);
    else if (o.status === "skipped") skipped.push(o.key);
    else if (o.required) missing.push(o.key);
  }
  return { complete, missing, skipped };
}

function markSegmentOutputs(rt: SpineRuntime, segmentKey: string, status: OutputState, ctx: TransitionContext, plan: SessionPlan, now: number, events: SessionEvent[]): void {
  const seg = plan.segments.find((s) => s.key === segmentKey);
  if (!seg) return;
  for (const req of seg.requiredOutputs) {
    const out = rt.outputs.find((o) => o.key === req.key);
    if (!out || out.status === "complete") continue;
    // D10: statement outputs auto-complete on reaching the submission floor;
    // ranking outputs auto-complete at >= 2 recorded votes; the leader marks
    // owners/actions/cadence by hand (human judgment stays human, L6).
    let autoComplete = false;
    if (req.kind === "statement") autoComplete = ctx.submissionCount >= Math.max(1, ctx.minSubmissions);
    else if (req.kind === "ranking") autoComplete = ctx.voteCount >= 2;
    const nextStatus: OutputState = status === "skipped" ? "skipped" : autoComplete ? "complete" : "pending";
    if (out.status !== nextStatus) {
      out.status = nextStatus;
      if (nextStatus === "complete") {
        out.completedAt = new Date(now).toISOString();
        out.by = "auto";
        events.push(makeEvent(0, now, "output", "system", `Output "${req.key}" met its completion rule on segment close`, { outputKey: req.key }));
      } else if (nextStatus === "skipped") {
        events.push(makeEvent(0, now, "output", "leader", `Output "${req.key}" marked skipped (segment skipped)`, { outputKey: req.key }));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

const DECISIONS: RecommendationEntry["status"][] = ["accepted", "edited", "dismissed", "deferred"];

function currentBreakAnchor(plan: SessionPlan, currentSegmentIndex: number): string | undefined {
  // A break lives at a segment BOUNDARY: it may be taken right after the
  // leader advanced past its anchor (idx-1 is the anchor) or just before
  // advancing the anchor itself (idx is the anchor). Both orderings are
  // legitimate leader behavior; the anchor key decides, not the clock.
  const before = plan.segments[currentSegmentIndex - 1]?.key;
  const here = plan.segments[currentSegmentIndex]?.key;
  return plan.breaks.find((b) => b.afterSegmentKey === before || b.afterSegmentKey === here)?.id;
}

function currentBreakoutFor(plan: SessionPlan, currentSegmentIndex: number) {
  const key = plan.segments[currentSegmentIndex]?.key;
  return plan.breakouts.find((b) => b.appliesToSegmentKey === key);
}

/**
 * Apply one leader/participant action to the runtime. Pure: mutates and
 * returns the runtime copy-semantically (the caller owns persistence and
 * broadcast). Rejections carry a concrete reason the console can show.
 */
export function applyAction(plan: SessionPlan, rt: SpineRuntime, action: SpineAction, ctx: TransitionContext): TransitionResult {
  const events: SessionEvent[] = [];
  const nextSeq = rt.events.length > 0 ? rt.events[rt.events.length - 1].seq + 1 : 0;
  // Every event goes into BOTH the returned list (for the caller's response)
  // and the runtime's persistent log — the log is the audit trail, so it is
  // written here, never left to the caller's discipline.
  const mk = (kind: EventKind, actor: SessionEvent["actor"], summary: string, payload?: Record<string, unknown>) => {
    const ev = makeEvent(nextSeq + events.length, ctx.now, kind, actor, summary, payload);
    events.push(ev);
    rt.events.push(ev);
    if (rt.events.length > MAX_EVENT_LOG_ENTRIES) rt.events.splice(0, rt.events.length - MAX_EVENT_LOG_ENTRIES);
    return ev;
  };
  const reject = (reason: string): TransitionResult => ({ ok: false, reason });
  const at = new Date(ctx.now).toISOString();

  const currentIndex = rt.currentSegmentIndex;

  switch (action.type) {
    case "start_session": {
      if (rt.phase !== "setup") return reject(`cannot start from phase "${rt.phase}"`);
      rt.phase = plan.segments.length > 0 ? "active" : "setup";
      rt.phaseStartedAt = at;
      rt.segmentState = "active";
      events.push(mk("phase", "leader", "Session started — welcome segment live"));
      return { ok: true, runtime: rt, events };
    }

    case "pause_session": {
      if (rt.phase === "complete" || rt.guideMode === "paused") return reject("session is already paused or complete");
      rt.guideMode = "paused";
      events.push(mk("phase", "leader", action.reason ? `Guide paused: ${action.reason}` : "Guide paused"));
      return { ok: true, runtime: rt, events };
    }

    case "resume_session": {
      if (rt.guideMode !== "paused") return reject("session is not paused");
      rt.guideMode = rt.phase === "recovery" ? "human_led" : "ai_led";
      events.push(mk("phase", "leader", "Guide resumed"));
      return { ok: true, runtime: rt, events };
    }

    case "advance_segment": {
      if (rt.phase === "setup") return reject("start the session before advancing");
      if (rt.phase === "break") return reject("end the break before advancing");
      if (rt.phase === "complete") return reject("session is complete");
      const idx = currentIndex;
      const key = plan.segments[idx]?.key;
      if (!key) return reject("no current segment");
      if (idx >= plan.segments.length - 1) return reject("final segment — close the session with end_session");
      rt.segmentActualMinutes[key] = Math.round(ctx.elapsedSegmentMinutes * 10) / 10;
      markSegmentOutputs(rt, key, "complete", ctx, plan, ctx.now, events);
      events.push(mk("segment", "leader", `Segment "${key}" closed after ${rt.segmentActualMinutes[key]} min`, { segmentKey: key, actualMinutes: rt.segmentActualMinutes[key] }));
      rt.segmentState = "active";
      rt.currentSegmentIndex = idx + 1;
      rt.phase = rt.currentSegmentIndex >= plan.segments.length - 1 ? "closing" : "active";
      rt.phaseStartedAt = at;
      return { ok: true, runtime: rt, events };
    }

    case "backtrack_segment": {
      if (rt.phase === "setup" || rt.phase === "complete") return reject(`cannot backtrack from phase "${rt.phase}"`);
      if (rt.phase === "break") return reject("end the break before backtracking");
      const idx = currentIndex;
      if (idx <= 0) return reject("already at the first segment");
      rt.currentSegmentIndex = idx - 1;
      rt.phase = "reentry";
      rt.phaseStartedAt = at;
      events.push(mk("segment", "leader", `Backtracked to segment "${plan.segments[idx - 1].key}"`));
      return { ok: true, runtime: rt, events };
    }

    case "skip_segment": {
      if (rt.phase !== "active" && rt.phase !== "breakout" && rt.phase !== "closing" && rt.phase !== "reentry") {
        return reject(`cannot skip from phase "${rt.phase}"`);
      }
      const idx = currentIndex;
      const key = plan.segments[idx]?.key;
      if (!key) return reject("no current segment");
      if (idx >= plan.segments.length - 1) return reject("final segment cannot be skipped — close the session instead");
      rt.segmentState = "skipped";
      markSegmentOutputs(rt, key, "skipped", ctx, plan, ctx.now, events);
      rt.segmentActualMinutes[key] = Math.round(ctx.elapsedSegmentMinutes * 10) / 10;
      events.push(mk("segment", "leader", `Segment "${key}" skipped by the leader`, { segmentKey: key }));
      rt.segmentState = "active";
      rt.currentSegmentIndex = idx + 1;
      rt.phase = rt.currentSegmentIndex >= plan.segments.length - 1 ? "closing" : "active";
      rt.phaseStartedAt = at;
      return { ok: true, runtime: rt, events };
    }

    case "repeat_segment": {
      if (rt.phase !== "active" && rt.phase !== "breakout" && rt.phase !== "closing" && rt.phase !== "reentry") {
        return reject(`cannot repeat from phase "${rt.phase}"`);
      }
      const idx = currentIndex;
      const key = plan.segments[idx]?.key;
      if (!key) return reject("no current segment");
      events.push(mk("segment", "leader", `Segment "${key}" restarted — clock reset, prior input kept`, { segmentKey: key }));
      return { ok: true, runtime: rt, events };
    }

    case "start_break": {
      if (rt.phase !== "active" && rt.phase !== "closing") return reject(`cannot start a break from phase "${rt.phase}"`);
      const breakId = currentBreakAnchor(plan, currentIndex);
      if (!breakId) return reject("no break is scheduled after this segment");
      const spec = plan.breaks.find((b) => b.id === breakId)!;
      rt.phase = "break";
      rt.phaseStartedAt = at;
      rt.breakState = { breakId, startedAt: at, plannedMinutes: spec.plannedMinutes, minimumMinutes: spec.minimumMinutes, extraMinutes: 0 };
      events.push(mk("break", "leader", `Break "${breakId}" started (${spec.plannedMinutes} min, minimum ${spec.minimumMinutes})`, { breakId }));
      return {
        ok: true,
        runtime: rt,
        events,
        guideMessage: guideSpeech("announcement", `Time for our break — ${spec.plannedMinutes} minutes. We resume right after.`, plan.segments[currentIndex].key, `break ${breakId} begins`),
      };
    }

    case "extend_break": {
      if (rt.phase !== "break" || !rt.breakState) return reject("no break is running");
      if (!Number.isInteger(action.minutes) || action.minutes <= 0 || action.minutes > 60) {
        return reject("extension must be a positive whole number of minutes (1-60)");
      }
      rt.breakState.extraMinutes += action.minutes;
      events.push(mk("break", "leader", `Break "${rt.breakState.breakId}" extended by ${action.minutes} min`, { breakId: rt.breakState.breakId, minutes: action.minutes }));
      return { ok: true, runtime: rt, events };
    }

    case "end_break": {
      if (rt.phase !== "break" || !rt.breakState) return reject("no break is running");
      const elapsed = minutesBetween(rt.breakState.startedAt, ctx.now);
      if (elapsed < rt.breakState.minimumMinutes && !action.force) {
        return reject(`protected minimum break: ${Math.floor(elapsed)} of ${rt.breakState.minimumMinutes} min taken — extend it or end with force`);
      }
      rt.breakActualMinutes[rt.breakState.breakId] = Math.round(elapsed * 10) / 10;
      if (action.force && elapsed < rt.breakState.minimumMinutes) {
        events.push(mk("override", "leader", `Break "${rt.breakState.breakId}" ended early by leader override at ${Math.floor(elapsed)} min (minimum ${rt.breakState.minimumMinutes})`, { breakId: rt.breakState.breakId }));
      } else {
        events.push(mk("break", "leader", `Break "${rt.breakState.breakId}" ended after ${Math.floor(elapsed)} min`, { breakId: rt.breakState.breakId }));
      }
      const breakSpec = plan.breaks.find((b) => b.id === rt.breakState!.breakId);
      rt.breakState = undefined;
      // Re-entry is a transient posture, not a lingering state: the room is
      // back and the next segment's clock starts now (the DO refreshes
      // segmentStartedAt for exactly this moment).
      rt.phase = "active";
      rt.phaseStartedAt = at;
      return {
        ok: true,
        runtime: rt,
        events,
        guideMessage: breakSpec
          ? guideSpeech("announcement", breakSpec.reentryPrompt, plan.segments[currentIndex].key, "back from break")
          : undefined,
      };
    }

    case "start_breakout": {
      if (rt.phase !== "active" && rt.phase !== "closing") return reject(`cannot start a breakout from phase "${rt.phase}"`);
      const bo = currentBreakoutFor(plan, currentIndex);
      if (!bo) return reject("no breakout is configured for this segment");
      rt.phase = "breakout";
      rt.phaseStartedAt = at;
      rt.breakoutState = { breakoutId: bo.id, startedAt: at, durationMinutes: bo.durationMinutes };
      events.push(mk("breakout", "leader", `Breakout "${bo.id}" launched (${bo.durationMinutes} min, report-back ${bo.reportBackMinutes})`, { breakoutId: bo.id }));
      return {
        ok: true,
        runtime: rt,
        events,
        guideMessage: guideSpeech("announcement", `${bo.purpose} Groups work for ${bo.durationMinutes} minutes, then report back.`, plan.segments[currentIndex].key, `breakout ${bo.id}`),
      };
    }

    case "end_breakout": {
      if (rt.phase !== "breakout" || !rt.breakoutState) return reject("no breakout is running");
      const bo = plan.breakouts.find((b) => b.id === rt.breakoutState!.breakoutId);
      events.push(mk("breakout", "leader", `Breakout "${rt.breakoutState.breakoutId}" closed — report-back${bo ? ` (${bo.reportBackMinutes} min)` : ""} begins`, { breakoutId: rt.breakoutState.breakoutId }));
      rt.breakoutState = undefined;
      rt.phase = rt.currentSegmentIndex >= plan.segments.length - 1 ? "closing" : "active";
      rt.phaseStartedAt = at;
      return { ok: true, runtime: rt, events };
    }

    case "enter_human_led": {
      if (rt.phase === "setup" || rt.phase === "complete") return reject(`cannot enter human-led mode from phase "${rt.phase}"`);
      rt.phase = "recovery";
      rt.guideMode = "human_led";
      rt.phaseStartedAt = at;
      events.push(mk("phase", "leader", "Human-led mode — the Guide stands down until recalled"));
      return { ok: true, runtime: rt, events };
    }

    case "return_to_ai_led": {
      if (rt.phase !== "recovery") return reject("not in human-led mode");
      rt.phase = rt.currentSegmentIndex >= plan.segments.length - 1 ? "closing" : "active";
      rt.guideMode = "ai_led";
      rt.phaseStartedAt = at;
      events.push(mk("phase", "leader", "AI-led mode restored"));
      return { ok: true, runtime: rt, events };
    }

    case "park_issue": {
      const text = action.text.trim();
      if (!text) return reject("parked issue text is empty");
      if (text.length > 500) return reject("parked issue text is over the 500-character limit");
      rt.parkedIssues.push({ id: crypto.randomUUID(), text, source: action.source, aboutMessageId: action.aboutMessageId, createdAt: at });
      const actor: SessionEvent["actor"] = action.source === "participant" ? "participant:phone" : action.source;
      events.push(mk("feedback", actor, action.source === "participant" ? `Participant correction parked: "${text.slice(0, 80)}"` : `Issue parked: "${text.slice(0, 80)}"`, { source: action.source }));
      return { ok: true, runtime: rt, events };
    }

    case "mark_output": {
      const out = rt.outputs.find((o) => o.key === action.outputKey);
      if (!out) return reject(`unknown output "${action.outputKey}"`);
      if (out.status === "complete") return reject(`output "${action.outputKey}" is already complete`);
      out.status = "complete";
      out.completedAt = at;
      out.by = "leader";
      events.push(mk("output", "leader", `Output "${out.title}" confirmed complete by the leader`, { outputKey: out.key }));
      return { ok: true, runtime: rt, events };
    }

    case "decide_recommendation": {
      if (!DECISIONS.includes(action.decision)) return reject(`invalid recommendation decision "${action.decision}"`);
      const rec = rt.recommendations.find((r) => r.id === action.recommendationId);
      if (!rec) return reject(`unknown recommendation "${action.recommendationId}"`);
      if (rec.status !== "pending") return reject(`recommendation already decided (${rec.status})`);
      rec.status = action.decision;
      rec.decidedAt = at;
      rec.decidedBy = "leader";
      if (action.decision === "edited" && action.editedText) rec.editedText = action.editedText;
      events.push(mk("recommendation", "leader", `Recommendation ${action.decision}: ${rec.action.type}`, { recommendationId: rec.id, decision: action.decision }));
      return { ok: true, runtime: rt, events };
    }

    case "end_session": {
      if (rt.phase !== "active" && rt.phase !== "closing" && rt.phase !== "breakout" && rt.phase !== "reentry" && rt.phase !== "recovery") {
        return reject(`cannot end the session from phase "${rt.phase}" — end the break first`);
      }
      const audit = auditOutputs(rt);
      if (audit.missing.length > 0 && !action.force) {
        return reject(
          `cannot complete: ${audit.missing.length} required output${audit.missing.length === 1 ? "" : "s"} missing (${audit.missing.join(", ")}) — complete them, park them, or end with force`,
        );
      }
      rt.phase = "complete";
      rt.phaseStartedAt = at;
      if (audit.missing.length > 0) {
        rt.completedWithMissingOutputs = true;
        events.push(mk("override", "leader", `Session closed WITH ${audit.missing.length} missing required output(s): ${audit.missing.join(", ")}`, { missing: audit.missing }));
      } else {
        events.push(mk("phase", "leader", "Session closed — all required outputs accounted for"));
      }
      return { ok: true, runtime: rt, events };
    }

    default:
      return reject("unknown action");
  }
}

// ---------------------------------------------------------------------------
// Deterministic spine recommendations (the alarm tick's speech, L5-deduped)
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLDS = [15, 30, 60] as const;

export interface SpineTickResult {
  runtime: SpineRuntime;
  guideMessages: GuideMessage[];
  recommendations: RecommendationEntry[];
}

function guideSpeech(kind: GuideMessageKind, text: string, segmentKey: string, detail?: string): GuideMessage {
  return { id: crypto.randomUUID(), kind, text, segmentKey, detail, createdAt: new Date().toISOString() };
}

/**
 * The spine's own deterministic voice: drift thresholds, break running long,
 * closing pressure. Speech only — never a transition (D2/D7). Idempotent per
 * condition: each threshold and each break-overdue notice says it once.
 */
export function spineTick(
  rt: SpineRuntime,
  clock: SessionClockState,
  segmentKey: string,
): SpineTickResult {
  const guideMessages: GuideMessage[] = [];
  const recommendations: RecommendationEntry[] = [];
  const now = Date.now();

  // Drift thresholds — announce each level once.
  for (const threshold of DRIFT_THRESHOLDS) {
    if (clock.driftMinutes >= threshold && rt.lastDriftThresholdAnnounced < threshold) {
      rt.lastDriftThresholdAnnounced = threshold;
      const rec: RecommendationEntry = {
        id: crypto.randomUUID(),
        action: {
          type: "time_check",
          minutesRemaining: Math.max(0, Math.round(clock.plannedTotalMinutes - clock.elapsedTotalMinutes)),
          text: `We are ${Math.round(clock.driftMinutes)} minutes behind the plan. I recommend compressing the next segment so the closing commitments keep their time.`,
        },
        reason: `schedule drift reached ${threshold} minutes`,
        status: "pending",
      };
      recommendations.push(rec);
      rt.recommendations.push(rec);
      guideMessages.push(
        guideSpeech("time_check", rec.action.type === "time_check" ? rec.action.text : "", segmentKey, `drift ${Math.round(clock.driftMinutes)} min`),
      );
      rt.events.push(makeEvent(rt.events.length, now, "guide_message", "guide", `Drift notice at ${threshold}+ minutes`, { drift: Math.round(clock.driftMinutes) }));
      break; // one threshold per tick
    }
  }

  // Break running long — speak once per running break.
  if (rt.phase === "break" && rt.breakState) {
    const elapsed = clock.breakState?.elapsedMinutes ?? 0;
    const budget = rt.breakState.plannedMinutes + rt.breakState.extraMinutes;
    if (elapsed > budget && rt.breakActualMinutes[rt.breakState.breakId] === undefined && !rt.voteCompletedAnnouncedFor[`breakover:${rt.breakState.breakId}`]) {
      rt.voteCompletedAnnouncedFor[`breakover:${rt.breakState.breakId}`] = true;
      guideMessages.push(
        guideSpeech("announcement", "The break has run its planned time — we can resume whenever you are ready.", segmentKey, `break ${rt.breakState.breakId} over by ${Math.round(elapsed - budget)} min`),
      );
      rt.events.push(makeEvent(rt.events.length, now, "guide_message", "guide", "Break-over notice", { breakId: rt.breakState.breakId }));
    }
  }

  // Closing pressure — protect the buffer.
  if (clock.closingPressure && rt.phase !== "complete" && !rt.recommendations.some((r) => r.reason === "closing buffer protection" && r.status === "pending")) {
    const rec: RecommendationEntry = {
      id: crypto.randomUUID(),
      action: { type: "request_confirmation", outputKeys: auditOutputs(rt).missing, text: "We are inside the closing buffer. Let's confirm what is still missing so the close stays protected." },
      reason: "closing buffer protection",
      status: "pending",
    };
    recommendations.push(rec);
    rt.recommendations.push(rec);
    guideMessages.push(guideSpeech("time_check", rec.action.type === "request_confirmation" ? rec.action.text : "", segmentKey, "closing buffer"));
    rt.events.push(makeEvent(rt.events.length, now, "guide_message", "guide", "Closing-buffer notice", {}));
  }

  return { runtime: rt, guideMessages, recommendations };
}

/** Vote-quorum detection (D3 review fix): vote_completed is observable when
 * every connected phone has voted. Returns true only when quorum is newly
 * reached (caller dedupes per segment via voteCompletedAnnouncedFor). */
export function voteQuorumReached(rt: SpineRuntime, segmentKey: string, voteCount: number, connectedPhones: number): boolean {
  if (connectedPhones <= 0) return false;
  if (voteCount < connectedPhones) return false;
  return rt.voteCompletedAnnouncedFor[segmentKey] !== true;
}

export function markVoteAnnounced(rt: SpineRuntime, segmentKey: string): void {
  rt.voteCompletedAnnouncedFor[segmentKey] = true;
}
