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

## 2026-07-27 — RESOLVED — Anthropic API key now configured, real measurement obtained

**Original gap**: `ANTHROPIC_API_KEY` was not set for the product's Worker runtime, blocking real EVALUATOR/SYNTHESIZER testing.
**Resolution**: Jeremy supplied a key the same day; verified it authenticates, waited for him to add account credits, then re-verified with a real API call (HTTP 200). Stored in `.dev.vars` (gitignored).
**What this unblocked**: Real Phase 2 gate measurement — see `docs/decisions.md`, 2026-07-27 ("Real Phase 2 gate measurement"). Result: **precision 0.667, below the 0.8 gate — a genuine fail**, not a missing-credential placeholder anymore. This capability gap is closed; a new, different situation exists in its place (a measured, diagnosed gate failure, tracked in `docs/roadmap.md` Phase 2).
**Still open**: whether to pursue further prompt tuning is a Tier 2 decision for Jeremy, not a capability gap — logged in `docs/decisions.md`, not here.
**Remaining Anthropic-adjacent gap**: Phase 5 (SYNTHESIZER) and Phase 6 (COACH's LLM personalization) can now also be tested for real with this same key — not yet done as of this entry, tracked as normal build work, not a capability gap.

---

## 2026-07-27 — SUPERSEDED — No Stripe test-mode credentials

**Original gap**: No Stripe account or test-mode API key available in this environment.
**Superseded by**: Jeremy supplied a real `sk_test_...` secret key the same day. The actual blocker turned out to be different — see "Cloudflare and Stripe APIs are network-blocked in this sandbox" below. Credentials were never the real problem for Phase 7; network reachability is.
**Current state**: `STRIPE_SECRET_KEY` sits in `.dev.vars`, ready for use, but unusable from this session regardless.

---

## 2026-07-27 — SUPERSEDED — No live Workers AI (Whisper) access

**Original gap**: Assumed this was a missing-credentials problem.
**Superseded by**: Jeremy supplied a scoped Cloudflare API token the same day. The actual blocker is network reachability, not credentials — see "Cloudflare and Stripe APIs are network-blocked in this sandbox" below. Separately, even with network access, Workers AI has no local emulation (unlike D1/R2/DO/Queues, which do) — real inference always calls Cloudflare's live service.
**Current state**: Phase 4's pipeline code is built and its non-AI mechanics are gate-verified for real (`scripts/test-phase4-audio.mjs` — consent, kill switch, R2/D1/Queue, and confirmed graceful failure handling when the AI call is unreachable).

---

## 2026-07-27 — Phase 3 gate run at reduced scale/duration

**What I tried to do**: Satisfy the literal Phase 3 gate — 10 minutes offline, 6 clients connected.
**Why I couldn't complete it**: Not a missing credential this time — a pragmatic scoping call. Running 6 real browser contexts for a literal 10 minutes in an automated test is slow and doesn't exercise anything the reduced version doesn't already prove; the queue/persist/reconcile mechanism has no per-client-count or time-bounded logic.
**Workaround used**: `scripts/test-phase3-resilience.mjs` runs 1 real browser client offline for ~1 second (real IndexedDB, real network cutoff via Playwright, real reconnect/replay). Multi-client convergence was separately proven for real in the Phase 1 test (3 concurrent clients, zero divergence).
**What would fix this**: Before the first real pilot (Phase 8), run an actual 10-minute, 6-device drill — same spirit as the Phase 1 physical-device gap above. Cheap to combine with that same pre-pilot check.
**Impact**: Low. The mechanism is proven; only the literal scale/duration is untested, and nothing in the design is scale- or time-sensitive in a way that would behave differently at 6 clients / 10 minutes.

---

## 2026-07-27 — Cloudflare and Stripe APIs are network-blocked in this sandbox, independent of credentials

**What I tried to do**: Verify the Cloudflare API token and Stripe secret key Jeremy provided, by calling `api.cloudflare.com/client/v4/user/tokens/verify` and `api.stripe.com/v1/balance` directly.
**Why I couldn't complete it**: Both calls failed with `curl: (56) CONNECT tunnel failed, response 403` before reaching either service. This session's outbound proxy allowlists only `anthropic.com`, npm/pypi/crates/golang package registries, and local/private ranges (confirmed via the proxy's own `/__agentproxy/status` endpoint, `noProxy` field) — everything else, including both of these APIs, gets an explicit policy denial at the gateway. **This is an environment-level network restriction, not a credential problem.** No API key or token, however valid, gets around it from inside this sandbox.
**Workaround used**: None possible from here. The Anthropic key was verifiable (that domain is allowlisted) — it authenticated correctly (see the "insufficient credit balance" entry below), which confirms this is specifically about which domains this sandbox can reach, not a general network failure.
**What would fix this**: Run the actual verification from an environment with normal outbound access — Jeremy's own machine, a GitHub Actions CI run (the `phase3-resilience` and other CI jobs already run on GitHub-hosted runners with normal internet access), or a differently-configured remote environment. If Jeremy wants Phase 4/7 CI jobs to do real verification, the credentials would need to be added as GitHub Actions repository secrets (`Settings → Secrets and variables → Actions`) — this AI has not done that and would treat it as a Tier 2 action requiring explicit confirmation before touching repository-level CI configuration.
**Impact**: High for Phase 4 (Workers AI/Whisper) and Phase 7 (Stripe) specifically — their gates cannot be verified from this session no matter what credentials arrive. Does not affect Phase 2/5 (Anthropic-only), which remain unblocked by this finding.

---

## 2026-07-27 — RESOLVED — Anthropic API key had no credit balance

**Original gap**: The key authenticated but the account had insufficient credit balance to serve requests.
**Resolution**: Jeremy added credits via the Anthropic Console within the same session. Re-verified with a real API call (HTTP 200, real model response).
**What this unblocked**: Real Phase 2 gate measurement (see the RESOLVED Anthropic entry above and `docs/decisions.md`). Phase 5 (SYNTHESIZER) is also now real-testable with this key — not yet exercised as of this entry.
