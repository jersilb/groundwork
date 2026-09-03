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

## 2026-08-31 — Shipped: session spine + console + phone Guide (a216f37)
- Shipped the full Release-0/1 spine batch: session-plan.ts, session-runtime.ts, DO wiring behind SESSION_SPINE flag, InstructorConsole.tsx, GuideIntroCard + GuideCorrection on phone.
- Key semantics decided: break anchors to boundary AFTER a completed segment; next segment's clock does not run during break; planned consumed = completed planned + min(current elapsed, current planned).
- Added server-side action-id dedupe (replay double-advance attack) and only surface correction affordance on spine sessions.
- stateVersion must bump on every spine mutation — caught by integration smoke, would have broken client convergence + D1 checkpoints.
- Pushed to claude/subagent-team-build-plan-s2getk (a216f37). Deploy pending: needs SESSION_SPINE=true in env for spine features.

## 2026-08-31 — Spine batch committed and deployed (a216f37 → db04bf2)
- Commit a216f37: session spine (plan + pure runtime), DO wiring behind SESSION_SPINE with action-id dedupe and stateVersion bumps, React instructor console, phone Guide identity + correction, four new test gates in CI (31 files, +3862).
- Commit db04bf2: decisions log entry.
- Deployed via wrangler (Version 2b480ad7): root 200, /console/:key 200, /session/:key 200 on groundwork.jersilb.workers.dev.
- Remaining from build plan: BreakSpec/BreakoutSpec (Release 2), full-session degraded-mode replay beyond the simulation harness.

## 2026-09-02 — P0 spine keys + console bridge
- Aligned `_demo` YAML keys to hyphenated spine keys; regenerated demo-segment-specs.
- Bridged LLM guideLog kinds into runtime.recommendations for the instructor console.
- Left SESSION_SPINE unset. EVALUATOR remasure: precision 1.000 (gate PASS).
- Scorecard: OUTPUTS/p0-spine-keys-scorecard-2026-09-02.md

