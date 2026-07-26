# Runbook: IP/Trademark Flag Detected
**Severity**: P1 Critical
**AI Autonomous**: No — this is always Tier 3. The AI's job is to stop, contain, and report. Never to resolve.
**Triggers when**: `ip-firewall-guardian` returns `flag` or `block` on any artifact, or the vocabulary lint (`scripts/lint-vocabulary.mjs`) fails in CI on real repo content (not the self-test).

---

## Quick Checklist

- [ ] Stop — do not merge, commit further on top of, or ship the flagged artifact
- [ ] Identify exactly what was flagged and where
- [ ] Confirm it isn't a false positive from `.vocabignore` misconfiguration
- [ ] If real: contain (revert or isolate the artifact), never patch-and-ship
- [ ] Escalate to Jeremy — always, no exceptions

---

## 1. Diagnosis

1. Get the exact finding from `ip-firewall-guardian` or the lint output:
   ```bash
   node scripts/lint-vocabulary.mjs
   ```
2. Check `.vocabignore` — is the flagged file supposed to be exempt (a guardrail doc naming the term as a prohibition) but isn't listed? Or is this a genuine new usage?
3. If it's manual content (text that reads like it came from the Paterson manual, not just a banned term): treat as maximum severity — this is the one the build plan calls out as never-ever-acceptable, not just a lint failure.

**Expected findings**: almost always a genuine new usage in curriculum, UI copy, or code comments — not a false positive, since `.vocabignore` is deliberately narrow.

---

## 2. Resolution Steps

**There is no autonomous resolution step for this runbook.** Do not attempt to reword the flagged content and re-ship it without Jeremy's review — a close paraphrase fix applied by the same process that produced the violation is exactly the failure mode this exists to prevent.

1. Revert or isolate the flagged artifact so it cannot ship (do not merge the branch/PR containing it).
2. Do not delete it either — Jeremy or an attorney may need to see exactly what was flagged.
3. Go straight to escalation.

---

## 3. Escalation

Always escalate — there is no threshold or waiting period for this one.
1. Write an escalation brief using `templates/escalation-brief.md`.
2. Subject: `Groundwork P1 — IP/Trademark Flag — [artifact name]`.
3. Log to `OUTPUTS/escalations/YYYY-MM-DD-ip-flag.md`.
4. Include: exact text/term flagged, file and location, whether it reached any shipped artifact, and `ip-firewall-guardian`'s full finding.
5. Set `overall_status` to `red` in `ops/status.json`.
6. **Do not resume work on the flagged area until Jeremy responds.**

---

## 4. Post-Incident

- [ ] Log entry in `docs/decisions.md`: what was flagged, what Jeremy decided, what changed.
- [ ] If it was a genuinely new banned term: add it to `docs/vocabulary.md`.
- [ ] If it reveals a gap in `ip-firewall-guardian`'s checks: note in `docs/capability-gaps.md` and propose an update to that agent's definition (Tier 2).

---

## Known Pitfalls

- Treating this like any other CI failure and fixing it inline. It is not — see `.claude/agents/ip-firewall-guardian.md`: anything IP-adjacent is Tier 3, always escalate rather than clear.
- Widening `.vocabignore` to make a failure go away. That file exists only for guardrail docs that must *name* the terms as prohibitions — never for genuine usage.
