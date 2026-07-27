# Groundwork — AI-Facilitated Strategic Planning for Faith-Based Organizations

**Status**: Phase 1 gate-verified. Phase 2 (Guide Engine) built and unit-tested; its precision gate is blocked on credentials. Building Phases 3–7.
**Repo**: `jersilb1400/groundwork`
**Stack**: Cloudflare Workers, Durable Objects, D1, R2, Workers AI (Whisper), React + Vite PWA, Anthropic API, Stripe.
**Goal**: Walk a faith-based organization's leadership team through four full-day working sessions, purely AI-led, and leave them with a plan they actually run — not a binder that dies on a shelf.

"Groundwork" is a placeholder name pending Jeremy's trademark check (§2.4 of the build plan). Do not treat it as final in marketing or legal contexts.

---

## Current Status (Living — Updated After Every Session)

**As of 2026-07-27**:
- Confirmed working: Wrangler config, D1 schema (2 migrations), real `SessionDO`, Guide Engine (segment spec schema + compiler, PACER deterministic logic, EVALUATOR/PROBER with real schema-validated parsing), vocabulary lint, CI pipeline with automated Phase 1 and Phase 2 test jobs.
- In progress: Phases 3–7, building continuously per Jeremy's instruction.
- Known blockers: no Anthropic API key, Stripe test keys, or live Cloudflare/Workers AI access in this environment. Phases 2, 4, 5, and 7's gates are being built but cannot be marked passed until Jeremy supplies these — see `docs/capability-gaps.md`.

**Next Priorities**:
1. Resilience (Phase 3): fully buildable and testable locally, no credentials needed.
2. Audio pipeline (Phase 4) and synthesis (Phase 5) code — buildable now, live testing blocked on credentials.
3. Line up two or three willing pilot churches before Phase 8 becomes urgent — the plan calls this out explicitly as a now-task, not a later one.

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
