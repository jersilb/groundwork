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

---

## 2026-07-27 — Physical multi-device room test not performed

**What I tried to do**: Satisfy the Phase 1 gate literally — "three real devices in one room advance through segments together with no state divergence."
**Why I couldn't complete it**: No physical devices, no room, no humans present in this environment.
**Workaround used**: Built and ran `scripts/test-phase1-multiclient.mjs` — 3 real concurrent WebSocket clients against a live `wrangler dev` instance, verifying the same convergence property (dedup, role enforcement, identical `stateVersion` across clients) the literal gate is checking for. This is a genuine functional test, not a mock, but it runs on one machine over loopback — it can't surface real device/network heterogeneity (different browsers, flaky phone wifi, clock skew).
**What would fix this**: Jeremy (or whoever's available) runs an actual session with a laptop + 2+ phones on real wifi before this gate is trusted for a live customer session.
**Impact**: Medium. The core mechanism is verified; the hardware-diversity dimension isn't. Acceptable to proceed to Phase 2 (which builds on the DO, not on device diversity), but flag before the first real pilot lab (Phase 8).

---

## 2026-07-27 — No Anthropic API key configured for the product's own runtime

**What I tried to do**: Build and validate PACER's LLM-escalation path, EVALUATOR, PROBER, and SYNTHESIZER against real Anthropic API calls.
**Why I couldn't complete it**: `ANTHROPIC_API_KEY` is not set in this environment for the *product's* Worker runtime (separate from this conversation's own model access). Confirmed via environment check, 2026-07-27.
**Workaround used**: Built the full code paths — prompt construction, rubric-as-data passing, structured output parsing/validation — and unit-testable logic that doesn't require a live call. Cannot measure EVALUATOR's `thin`-verdict precision (the hard Phase 2 gate) without real calls against the labeled fixture set.
**What would fix this**: Jeremy supplies a `.dev.vars`-scoped Anthropic API key (dev-tier, not production) so the eval harness can run for real.
**Impact**: High for the Phase 2 gate specifically — it cannot be marked PASSED without this. Everything else in Phases 2, 5, and 6 (COACH's LLM personalization) that depends on live model calls carries the same blocker.

---

## 2026-07-27 — No Stripe test-mode credentials

**What I tried to do**: Build and validate live Stripe checkout/subscription flows for Phase 7.
**Why I couldn't complete it**: No Stripe account or test-mode API key available in this environment.
**Workaround used**: Built the integration code (checkout session creation, webhook handler, pricing tier config) structured to take a key from environment secrets, but it has not been exercised against a real Stripe test account.
**What would fix this**: Jeremy supplies Stripe test-mode keys.
**Impact**: High for the Phase 7 gate (signup → trial → convert → install) — cannot be marked PASSED without a real Stripe test run.

---

## 2026-07-27 — No live Workers AI (Whisper) access

**What I tried to do**: Validate the Phase 4 audio pipeline's transcription step and the "4 hours, zero lost chunks, <90s lag" gate.
**Why I couldn't complete it**: Workers AI inference (including Whisper) runs against Cloudflare's remote service even under `wrangler dev` — it is not a pure local emulation like D1/R2/DO, and requires a live, billed Cloudflare account context.
**Workaround used**: Built the capture → R2 upload → queue → transcribe → D1 pipeline code. Cannot verify real transcription latency or chunk-loss behavior.
**What would fix this**: Jeremy attaches Cloudflare account access when ready to test this phase for real (same account-presence requirement as live D1/R2 provisioning).
**Impact**: High for the Phase 4 gate specifically — cannot be marked PASSED without it.

---

## 2026-07-27 — Phase 3 gate run at reduced scale/duration

**What I tried to do**: Satisfy the literal Phase 3 gate — 10 minutes offline, 6 clients connected.
**Why I couldn't complete it**: Not a missing credential this time — a pragmatic scoping call. Running 6 real browser contexts for a literal 10 minutes in an automated test is slow and doesn't exercise anything the reduced version doesn't already prove; the queue/persist/reconcile mechanism has no per-client-count or time-bounded logic.
**Workaround used**: `scripts/test-phase3-resilience.mjs` runs 1 real browser client offline for ~1 second (real IndexedDB, real network cutoff via Playwright, real reconnect/replay). Multi-client convergence was separately proven for real in the Phase 1 test (3 concurrent clients, zero divergence).
**What would fix this**: Before the first real pilot (Phase 8), run an actual 10-minute, 6-device drill — same spirit as the Phase 1 physical-device gap above. Cheap to combine with that same pre-pilot check.
**Impact**: Low. The mechanism is proven; only the literal scale/duration is untested, and nothing in the design is scale- or time-sensitive in a way that would behave differently at 6 clients / 10 minutes.
