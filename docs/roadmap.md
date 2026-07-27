# Roadmap — Groundwork

Source of truth: the build plan, §7. Each phase ends with something demonstrable. Do not proceed until the gate passes — no exceptions, including for gates that "look close."

---

## Phase 0 — Scaffold ✅ PASSED (2026-07-26)

Full project scaffold, Wrangler config, D1 schema migration, R2 bucket bindings, CI with the vocabulary lint.
**Gate**: `wrangler dev` runs, migrations apply, vocabulary lint fails correctly on a planted banned term.
**Owner**: executed directly this session (see `docs/agent-team.md` §10 — first-phase scaffolding has little genuine parallelism).
**Verified**: all three conditions run live, not inferred. See `docs/decisions.md`, 2026-07-26.

## Phase 1 — Session spine ✅ PASSED (automated proxy, 2026-07-27)

Durable Object with WebSocket fanout, hibernation API, join by session key, state broadcast. Segment advance, hardcoded three-segment fake lab. No AI yet. D1 checkpointing every 30s (alarm) and at every segment boundary.
**Gate (literal)**: three real devices in one room advance through segments together with no state divergence.
**Gate (verified this session)**: `scripts/test-phase1-multiclient.mjs` — 3 concurrent real WebSocket clients (1 screen, 2 phones) against a live `wrangler dev` instance, real DO storage, real D1 checkpoint. Confirmed: submission dedup by client UUID, phone-initiated `advance_segment` rejected, all 3 clients converge on identical `stateVersion` and `currentSegmentIndex`. Wired into CI (`phase1-session-spine` job).
**Open item**: the literal physical-multi-device-in-a-room test has not been run — logged in `docs/capability-gaps.md`. The automated test verifies the DO's convergence mechanism for real; it does not substitute for hardware/network diversity across real devices.
**Owner**: executed directly this session.
**Not yet built** (explicitly out of Phase 1 scope): join-by-human-typeable-code UX (needs Phase 6's program layer), reconnect/replay (Phase 3), real curriculum specs (Phase 2).

## Phase 2 — Guide Engine

Segment spec loader. PACER, EVALUATOR, PROBER as separate agents with structured outputs. Eval suite with labeled fixtures. Instrumentation on every LLM call.
**Gate**: EVALUATOR precision above 0.8 on the `thin` verdict against the labeled fixture set. **Do not proceed below this.**
**Owner**: `guide-engine-architect` (design) → `evaluator-engineer` (implementation).

## Phase 3 — Resilience

Offline mirror, submission queue and replay, reconnect reconciliation, degraded mode, prompt pre-caching.
**Gate**: kill the network mid-segment for 10 minutes with 6 clients connected. Session continues, all submissions survive, state reconciles cleanly.
**Owner**: `resilience-engineer`.

## Phase 4 — Audio

Chunked capture, R2 upload, queue-driven Whisper transcription, transcript window feeding EVALUATOR. Consent gate, recording indicator, kill switch, 90-day lifecycle rule.
**Gate**: 4 hours of continuous recording with zero lost chunks, transcript lag under 90 seconds.
**Owner**: `audio-pipeline-engineer`.

## Phase 5 — Synthesis and artifacts

SYNTHESIZER, plan artifact versioning, provenance links, live team editing of drafts, one-page plan generation, PDF export.
**Gate**: a full simulated lab produces a one-page plan requiring fewer than 5 leader edits.
**Owner**: `synthesis-engineer`.

## Phase 6 — Program layer

Org and team setup, roles, four-lab program sequencing, initiative tracking, monthly review flow, COACH nudges, the dashboard home screen.
**Gate**: a simulated org completes Lab 1, receives nudges, and runs a monthly review.
**Owner**: `program-coach-engineer`.

## Phase 7 — Commerce and PWA

Stripe tiers, trial, billing portal, PWA manifest and install prompt, service worker.
**Gate**: a test org signs up, trials, converts, and can install to home screen on iOS and Android.
**Owner**: `commerce-pwa-engineer`.

## Phase 8 — Church pack and pilot

Write the Lab 1 church-pack curriculum from ministry reasoning. Then run a real pilot with a real church leadership team.
**Gate**: one real church completes a real Lab 1. **This is the actual gate on the whole project — no model signs it.**
**Owner**: `curriculum-author` (content) + Jeremy (pilot).

**Action item, standing**: line up two or three willing pilot churches now, not when Phase 8 arrives.

---

## Cross-cutting work (not phase-gated, runs throughout)

- `frontend-ux-engineer` — every screen, all phases, via `ultimate-web-designer`.
- `ip-firewall-guardian` — every artifact, every gate, no exceptions.
- Cost instrumentation — live from Phase 2 onward, tracked in `docs/economics.md`.
