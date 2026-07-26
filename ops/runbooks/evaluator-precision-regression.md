# Runbook: EVALUATOR Precision Regression
**Severity**: P1 Critical (this is a hard build gate, not a soft target)
**AI Autonomous**: Partial — diagnosis and re-tuning proposals are autonomous; the "we're proceeding to Phase 3 anyway" decision is never autonomous.
**Triggers when**: EVALUATOR's precision on the `thin` verdict, measured against the labeled fixture set, falls to or below 0.8 — at initial Phase 2 gate, or in a later regression check after a rubric or prompt change.

---

## Quick Checklist

- [ ] Confirm the measurement itself is valid (right fixture set, right verdict column)
- [ ] Identify whether this is a new regression or the initial gate not yet passed
- [ ] Run diagnosis on false positives (fine answers flagged `thin`) — these are worse than false negatives
- [ ] Apply a targeted fix, re-measure
- [ ] Do not proceed past Phase 2 until precision is confirmed > 0.8

---

## 1. Diagnosis

1. Pull the confusion matrix for the `thin` verdict from the eval harness output.
   ```bash
   # evaluator-engineer's eval harness should emit this — check its output location
   cat eval-results/latest.json | jq '.thin_verdict'
   ```
2. Read every false positive (EVALUATOR said `thin`, human label said `on_track`) — these are the priority. The build plan is explicit: "False positives — nagging a team whose answer was fine — are worse than false negatives here."
3. Check whether the rubric is actually being passed in as data, or has drifted into being baked into the prompt (§5.3's core requirement).

**Expected findings**: a small number of false positives, concentrated in specific rubric criteria or segment types (the silent room, the spiritual-language-that-says-nothing scenario are known hard cases per §5.6).

---

## 2. Resolution Steps

### Option A — Rubric criterion is too strict or ambiguous
1. Review the specific `rubric.check` text that's triggering false positives.
2. Propose a clarified check to `guide-engine-architect` (this touches the segment spec schema — Tier 2, propose to Jeremy if it's a curriculum content change).
3. Re-run the eval harness against the same fixture set.

### Option B — Fixture set has labeling errors
1. Spot-check the specific fixtures driving the false positives — was the human label itself wrong?
2. Correct the fixture, re-measure. Do not correct fixtures to make the number look better; correct them because they're actually mislabeled.

### Option C — Model/prompt issue, not rubric issue
1. Check whether EVALUATOR's prompt has drifted toward generic language instead of using the passed-in rubric data.
2. This is `evaluator-engineer`'s implementation bug — fix and re-measure.

---

## 3. Escalation

If precision stays at or below 0.8 after reasonable tuning attempts:
1. Write an escalation brief using `templates/escalation-brief.md`.
2. Subject: `Groundwork P1 — EVALUATOR precision gate not met — [date]`.
3. Log to `OUTPUTS/escalations/YYYY-MM-DD-evaluator-precision.md`.
4. **Do not advance to Phase 3.** This is a hard gate per `docs/roadmap.md`.

---

## 4. Post-Incident

- [ ] Log entry in `docs/decisions.md`: what was tuned, what moved the number, final measured precision.
- [ ] Update `DASHBOARD.md` with the gate result.
- [ ] If the fixture set itself was found to be inadequate (too small, unrepresentative): note in `docs/capability-gaps.md` and expand it before re-measuring.

---

## Known Pitfalls

- Optimizing for recall instead of precision on `thin` — the plan is explicit that this is backwards for this product.
- Declaring the gate passed on a single good run — re-run against the full fixture set, not a cherry-picked subset.
