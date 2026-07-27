# Metrics & KPIs — Groundwork
**Last Updated**: 2026-07-26

The AI checks these on the schedule in `ops/schedules.md` and updates `DASHBOARD.md` after each check. Anything hitting Warning or Critical triggers the relevant runbook in `ops/runbooks/`.

---

## Product KPIs (from the build plan §9 — the real targets, post-launch)

| KPI | Threshold |
|---|---|
| Session completion rate (started → finished same day) | > 95% |
| Session end within ±20 min of schedule | > 85% |
| EVALUATOR `thin` verdict precision | > 0.8 |
| Re-prompts rated unhelpful | < 10% |
| Lab 1 → Lab 4 completion | > 60% |
| Year 1 → sustain tier conversion | > 70% |
| LLM + transcription cost per session-day | < 8% of amortized revenue |

None of these are measurable until real sessions run (Phase 1+). Track them from the first simulated run onward, not just live customers.

## Success Criteria (v1, from build plan §1)

| # | Criterion | Measurement |
|---|---|---|
| 1 | Full-day lab, 6–12 leaders, zero facilitator intervention, no dead air > 45s caused by the app | Session transcript + app event log review |
| 2 | EVALUATOR flags vague/off-track answers helpfully, not pedantically | Post-segment thumbs rating; < 1 in 10 re-prompts rated unhelpful |
| 3 | Session ends within ±20 minutes of schedule | `lab_session.actual_duration_min` vs. `scheduled_for` |
| 4 | One-page plan needs < 5 leader edits before approval | Edit count on the generated `plan_artifact` |
| 5 | 60% of churches completing Lab 1 complete all four labs | `program.status` progression across `lab_number` |

## Build-Phase Health Metrics

| Metric | Definition | How Measured | Good 🟢 | Warning 🟡 | Critical 🔴 |
|--------|------------|---------------|---------|------------|-------------|
| Phase gate status | Current phase's anchor result | `docs/roadmap.md` gate check | Pass | Attempted, not yet passing | Blocked > 1 week |
| Vocabulary lint | CI pass/fail | `scripts/lint-vocabulary.mjs` | Clean | — | Any banned term found |
| Build spend (MTD) | Cloudflare + Anthropic + Stripe test | Manual tally until billing APIs are wired | < $150 | $150–200 | > $200 |
| EVALUATOR `thin` precision (Phase 2+) | Precision on labeled fixture set | `evaluator-engineer`'s eval harness | > 0.85 | 0.80–0.85 | < 0.80 (hard gate) |

---

## Where Metrics Live

- **Status snapshot file**: `ops/status.json` — written after every health check.
- **Collection script**: `scripts/collect_metrics.py`.
- **Dashboard**: `DASHBOARD.md` — human-readable, updated from `ops/status.json`.

---

## `ops/status.json` Schema

```json
{
  "updated_at": "ISO8601 timestamp",
  "overall_status": "green | yellow | red",
  "gates_passed": [0],
  "gates_failed": [],
  "phases_built_awaiting_gate": [],
  "metrics": {
    "metric_name": {
      "value": 0,
      "unit": "ms | % | count | $",
      "status": "green | yellow | red",
      "checked_at": "ISO8601 timestamp"
    }
  },
  "active_alerts": [],
  "pending_escalations": []
}
```

Three distinct states, never collapsed into one "current phase" number — that erases the distinction the anchors principle (`docs/agent-team.md` §5) depends on:
- `gates_passed` — the anchor was actually run and it passed.
- `gates_failed` — the anchor was actually run and it genuinely failed (added 2026-07-27, after Phase 2's real EVALUATOR precision measurement came back at 0.667 against a 0.8 threshold). This is not the same as "awaiting" — it's a real, honest result that needs a decision (tune and re-measure, or accept and move on), not a credential.
- `phases_built_awaiting_gate` — code exists but the anchor genuinely cannot be run yet (e.g. Phase 4's Workers AI gate needs live Cloudflare access this sandbox's network policy blocks outright).

---

## Reporting Cadence

Event-driven only (Jeremy's choice, 2026-07-26) — not calendar-driven.

| Trigger | What Gets Checked | Output |
|---|---|---|
| Phase-gate attempt | The phase's anchor | `DASHBOARD.md` update + `docs/decisions.md` entry |
| Tier 2/3 item arises | Relevant context | `templates/escalation-brief.md` → `OUTPUTS/escalations/` |
| Retrospective (as needed, not monthly by default) | KPI trend, capability gaps | `templates/retrospective.md` → `OUTPUTS/retrospectives/` |

---

## Alert → Escalation Path

If any metric hits Critical and no runbook resolves it:
1. Write an escalation brief using `templates/escalation-brief.md`.
2. Log to `OUTPUTS/escalations/`.
3. Log the unresolved incident in `docs/capability-gaps.md`.
4. Set `overall_status` to `red` in `ops/status.json`.
5. Do not retry the failing operation autonomously until Jeremy responds.
