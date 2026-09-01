import type { SessionPlan, SessionState, SpineRuntime } from "./types";

// Client-side mirror of the server's SessionClock arithmetic
// (src/session-runtime.ts computeClock). The console and phone render the
// same numbers the runtime computes, from the same inputs: the plan, the
// runtime ledger, the segment clock, and now.

export interface ClockView {
  plannedTotalMinutes: number;
  elapsedTotalMinutes: number;
  driftMinutes: number;
  segmentElapsedMinutes: number;
  segmentPlannedMinutes: number;
  remainingMinutes: number;
  breakElapsedMinutes?: number;
  breakBudgetMinutes?: number;
  breakoutElapsedMinutes?: number;
  breakoutBudgetMinutes?: number;
  closingPressure: boolean;
  closingBufferMinutes: number;
}

function minutesBetween(fromMs: number, nowMs: number): number {
  if (Number.isNaN(fromMs)) return 0;
  return Math.max(0, (nowMs - fromMs) / 60_000);
}

export function computeClockView(plan: SessionPlan, state: SessionState, rt: SpineRuntime, now: number): ClockView {
  const segment = plan.segments[Math.min(state.currentSegmentIndex, plan.segments.length - 1)];

  let elapsedTotal = 0;
  for (const actual of Object.values(rt.segmentActualMinutes)) elapsedTotal += actual;
  let plannedThrough = 0;
  for (const seg of plan.segments) {
    if (seg.key in rt.segmentActualMinutes) plannedThrough += seg.plannedMinutes;
  }
  for (const [id, actual] of Object.entries(rt.breakActualMinutes)) {
    elapsedTotal += actual;
    plannedThrough += plan.breaks.find((b) => b.id === id)?.plannedMinutes ?? 0;
  }

  const startedMs = Date.parse(state.segmentStartedAt ?? state.startedAt);
  const segElapsed =
    rt.phase === "break" && rt.breakState
      ? minutesBetween(startedMs, Date.parse(rt.breakState.startedAt))
      : minutesBetween(startedMs, now);
  elapsedTotal += segElapsed;
  plannedThrough += Math.min(segElapsed, segment.plannedMinutes);

  let breakElapsed: number | undefined;
  let breakBudget: number | undefined;
  if (rt.phase === "break" && rt.breakState) {
    breakElapsed = minutesBetween(Date.parse(rt.breakState.startedAt), now);
    breakBudget = rt.breakState.plannedMinutes + rt.breakState.extraMinutes;
    elapsedTotal += breakElapsed;
    plannedThrough += Math.min(breakElapsed, breakBudget);
  }

  let breakoutElapsed: number | undefined;
  let breakoutBudget: number | undefined;
  if (rt.phase === "breakout" && rt.breakoutState) {
    breakoutElapsed = minutesBetween(Date.parse(rt.breakoutState.startedAt), now);
    breakoutBudget = rt.breakoutState.durationMinutes;
  }

  const r = (v: number) => Math.round(v * 10) / 10;
  const remainingPlanned = Math.max(0, plan.plannedMinutes - plannedThrough);
  return {
    plannedTotalMinutes: plan.plannedMinutes,
    elapsedTotalMinutes: r(elapsedTotal),
    driftMinutes: r(elapsedTotal - plannedThrough),
    segmentElapsedMinutes: r(segElapsed),
    segmentPlannedMinutes: segment.plannedMinutes,
    remainingMinutes: r(remainingPlanned),
    breakElapsedMinutes: breakElapsed !== undefined ? r(breakElapsed) : undefined,
    breakBudgetMinutes: breakBudget,
    breakoutElapsedMinutes: breakoutElapsed !== undefined ? r(breakoutElapsed) : undefined,
    breakoutBudgetMinutes: breakoutBudget,
    closingPressure: remainingPlanned <= plan.closing.bufferMinutes,
    closingBufferMinutes: plan.closing.bufferMinutes,
  };
}

/** mm:ss / h:mm formatting for the clock ribbon. */
export function formatClock(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}:${String(rem).padStart(2, "0")}` : `${rem}:00`;
}

/** Cumulative planned start time of each segment, for the itinerary rows. */
export function itineraryStartMinutes(plan: SessionPlan): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const seg of plan.segments) {
    starts.push(t);
    t += seg.plannedMinutes;
    const brk = plan.breaks.find((b) => b.afterSegmentKey === seg.key);
    if (brk) t += brk.plannedMinutes;
  }
  return starts;
}
