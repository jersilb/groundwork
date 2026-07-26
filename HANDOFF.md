# HANDOFF — Groundwork

**Instructions**: Fill this in before pasting it into Claude Code at the start of any manual session. Keep it under 1,500 tokens.

---

## Date & Session Context

**Date**: 2026-07-26
**Time available**: —
**Session goal**: Phase 0 scaffold complete and gate-verified. Next session's goal: TBD by Jeremy.

---

## What Happened Since Last Session

- The `async-agent-graph-engineering` skill was missing from this environment. Jeremy supplied it as a zip; it's now installed at `~/.claude/skills/async-agent-graph-engineering/`.
- The 15-agent build team was designed and committed before this scaffold (`docs/agent-team.md`, `.claude/agents/`).

---

## Decisions Already Made (Treat as Settled)

- Project scaffold lives at **repo root**, not `PROJECTS/groundwork/` — this repo is already dedicated to Groundwork.
- Build-phase budget ceiling: **$200/mo soft cap**.
- Status reporting: **`OUTPUTS/` files, event-driven only** — no Gmail, no weekly cadence.
- No live Cloudflare resources get created without Jeremy present — Phase 0 is local-only.
- "Groundwork" is a placeholder name pending Jeremy's trademark search (§2.4).

---

## Open Questions for the AI

- None currently open. Next: confirm Phase 0 gate passed, then get Jeremy's go-ahead for Phase 1.

---

## Constraints for This Session

- Files or areas off-limits: `docs/source-principles.md` — only Jeremy fills this in.
- Budget ceiling: $200/mo (build phase), see `docs/economics.md`.
- Do not create real Cloudflare D1/R2/KV resources under Jeremy's account without him present.

---

## After This Session, AI Should (Autonomous Follow-Up)

- Nothing autonomous yet — build phase is manual-session-driven until Jeremy runs `agentic-loop-setup`, if he chooses to.

---

*AI: acknowledge this handoff, confirm the session goal, check `DASHBOARD.md` for current status, then proceed.*
