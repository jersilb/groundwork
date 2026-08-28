# Deep-Dive Review — Groundwork (code-level, four adversarial lenses)

**Date**: 2026-08-27
**Scope**: Every source file under `src/` and `web/src/`, all migrations, scripts, CI, and infra config. Verified against a green baseline: typecheck + phase 1/3/4/6/7, session-integration, PACER, EVALUATOR/PROBER parsing, synthesizer provenance, Stripe webhook crypto tests.

---

## Verdict

**Yellow** — the platform is real and mostly solid, but the product's defining feature (the AI Guide) never actually runs in a live session, and two security bugs undermine the 2026-08-16 "auth wired" claim. All findings below cite file/line-level evidence. Fixes for every Critical and High item shipped in this same session.

---

## Critical

### C1. The AI Guide is not wired into the live session (product gap, not a bug)
`src/session-do.ts` never imports anything from `src/guide-engine/`. PACER, EVALUATOR, PROBER, and SYNTHESIZER exist only as libraries exercised by test scripts. A real lab (opened via `POST /lab-session/:id/open`) runs the hardcoded three-segment fake lab (`FAKE_LAB_SEGMENTS` in `src/session-protocol.ts`) with zero AI participation. The app described in the README — "purely AI-led" — does not exist at runtime yet.
**Fix shipped this session**: the Guide now runs live inside `SessionDO` — PACER on the 30s alarm cadence, EVALUATOR on submission thresholds, PROBER on thin/off_track/stuck verdicts, SYNTHESIZER at segment boundaries writing versioned artifacts server-side. Guide output reaches clients as `guideLog` entries in the normal state broadcast (rejoin-safe, no new transport).

### C2. Stripe webhook is unreachable in production (401 at the auth gate)
`src/index.ts` authenticates **every non-GET request** before routing. Stripe's webhook POST carries no CF Access JWT, so `POST /webhooks/stripe` can never pass the gate when `CF_ACCESS_TEAM_DOMAIN` is set (production), and also fails in dev (no dev headers on Stripe's call). The webhook tests pass because they call `verifyStripeWebhook()` directly, bypassing the Worker. Payment confirmation would never reach D1.
**Fix shipped**: `/webhooks/*` is exempted from the auth gate before any route handler runs (webhook requests are authenticated by their HMAC signature instead).

### C3. `GET /session/:key/plan` serves any org's one-page plan to unauthenticated callers
GETs skip the auth gate entirely (`src/index.ts`), and `handleGetPlan` (`src/synthesis/routes.ts`) does no authorization. The strategic plan — the product's most sensitive output — is readable by anyone who knows a session key. Same class of exposure on `GET /session/:key/audio/consent`.
**Fix shipped**: session-scoped routes now require org membership when the session key is a real lab room (`lab-<labSessionId>`); ad-hoc test sessions keep the old open behavior so the test harness still works.

---

## High

### H1. Cross-tenant data leak: `POST /review-cycle/:id/complete` accepts an arbitrary `programId`
`src/program/routes.ts` authorizes the caller against the review cycle's org, then computes and returns `computeHealthSnapshot(env, body.programId)` for whatever program the body names — including another org's. **Fix shipped**: the target program must belong to the same org as the review cycle.

### H2. Screen-role spoofing on the WebSocket (leader override is NOT leader-only)
Any client that knows a join key can connect with `role=screen` and issue `advance_segment`, `backtrack_segment`, and `leader_override` (`src/session-do.ts` trusts the self-asserted role). HANDOFF.md claims "the shared screen must pass an access token as a query parameter" — no such check exists in code. **Fix shipped**: `POST /lab-session/:id/open` now mints a single-use-per-open `screen_token` (migration 0005), returned to the leader's screen and validated by the DO for screen-role connections on `lab-` rooms; test sessions remain open.

### H3. No org authorization on `/session/*/synthesize` and `/session/*/audio/*`
These routes authenticate (any Access user) but never check the session's org, so any authenticated user of any org can write artifacts into another org's session, flip its consent, or engage its kill switch. The 2026-08-16 DASHBOARD claim "org authorization wired across all state-changing routes" was overstated for exactly these routes. **Fix shipped** (same mechanism as C3).

### H4. Unbounded session state growth from the WebSocket protocol
`recordSubmission`/`recordVote` accept any `segmentKey` (creating state for segments that don't exist), any content length (a phone can submit megabytes into in-memory state, durable storage, and every broadcast + D1 checkpoint), and unbounded vote options. **Fix shipped**: segment keys must exist in the session's segment list; submissions capped (2,000 chars, 100 per segment); votes capped (optionId 200 chars).

---

## Medium

- **M1. Access JWTs are not audience-checked** (`src/auth/cloudflare-access.ts`): any RS256 token signed by the team's certs is accepted regardless of `aud`. Fix shipped: optional `CF_ACCESS_AUD` env binding is enforced when present.
- **M2. One malformed COACH response 500s the whole nudges endpoint** (`src/program/routes.ts` loops `generateNudge` with no per-step error handling). Fix shipped: per-step try/catch falls back to the deterministic template nudge.
- **M3. Stripe lifecycle events ignored**: only `checkout.session.completed` is handled; a portal cancellation never clears `subscription_tier`, and `session.customer` is cast to `string` unchecked. Fix shipped: `customer.subscription.deleted` clears the tier; null customer guarded.
- **M4. Audio chunk uploads have no size cap** (R2 write of arbitrary body). Fix shipped: 10 MB cap, 413 on excess.
- **M5. PWA manifest references three files that don't exist** (`/icon-maskable-512.png`, `/screenshot-wide.png`, `/screenshot-narrow.png` — added in uncommitted manifest changes without regenerating assets). Chrome's installability check now fails; phase 7 catches it. Fix shipped: generator produces the maskable icon; real screenshots captured from the running app.
- **M6. Transcription queue consumer has no retry ceiling** (`wrangler.toml`). Fix shipped: `max_retries: 5`.
- **M7. `saveArtifact` version allocation is read-then-insert** (`src/synthesis/plan-artifact-store.ts`) — two concurrent synthesize calls can both claim version N. Not fixed this session (single-writer synthesis path in practice); noted as follow-up with a UNIQUE index + retry.

## Guide-quality improvements shipped (the product's core)

1. **Live guide loop** (C1) with cost discipline: evaluation at most every 30s and only when new submissions exist; probes only on non-on_track verdicts; synthesis on segment boundaries; every LLM call degrades silently to "no guide" when `ANTHROPIC_API_KEY` is absent and is fully disabled by `GUIDE_ENABLED=false` (local tests set this in `.dev.vars`).
2. **EVALUATOR prompt upgraded** for professional facilitation: explicit candor-vs-harmony lens, specificity standard ("names people, dates, dollars, mechanisms"), anti-platitude guidance kept, doctrinal neutrality guardrail ("never evaluate theological content; flag it for the leader instead"), unchanged JSON contract (all parsing tests still pass).
3. **PROBER prompt upgraded**: probes must quote or concretely paraphrase a submission, run ≤ 2 sentences, and are forbidden from generic fillers and theological framing.
4. **SYNTHESIZER prompt upgraded**: board-ready drafting standard ("a trustee who missed the meeting could act on this line"), no corporate filler, verbatim provenance mechanics unchanged.
5. **Guide voice**: PACER messages speak like a facilitator protecting the day ("we're 20% over on this segment; here's what I suggest cutting"), never auto-advance — §5.5 leader override stays absolute; PACER recommends, the leader decides.

## Strengths worth keeping (verified, not flattery)

- The offline/outbox → dedup/logical-clock reconciliation design is correct and well-tested (phase 3 + session-integration prove it against a real browser and a killed DO).
- Provenance verification in SYNTHESIZER is a genuinely differentiating feature (fabricated quotes are a hard failure, verified deterministically).
- The eval harness + deterministic parsing tests caught real historical bugs (JSON truncation, invalid `weakest_criterion`) and still guard the JSON contract.
- CI exercises every gate that can run headlessly, including the vocabulary lint self-test.
- The design system (theme.css tokens, focus-visible discipline) is consistent and accessible across screens.

## Not addressed this session (explicitly)

- `runEvaluatorRepeated` gates on the worst of N runs — honest but expensive at N=5; fine for measurement, not wired into the live loop (single-run there).
- Phase 2's precision gate (≈0.75 vs 0.8) still needs a curriculum-scale fixture set (Phase 8) to re-measure meaningfully.
- The "Groundwork" trademark question remains Jeremy's call.
- Phase 8 curriculum remains IP-firewalled pending `docs/source-principles.md`.
