# Groundwork — AI-Facilitated Strategic Planning for Faith-Based Organizations

**Status**: Phases 1, 3, and 6 gate-verified (6 with no proxy needed — the literal gate, fully). Phase 2's gate genuinely measured and failed (0.667 precision vs 0.8 — Jeremy's call on next steps). Phases 4, 5, and 7 built and tested against real services; their literal gates need things this sandbox can't provide (network access, a real human, real phones) — Phase 7's PWA sub-gate is the exception, passed for real via Chrome's own installability check. All 8 build-plan phases now have a scaffold; Phase 8 needs Jeremy's curriculum content and a real pilot church.
**Repo**: `jersilb1400/groundwork`
**Stack**: Cloudflare Workers, Durable Objects, D1, R2, Workers AI (Whisper), React + Vite PWA, Anthropic API, Stripe.
**Goal**: Walk a faith-based organization's leadership team through four full-day working sessions, purely AI-led, and leave them with a plan they actually run — not a binder that dies on a shelf.

"Groundwork" is a placeholder name pending Jeremy's trademark check (§2.4 of the build plan). Do not treat it as final in marketing or legal contexts.

---

## Current Status (Living — Updated After Every Session)

**As of 2026-07-27**:
- Confirmed working: Wrangler config, D1 schema (4 migrations), real `SessionDO` (vote support + logical-clock reconciliation), Guide Engine (segment spec schema + compiler, PACER, EVALUATOR/PROBER), real IndexedDB-backed offline queue, real audio pipeline mechanics (consent, kill switch, R2/D1/Queue), real SYNTHESIZER with provenance verification and artifact versioning, real program layer (org/program/lab_session/initiative/review_cycle CRUD, phase-gated lab sequencing, COACH nudges), real Stripe pricing/webhook-verification and an installable PWA shell (manifest, service worker, real icons — Chrome's own installability check passes with zero real errors), vocabulary lint, CI with automated Phase 1–7 test jobs.
- Credentials: Jeremy supplied Anthropic, Cloudflare, and Stripe credentials. Anthropic works fully (network-reachable, credits added). **Cloudflare and Stripe are network-blocked from this specific sandbox regardless of credentials** — confirmed via the proxy's own status endpoint, not assumed. See `docs/capability-gaps.md`.
- **Real finding #1**: Phase 2's gate was measured for real against `claude-sonnet-5` — precision 0.667, genuinely below the 0.8 threshold. Root-caused (EVALUATOR under-classifies vague-but-topical answers as `off_track` instead of `thin`); one prompt-tuning attempt didn't move it. Flagged as a Tier 2 decision for Jeremy rather than kept under autonomous iteration.
- **Real finding #2**: testing SYNTHESIZER against live Opus surfaced a real data-model bug — two genuinely distinct risks in one synthesis pass would have silently overwritten each other under a "one artifact per kind" assumption. Fixed by splitting kinds into singular (purpose/vision — versioned) vs. plural (risk/driver/etc. — additive).
- **Phase 6 is the first phase since 0/1/3 whose literal gate is fully satisfied, no proxy or scope reduction** — no physical device, no human judgment, no blocked network needed.
- **Phase 7's PWA sub-gate is the second one** — Chrome DevTools Protocol's own `Page.getInstallabilityErrors` call came back with zero real errors, the actual mechanism Chrome/Android use to decide whether to offer install. The commerce sub-gate and the literal iOS/Android device test remain out of this sandbox's reach.
- All 8 build-plan phases now have a built scaffold. Phase 8 (church-pack curriculum + real pilot) is next and is explicitly out of autonomous scope — needs Jeremy's `docs/source-principles.md` first, per the IP firewall protocol.

**Next Priorities**:
1. Line up two or three willing pilot churches before Phase 8 becomes urgent — the plan calls this out explicitly as a now-task, not a later one.
2. Jeremy's call: pursue further EVALUATOR prompt tuning, or accept the Phase 2 result pending Phase 8's real curriculum-scale fixture set.
3. Before the real pilot: run the literal Phase 1/3/5/7 gates (physical devices, real duration, a real leader's edit count, real iOS/Android installs) and get Phase 4/7's real Whisper/Stripe calls run from an environment that can reach Cloudflare/Stripe.

---

## Architecture / System Design

Two separate agent graphs exist in this repo. Do not conflate them:

1. **The build team** (`docs/agent-team.md`, `.claude/agents/`) — the subagents that build Groundwork. Brain/hands/verifier graph, following the `async-agent-graph-engineering` skill.
2. **The Guide Engine** (§5 of the build plan, designed by `guide-engine-architect`) — PACER, EVALUATOR, PROBER, SYNTHESIZER, COACH. This *is the product*. It runs live, in front of a church leadership team, for eight hours at a stretch.

```mermaid
flowchart TD
    Screen[Shared-screen client] <--> DO[Session Durable Object]
    Phone[Phone clients x6-12] <--> DO
    DO <--> D1[(D1: org/user/program/plan_artifact/...)]
    DO --> R2[(R2: audio chunks, PDFs)]
    R2 --> Whisper[Workers AI Whisper]
    Whisper --> D1
    DO --> Guide[Guide Engine: PACER/EVALUATOR/PROBER]
    Guide --> Anthropic[Anthropic API]
```

Key components:
- `src/index.ts` — Worker entry point, health route.
- `src/session-do.ts` — `SessionDO`, one per session. WebSocket hibernation, dedup, D1 checkpointing built in Phase 1. Not yet wired to real org/program data (Phase 6) or reconnect/replay (Phase 3).
- `migrations/0001_init.sql` — the full data model from §4 of the build plan.
- `content/packs/church/` — curriculum as data (does not exist yet; Phase 8).

Full detail → `docs/architecture.md`. Full build sequence and gates → `docs/roadmap.md`.

---

## Build / Run / Deploy Instructions

```bash
npm install
npx wrangler dev                          # local dev server, no live Cloudflare account needed
npx wrangler d1 migrations apply groundwork --local   # applies migrations/0001_init.sql locally
node scripts/lint-vocabulary.mjs                       # fails if a banned trademark term is present
node scripts/lint-vocabulary.mjs --self-test           # proves the lint actually catches a planted term
```

Common pitfalls:
- `wrangler dev` defaults to local emulation for D1/DO/R2 — do not pass `--remote` unless you intend to hit real Cloudflare infrastructure under Jeremy's account.
- The vocabulary lint excludes files listed in `.vocabignore` (the guardrail files that must legitimately *name* banned terms as prohibitions). Do not add a real usage to that list to silence a genuine failure.

---

## Constraints & Non-Negotiables

- **IP firewall (§2 of the build plan) is the highest-risk part of this project.** The source manual never enters this repository — not as a file, pasted text, a prompt, or a vector store. No trademarked terms anywhere — see `docs/vocabulary.md` for the enforced list.
- **Strict doctrinal neutrality.** The guide never takes a theological position. Contested questions get handed to the room.
- **No live Cloudflare resources created without Jeremy present** — see `docs/decisions.md`.
- **Leader override is absolute.** Nothing in the product may be locked against the human in the room (§5.5).
- **EVALUATOR precision > 0.8 on the `thin` verdict is a hard gate** — Phase 2 does not proceed below it.
- Decision authority tiers (§10 of the build plan, restated in `AI_CEO_INSTRUCTIONS.md`) — never self-escalate.

---

## How to Work on This Project with Claude Code

Preferred prompt pattern:
> "Using `docs/agent-team.md` and the build plan, drive Phase [N]. Dispatch to the relevant builder hands, run the phase gate against its anchor, and report the gate result."

Claude will always:
- Read `DASHBOARD.md` and `HANDOFF.md` first if starting a session cold.
- Follow the decision-authority tiers in `AI_CEO_INSTRUCTIONS.md` — propose Tier 2, never touch Tier 3.
- Run the IP firewall check (`ip-firewall-guardian`) before any curriculum or public-facing content lands.
- Maintain this README as the living status source of truth.

---

*Customized for Groundwork from the `project-bootstrapper` template. See `docs/decisions.md` for why the scaffold lives at repo root instead of `PROJECTS/groundwork/`.*
