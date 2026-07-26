# Operational Schedule — Groundwork
**Last Updated**: 2026-07-26
**Maintained by**: AI CEO

Build phase is **manual-session-driven, event-triggered** — not calendar-driven (Jeremy's choice, 2026-07-26). There is no autonomous daily/weekly loop until `agentic-loop-setup` is run, if Jeremy chooses to run it. The checklists below apply per-session and per-event, not per-day.

---

## Per-Session Operations

Run at the start of every manual session:

- [ ] Read `DASHBOARD.md` — check overall status and pending decisions.
- [ ] Read `HANDOFF.md` if present and dated within 7 days.
- [ ] Check this file for anything overdue.
- [ ] Run `python3 scripts/collect_metrics.py` if the last check is stale.

Run at the end of every manual session:

- [ ] Run `python3 scripts/update_dashboard.py`.
- [ ] Log any non-trivial decision in `docs/decisions.md`.
- [ ] Log any incomplete task in `docs/capability-gaps.md`.

**Estimated time**: a few minutes.

---

## Event-Driven Operations

| Trigger | Action | Output |
|---------|--------|--------|
| Phase-gate attempt (pass or fail) | Update `DASHBOARD.md`, log to `docs/decisions.md` | — |
| Budget approaching $200/mo build cap | Escalation brief | `OUTPUTS/escalations/` |
| `ip-firewall-guardian` flags an artifact | Tier 3 escalation, no autonomous fix | `OUTPUTS/escalations/` |
| EVALUATOR precision measured (Phase 2+) | Compare to 0.8 gate threshold | `docs/decisions.md` |
| New capability gap encountered | Log immediately | `docs/capability-gaps.md` |
| Same capability gap hit 3rd time | Escalate as priority fix | `OUTPUTS/escalations/` |

---

## If/When Autonomous Operation Starts

Once `agentic-loop-setup` runs (optional, Jeremy's call), this file gets rewritten with real daily/weekly/monthly cadences for the **live product's** COACH agent and health checks — that is a different rhythm than the build phase and should not be conflated with it.

---

## Autonomy Boundaries (build phase)

**Fully autonomous**:
- Reading status, updating `DASHBOARD.md` and `ops/status.json` after a health check.
- Logging decisions and capability gaps.
- Routine dependency updates.

**Requires async approval** (escalation brief, Jeremy responds):
- Anything above the $200/mo build cap.
- New external integrations (e.g., choosing Cloudflare Access vs. Clerk).
- Architectural changes to what's already gated and passed.

**Requires Jeremy to initiate**:
- Anything IP/legal-adjacent (curriculum content, the product name, trademark matters).
- Strategy pivots.
- Doctrinal or theological content decisions.
