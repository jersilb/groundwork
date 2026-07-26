# Decisions — Groundwork

Append-only. Every non-trivial decision — autonomous or escalated — gets a dated entry here. Do not edit or delete past entries; add corrections as new entries.

---

## 2026-07-26 — Install the missing `async-agent-graph-engineering` skill

**Made by**: Jeremy (Tier 3 — the build plan required stopping if the skill was missing, not substituting)
**Context**: The build plan's Section 0 and Section 11 both hard-gate on this skill being installed before the Guide Engine gets architected. It was not present in the environment.
**Options considered**: Substitute a different multi-agent method; reconstruct one from the build plan text via `skill-creator`; stop and ask.
**Decision**: Stopped, per the plan's explicit instruction. Jeremy supplied the skill as a zip; it was installed at `~/.claude/skills/async-agent-graph-engineering/`.
**Rationale**: The plan says "if it is not installed in this environment, stop and say so explicitly. Do not silently substitute." Section 5 calls the Guide Engine "the product. Everything else is plumbing." Substituting would have baked the wrong architecture into the highest-value part of the system.
**Outcome**: Skill installed and verified loadable. Build team designed against it.

---

## 2026-07-26 — Project scaffold lives at repo root, not `PROJECTS/groundwork/`

**Made by**: Jeremy (asked directly, Tier 3-equivalent — a structural call the AI could not make unilaterally)
**Context**: The build plan's literal text says the project lives at `PROJECTS/groundwork/`, following Jeremy's usual multi-project monorepo convention. But this GitHub repo (`jersilb1400/groundwork`) is already dedicated solely to Groundwork, and the subagent team (`.claude/agents/`, `docs/agent-team.md`) was already committed at repo root in a prior session.
**Options considered**: Follow the plan literally and nest everything under `PROJECTS/groundwork/`, including moving the already-committed agent team; or treat this dedicated repo's root as the project root.
**Decision**: Repo root is the project root. No `PROJECTS/` nesting.
**Rationale**: Nesting inside a repo that is already exclusively Groundwork would bury the Cloudflare Workers source three levels deep and contradict the already-committed subagent team's location. The `PROJECTS/<slug>/` convention exists for Jeremy's personal multi-project workspace, which this dedicated repo is not.
**Outcome**: Scaffold created at repo root.

---

## 2026-07-26 — $200/mo soft budget cap for the build phase

**Made by**: Jeremy
**Context**: The build plan gives a *target* cost model (LLM + transcription under 8% of amortized session-day revenue) but no absolute ceiling for pre-revenue build/dev spend (Cloudflare, Anthropic API, Stripe test mode).
**Decision**: $200/mo soft cap during the build phase. Anything trending to exceed it escalates via `templates/escalation-brief.md`.
**Outcome**: Recorded in `docs/economics.md` and `AI_CEO_INSTRUCTIONS.md` §4/§7.

---

## 2026-07-26 — Status reporting: `OUTPUTS/` files, event-driven only

**Made by**: Jeremy
**Context**: Neither channel nor cadence for status reports/escalation briefs was specified in the build plan.
**Decision**: Log to `OUTPUTS/` (no Gmail integration for build-phase reporting). Cadence is event-driven — fires on phase-gate pass/fail and Tier 2/3 escalations — not weekly or daily.
**Outcome**: Recorded in `AI_CEO_INSTRUCTIONS.md` §5, `ops/schedules.md`.

---

## 2026-07-26 — No live Cloudflare resources during Phase 0

**Made by**: Claude (Tier 1 — a build-execution choice within already-approved scope, logged per protocol)
**Context**: The Phase 0 gate requires `wrangler dev` to run and migrations to apply. Real D1/R2/KV creation is billed infrastructure tied to Jeremy's Cloudflare account.
**Decision**: Phase 0 uses wrangler's local emulation only (`wrangler dev` local mode, `wrangler d1 migrations apply --local`). No real cloud resources created.
**Rationale**: Creating billed resources under someone's account without them present is exactly the kind of consequential, hard-to-reverse action that should be confirmed first, and the gate doesn't require it — local emulation satisfies "wrangler dev runs, migrations apply" without touching production infrastructure.
**Outcome**: `docs/capability-gaps.md` notes live provisioning as a deferred gap requiring Jeremy's credentials.

---

## 2026-07-26 — Groundwork is a placeholder name

**Made by**: Jeremy (pre-existing, restated from the build plan §2.4)
**Context**: "Groundwork" is a crowded common word; `groundwork.com` is unavailable; the one registered GROUNDWORK software-class mark lapsed un-revivably. Recommended path is registering "Groundwork Labs" as the formal mark, using "Groundwork" conversationally.
**Decision**: Treat the name as unsettled everywhere. USPTO TESS search (classes 041/042), domain check, and an attorney opinion letter happen before any branding spend.
**Outcome**: Restated in `README.md`, `AI_CEO_INSTRUCTIONS.md` Tier 3, and `.claude/agents/ip-firewall-guardian.md`.
