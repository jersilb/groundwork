# DECISIONS — AI Instructor Program (campaign log)

Canonical project decision history remains `docs/decisions.md` (append-only, L3).
This file mirrors the campaign-scoped calls the director makes between repo-level entries.

- **D1 (2026-08-28)**: New campaign over the existing diamond graph — 4 new role cards
  (instructor-ux-designer, session-orchestrator-engineer, instructor-runtime-engineer,
  reliability-rehearsal-engineer); existing nodes reused. No competing orchestrator.
- **D2 (2026-08-28)**: §5.5 coexistence rule — the Guide may speak (typed GuideActions);
  every state transition needs a human action or a curriculum-defined deterministic trigger.
- **D3 (2026-08-28)**: Per-task model tiers via smart-model; hard-rule override to Expert for
  consent, screen-token auth, checkpoint recovery.
- **D4 (2026-08-28)**: Console extends the existing Fraunces/Sora planning-room tokens; voice
  deferred until R4 exit.
- **D5 (2026-08-28)**: Fallback execution — no subagent-spawning tool in this session, so the
  director executes Wave-1 briefs sequentially under each role card; team ships as dispatchable
  `.claude/agents/` definitions for the next autonomous run.
- **D6 (2026-08-28, spine)**: SessionPlan/SegmentPlan/Break/Breakout/Closing schemas live in
  `src/session-plan.ts`; the runtime (state machine, clock, break lifecycle, output audit, event
  log, recommendation queue) is PURE in `src/session-runtime.ts`; the SessionDO owns I/O only.
  Extension vs §5.1: BreakSpec AND BreakoutSpec both anchor to a segment key, and a breakout is
  the small-group delivery mode INSIDE its segment's time window (keeps the 315+45=360-min
  reference itinerary exact and the clock arithmetic single-source).
- **D7 (2026-08-28, §5.5 coexistence)**: Break end requires a leader action. Below a break's
  `minimumMinutes`, `end_break` is rejected unless `{force:true}` is supplied (recorded as an
  override event). Break overdue produces Guide SPEECH only — never an automatic transition.
  Session completion with missing required outputs is likewise rejected without `{force:true}`
  and recorded as `completed_with_missing_outputs` when forced.
- **D8 (2026-08-28, state compat)**: Spine runtime rides inside `SessionState.runtime?` (all
  optional, backfilled by normalizeState) so pre-spine checkpoints, the fake lab, and every
  existing client keep working unchanged; `SESSION_SPINE=true` env switches new sessions to the
  reference six-hour plan.
- **D9 (2026-08-28, recommendation queue)**: accept/edit/dismiss records the leader's DECISION on
  a queued GuideAction; state changes still happen only through the explicit action buttons.
  Speaking and deciding stay separate from mutating (extends D2).
- **D10 (2026-08-28, output audit rules)**: statement outputs auto-complete when the producing
  segment's submissions reach its minimum at advance time; ranking outputs auto-complete at ≥2
  recorded votes; owners/actions/cadence require the leader's `mark_output` (human judgment per
  L6). Closing gate blocks silent completion on any incomplete required output.
- **D11 (2026-08-28, break semantics)**: A break lives at a segment BOUNDARY (anchor matches
  the segment just completed OR the current one, so the leader may break before or after
  advancing). During a break the segment clock is frozen at break start; break end restarts
  the segment clock (fresh window after re-entry) and re-entry is transient, not a lingering
  phase. The re-entry prompt speaks at break END, the break announcement at start.
- **D12 (2026-08-28, drift definition)**: Drift is instant-by-instant: planned consumed =
  completed planned + min(current elapsed, current planned) + min(break elapsed, break budget).
  The cumulative-overrun tally (completed actual − planned) is a separate ledger that feeds
  PACER's remaining-budget fix. The two answer different questions and must not be conflated.
- **D13 (2026-08-28, one-shot dedupe)**: Every console action carries a fresh `actionId`; the
  DO stores `runtime.lastAppliedActionId` and replays of the same id are acked with current
  state instead of re-executed. Closes the reconnect-replay double-advance hole for spine
  sessions (legacy advance path keeps its existing behavior; noted as pre-existing debt).
