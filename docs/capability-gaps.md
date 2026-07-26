# Capability Gaps — Groundwork

AI-maintained. Log every task an AI session couldn't complete autonomously. Review at the next retrospective; a gap hit 3+ times escalates to Jeremy as a priority fix item.

---

## 2026-07-26 — Live Cloudflare resource provisioning

**What I tried to do**: Satisfy the Phase 0 gate ("wrangler dev runs, migrations apply") using real Cloudflare infrastructure.
**Why I couldn't complete it**: Creating real D1 databases, R2 buckets, or KV namespaces requires Jeremy's Cloudflare account credentials and is a billed, account-scoped action — not something to do without him present.
**Workaround used**: Local wrangler emulation (`wrangler dev`, `wrangler d1 migrations apply --local`) satisfies the gate without touching live infrastructure.
**What would fix this**: Jeremy attaches Cloudflare account access (or runs the provisioning commands himself) when ready to move past local dev — likely at the start of Phase 1 or whenever a shared staging environment is needed.
**Impact**: Low for now — Phase 0–1 don't need live resources. Will become Medium once multi-device testing (Phase 1 gate: three real devices, no divergence) requires a reachable deployed endpoint rather than local-only `wrangler dev`.

---

## 2026-07-26 — Auth provider not yet chosen

**What I tried to do**: N/A — not yet attempted, flagged proactively.
**Why I couldn't complete it**: The build plan specifies "Cloudflare Access or Clerk — do not roll your own" but doesn't pick one. This is a new external integration (Tier 2) that needs Jeremy's approval before Phase 6/7 work starts.
**Workaround used**: None needed yet — not on the critical path until Phase 6.
**What would fix this**: An escalation brief before Phase 6 begins, proposing a recommendation with tradeoffs.
**Impact**: Low today, will block Phase 6/7 if not resolved beforehand.
