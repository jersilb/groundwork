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
