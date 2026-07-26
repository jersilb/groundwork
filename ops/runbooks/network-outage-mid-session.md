# Runbook: Network Outage Mid-Session
**Severity**: P1 Critical
**AI Autonomous**: No — this is a live customer session; the leader in the room is in control, not the AI. This runbook governs what the *system* should already do automatically (Phase 3), and what a human operator checks if a church reports a bad session afterward.
**Triggers when**: A live lab session's shared-screen or phone clients lose connectivity to the session Durable Object for more than 5 minutes.

---

## Quick Checklist

- [ ] Confirm degraded mode activated (pre-cached prompts, deferred evaluation)
- [ ] Confirm no submissions were lost on reconnect
- [ ] Confirm `stateVersion` reconciliation completed without conflicts
- [ ] Log the incident in `docs/decisions.md`
- [ ] If this is a repeat pattern, escalate to Jeremy

---

## 1. Diagnosis

1. Check the session's checkpoint history in D1 — did checkpoints continue at the 30-second/segment-boundary cadence before the outage?
   ```bash
   npx wrangler d1 execute groundwork --local --command "SELECT * FROM lab_session WHERE id = '<session_id>'"
   ```
2. Check whether degraded mode was entered (pre-generated segment prompts served from cache) — this is expected behavior, not a failure.
3. Check the phone clients' local submission queues (client-generated UUIDs) for anything still unsynced after reconnect.

**Expected findings**: degraded mode active during the outage, all submissions present after reconnect with no duplicates (UUID dedup worked), `stateVersion` monotonically increased across the gap.

---

## 2. Resolution Steps

### Option A — Confirm reconciliation completed cleanly
1. Verify the session's final state in D1 matches what the shared-screen client shows.
2. If clean: no action needed. This is the system working as designed (§3.3 of the build plan).

### Option B — Submissions or vote records missing after reconnect
1. Check phone-client IndexedDB queue logic for a dedup or replay bug.
2. This is a defect in `resilience-engineer`'s implementation, not something to patch live during a session — flag for the next build session.
3. If this happened during a real customer session: escalate immediately (see below), this is Tier 3 territory (customer data / trust).

---

## 3. Escalation

If submissions were lost, or the leader had to intervene manually to keep the session going:
1. Write an escalation brief using `templates/escalation-brief.md`.
2. Subject: `Groundwork P1 — Network Outage Mid-Session — [church name/session id]`.
3. Log to `OUTPUTS/escalations/YYYY-MM-DD-network-outage.md`.
4. Set `overall_status` to `red` in `ops/status.json`.
5. This is a Tier 3 item if it affected a real customer's session — Jeremy decides next steps, including whether to comp the session or re-run it.

---

## 4. Post-Incident

- [ ] Log entry in `docs/decisions.md`: what happened, what the system did, whether it was sufficient.
- [ ] Update `DASHBOARD.md`.
- [ ] If the Phase 3 resilience design didn't hold: note the gap in `docs/capability-gaps.md` and flag for `resilience-engineer` to fix before the next real session.

---

## Known Pitfalls

- Do not assume a reconnect within 5 minutes needs degraded mode — the plan's threshold is intentional; check `guide-engine-architect`'s pre-cache design for the exact trigger.
- Last-write-wins is explicitly wrong for submission reconciliation — if you see it being used anywhere, that's the bug, not the outage.
