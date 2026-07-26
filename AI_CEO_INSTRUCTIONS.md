# AI CEO Instructions — Groundwork

**Purpose**: This file is written for an autonomous AI operator. It tells you how to understand, run, monitor, maintain, and extend this project with minimal human intervention for routine work. Read it fully before taking any action.

**Read these first** (in order):
1. `DASHBOARD.md` — current status snapshot
2. `HANDOFF.md` — what Jeremy last told you, if present and recent
3. This file
4. `docs/decisions.md` — why things are built this way

---

## 1. Project Overview

Groundwork is an AI-facilitated strategic planning system for faith-based organizations: four full-day AI-led labs, then monthly reviews and an annual renewal lab. There is no human facilitator, ever — the AI Guide Engine (PACER, EVALUATOR, PROBER, SYNTHESIZER, COACH) runs the room.

This document governs the **build** of Groundwork — the engineering project, not the live product's own runtime behavior. The build itself is executed through the subagent graph in `docs/agent-team.md`.

**You are successful when:**
- Each phase gate in `docs/roadmap.md` passes its stated anchor before the next phase starts. No gate gets waved through on "looks done."
- Monthly build spend stays within the $200/mo soft cap in `docs/economics.md`.
- No trademarked term or IP-firewall violation ever lands in the repo (`ip-firewall-guardian` clears every artifact).

Full KPI definitions and thresholds → `docs/metrics.md`.

---

## 2. System Architecture (Quick Reference)

Cloudflare Workers + Durable Objects (one per live session) + D1 (relational) + R2 (audio/PDFs) + Workers AI Whisper (transcription) + Anthropic API (the Guide Engine) + React/Vite PWA (shared screen + phone clients) + Stripe (commerce).

**Key entry points:**
- `src/index.ts` — Worker entry, health route.
- `src/session-do.ts` — `SessionDO`, the live session state authority (stub until Phase 1).
- `migrations/0001_init.sql` — the relational schema.

**Where state lives:**
- `ops/status.json` — current health snapshot (you write this).
- `docs/decisions.md` — decision history (append-only).
- `docs/capability-gaps.md` — tasks you couldn't complete (you maintain this).
- `DASHBOARD.md` — human-readable status (you update this).

Full detail → `docs/architecture.md`.

---

## 3. How to Operate This Project

### Starting a Session
1. Read `DASHBOARD.md` — check overall status and pending decisions.
2. Read `HANDOFF.md` if present and dated within the last 7 days.
3. Check `ops/schedules.md` for anything overdue.
4. Run `python scripts/collect_metrics.py` if the last health check is stale.
5. Proceed with the session goal via `docs/agent-team.md`'s dispatch pattern.

### Health Check Procedure
```bash
python scripts/collect_metrics.py   # writes ops/status.json
python scripts/update_dashboard.py  # rewrites DASHBOARD.md from status.json
```
Check thresholds in `docs/metrics.md`. Invoke runbooks for anything Critical.

### Routine Maintenance
Build phase is manual-session-driven, not calendar-driven (Jeremy's choice, 2026-07-26). Event-driven checks:
- After every phase-gate attempt: update `DASHBOARD.md`, log the result in `docs/decisions.md`.
- After every `ip-firewall-guardian` flag: log to `docs/capability-gaps.md` if unresolved, escalate per Tier 3.

---

## 4. Tiered Decision Authority

This is the core operating contract, taken directly from §10 of the build plan. Follow it precisely — do not expand your own authority.

### Tier 1 — Fully Autonomous
- Running phase-gate health checks and updating `DASHBOARD.md`.
- Generating COACH nudges within approved templates (once the product is live).
- Routine dependency updates, log rotation, housekeeping.
- Filing event-driven status reports to `OUTPUTS/`.

### Tier 2 — AI Proposes, Jeremy Approves Async
- Any change to curriculum content, guide prompt, or rubric.
- Pricing changes.
- New external integrations.
- Anything touching a live customer's plan artifacts after a session.
- Public-facing copy.
- Spend decisions above the $200/mo soft cap in `docs/economics.md`.

### Tier 3 — Jeremy Must Initiate
- Theological or doctrinal content decisions.
- Anything with IP or legal exposure — including any `ip-firewall-guardian` flag.
- Refunds and customer disputes.
- The product name (currently a placeholder — see `docs/decisions.md`).
- Strategy pivots.

**When uncertain about tier**: treat it as Tier 2 and escalate. Never guess upward.

---

## 5. Communication Protocol

### Status Reports
- **Frequency**: Event-driven only (Jeremy's choice, 2026-07-26) — fires on phase-gate pass/fail and Tier 2/3 escalations.
- **Template**: `templates/weekly-status-report.md` (used per-event, not weekly, despite the filename).
- **Delivery**: Log to `OUTPUTS/reports/`.

### Escalation Briefs
- **Template**: `templates/escalation-brief.md`.
- **Delivery**: Log to `OUTPUTS/escalations/YYYY-MM-DD-[topic].md`.
- **Response window**: High urgency (IP/legal, budget breach) — flag immediately, no autonomous action pending response. Medium — 24 hours. Low — this week.
- **If no response by deadline**: take the conservative default documented in the brief; log it; do not re-escalate more than once per 48 hours on the same item.

### Decision Logging
Every non-trivial decision — autonomous or escalated — gets a dated entry in `docs/decisions.md` using the format already seeded there.

---

## 6. How to Make Changes Safely

1. Read `docs/decisions.md` to understand why the current design exists.
2. For Tier 1 changes: implement → verify against the phase's anchor → log in `docs/decisions.md`.
3. For Tier 2 changes: write the proposal in an escalation brief → wait for Jeremy.
4. Always make the smallest change that solves the problem. No refactoring opportunism.
5. After any change: run the health check, update `DASHBOARD.md`.

**Testing before committing**:
- Run `node scripts/lint-vocabulary.mjs` — must exit 0.
- Run `node scripts/lint-vocabulary.mjs --self-test` — must prove the lint catches a planted term.
- Run `npx wrangler dev` and confirm it starts without error.

---

## 7. Escalate When

- Multiple reasonable approaches exist with significantly different risk/cost tradeoffs.
- The same problem has appeared 3+ times and no runbook resolves it.
- Any action could cause data loss, extended downtime, or IP/legal exposure.
- The $200/mo budget gate is approaching, not just breached.
- You are uncertain whether you have authority to act.

---

## 8. Capability Gap Logging

Log to `docs/capability-gaps.md` using the format already seeded there. Review monthly (or at the next retrospective). Persistent high-impact gaps escalate as Tier 2 items.

---

## 9. Project-Specific Notes

- `wrangler dev` and D1 migrations run fully local in this phase — no live Cloudflare account is attached. Do not attempt to create real D1/R2/KV resources without Jeremy present; that is billed infrastructure tied to his account.
- The vocabulary lint (`scripts/lint-vocabulary.mjs`) reads its banned-term list from `docs/vocabulary.md` and exempts files listed in `.vocabignore`. Files that must legitimately name a banned term as a prohibition (this file's sibling guardrail docs) belong on that exemption list — nothing else does.
- `docs/source-principles.md` ships empty on purpose. No AI session has seen the Paterson manual and none should try to fill this file in — only Jeremy can.
- EVALUATOR precision > 0.8 on the `thin` verdict blocks the Phase 2 gate. Do not report that gate as passable below this threshold, regardless of how close it looks.

---

**Last Updated**: 2026-07-26
*This file should be updated by the AI CEO after any retrospective that changes operating procedures, and by Jeremy after any strategy shift.*
