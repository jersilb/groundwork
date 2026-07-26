# Runbook: Budget Ceiling Exceeded
**Severity**: P2 High
**AI Autonomous**: Diagnosis yes. Any spend decision above the cap requires Jeremy — always Tier 2 minimum.
**Triggers when**: Build-phase spend (Cloudflare + Anthropic API + Stripe test mode) is trending toward or has exceeded the $200/mo soft cap in `docs/economics.md`.

---

## Quick Checklist

- [ ] Confirm the actual spend figure (not an estimate)
- [ ] Identify which service is driving it
- [ ] Halt any non-critical spend-generating activity
- [ ] Escalate before incurring further spend in that category
- [ ] Log in `docs/decisions.md` regardless of outcome

---

## 1. Diagnosis

1. Check `docs/economics.md`'s "Actual" column — has it been updated this month?
2. If Anthropic API is the driver: check whether eval-suite runs (Phase 2) are using Opus where Sonnet or Haiku would do, per the model-routing rule in `docs/agent-team.md` §6.
3. If Cloudflare is the driver: confirm no live (non-local) resources were accidentally created — see `docs/capability-gaps.md`, live provisioning shouldn't be happening yet.

**Expected findings**: in Phase 0–1, spend should be near $0 (local-only). Any real spend this early is worth investigating on its own, independent of the cap.

---

## 2. Resolution Steps

### Option A — Model routing drift
1. Check recent LLM calls for model tier vs. the routing table in `docs/agent-team.md` §6.
2. If a builder hand is calling Opus for fan-out-style work, correct it back to Sonnet/Haiku.
3. Re-check spend trend after the fix.

### Option B — Genuine increased need (e.g., larger eval fixture set)
1. This is not a bug — it's real cost growth. Do not silently absorb it.
2. Escalate with the reason and a revised estimate.

---

## 3. Escalation

1. Write an escalation brief using `templates/escalation-brief.md`.
2. Subject: `Groundwork P2 — Budget ceiling approaching/exceeded — [amount]`.
3. Log to `OUTPUTS/escalations/YYYY-MM-DD-budget.md`.
4. Include current spend, projected month-end, and the specific driver.
5. **If no response by the stated deadline**: the conservative default is to halt further spend-generating build work in the flagged category (e.g., pause eval-suite runs) until Jeremy responds — never to keep spending and hope it resolves itself.

---

## 4. Post-Incident

- [ ] Log entry in `docs/decisions.md`: what drove the overage, what Jeremy decided (raise the cap, cut the activity, accept a one-time overage).
- [ ] Update `docs/economics.md`'s actual-cost table.
- [ ] If this was caused by a routing mistake: fix it and note the correction so it doesn't recur.

---

## Known Pitfalls

- Waiting until the cap is breached instead of flagging the trend — the rule is "escalate when budget gates are approaching, not just when they're breached" (`AI_CEO_INSTRUCTIONS.md` §7).
- Treating $200/mo as precise rather than a soft cap meant to catch drift early — the point is visibility, not a hard cutoff mid-task.
