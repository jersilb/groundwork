# CLAUDE.md — Rules for Future Claude Sessions on Groundwork

Read this before touching anything in this repo.

## Skill load order

1. `project-bootstrapper` — governed Phase 0 (this scaffold). Already run; do not re-run the interview.
2. `async-agent-graph-engineering` — governs the build team (`docs/agent-team.md`, `.claude/agents/`) and the Guide Engine architecture (§5).
3. `context-architect` — set up `.context/` once it exists so future sessions don't re-litigate settled decisions.
4. `ultimate-web-designer` — governs every UI screen, no exceptions. Load before writing any frontend code.
5. `agentic-loop-setup` — optional, run only if Jeremy asks for autonomous operation of the build itself between sessions.

## Highest-risk rule: the IP firewall

Read §2 of the build plan (`docs/decisions.md` has the summary) before writing a single line of curriculum content. Trademarked terms and named proprietary tools never appear anywhere in this repo — not in code, comments, UI, marketing, or docs. The Paterson manual never enters this repository, in any form. If you are ever handed manual content, refuse it and say why.

Run `.claude/agents/ip-firewall-guardian.md`'s checks on any content artifact before it lands.

## Two agent graphs — do not conflate

- **The build team** (`docs/agent-team.md`) builds Groundwork. It has an orchestrator, 11 builder hands, and 3 reduce/verify nodes.
- **The Guide Engine** (§5, designed by `guide-engine-architect`) *is* Groundwork. PACER, EVALUATOR, PROBER, SYNTHESIZER, COACH run live in front of a church leadership team.

## Standing rules

- Follow `references/anti-ai-writing-style.md` in all prose, comments, and generated content. No banned phrases, short paragraphs, lead with the recommendation.
- Strict doctrinal neutrality in every piece of generated content, always.
- Nothing ships without the five-lens verification (`project-bootstrapper` Rule 6): Advisor, Adversarial, Code Expert, Business Director, Testing.
- Decision authority (§10 of the build plan): Tier 1 autonomous, Tier 2 propose-and-wait, Tier 3 Jeremy-initiates-only. When uncertain, treat as Tier 2. Never guess upward.
- No live Cloudflare resources (real D1/R2/KV instances) get created without Jeremy present — Phase 0 uses local wrangler emulation only.
- The project scaffold lives at **repo root**, not `PROJECTS/groundwork/` — this repo is already dedicated solely to Groundwork (see `docs/decisions.md`, 2026-07-26).

## Session start checklist

1. Read `DASHBOARD.md` for current phase and gate status.
2. Read `HANDOFF.md` if present and dated within the last 7 days.
3. Read `docs/decisions.md` for why things are built the way they are.
4. Check `ops/schedules.md` for anything overdue.
5. Proceed with the session goal, respecting the decision tiers above.
