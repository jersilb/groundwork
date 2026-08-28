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

## 2026-08-17 — Cloudflare Access auth wired

**Decision**: Implement Cloudflare Access JWT validation in the Worker for all
state-changing routes. Org-scoped routes additionally check that the
authenticated email has a row in the \"user\" table for that org.

**Rationale**: The project had chosen Cloudflare Access on 2026-07-31 but had
not wired it; every POST/PUT route was open. Clerk would add a vendor and cost;
API-key gating would be a temporary hack. Cloudflare Access matches the
existing deployment stack and provides identity-aware zero-trust access with no
extra application dependency.

**Implementation**: \"src/auth/cloudflare-access.ts\" validates the
CF-Access-Jwt-Assertion header against the team's public keys when
CF_ACCESS_TEAM_DOMAIN is set. Local dev uses X-Groundwork-Dev-User/Sub headers.
Program, commerce, audio, and synthesis routes now extract auth context and
check org membership. Org creation automatically creates the creator as a
leader user.

**Consequences**: All integration tests now send dev auth headers. Unknown
resources return 403 (not 404) for authenticated requests to avoid org
enumeration. The shared-screen WebSocket still allows anonymous phone
participants by room code; only HTTP leader actions require auth — this is
intentional per the product design.

## 2026-08-27 — Deep-dive hardening + the Guide Engine wired live

**Made by**: Buffy (Codebuff) at Jeremy's direction; full findings in
`OUTPUTS/deep-dive-report-2026-08-27.md`.

**Decisions**:

1. **The Guide Engine now runs inside the live session** (`src/session-do.ts`
   + `src/guide-engine/session-guide.ts`). PACER rides the existing 30s
   alarm; EVALUATOR runs on new submissions past a floor of 2, at most
   once per 30s; PROBER answers thin/off_track/stuck verdicts;
   SYNTHESIZER runs at segment boundaries and persists provenance-verified
   artifacts server-side. The guide never mutates planning state and never
   advances segments (§5.5 stays absolute) — it speaks through
   `guideLog` entries carried in the normal state broadcast.
2. **`GUIDE_ENABLED` master switch** ([vars] in wrangler.toml = "true";
   `.dev.vars` = "false" locally) so no test depends on a live LLM.
3. **`/webhooks/*` exempted from the auth gate** — Stripe's servers cannot
   present a CF Access JWT; the webhook authenticates via its HMAC
   signature. Before this, `POST /webhooks/stripe` was 401-dead in
   production (the auth gate ran before routing on all non-GETs).
4. **Session-scoped routes authorize the org** (`src/auth/authorize.ts`):
   real lab rooms (`lab-<id>` keys) require org membership on synthesize,
   plan GET, consent, kill-switch, and chunk upload. Ad-hoc test sessions
   keep the open behavior so the harness is unaffected. This closes the
   gap where any authenticated user of any org could write artifacts into
   another org's session or read its plan.
5. **Screen-role authorization**: `POST /lab-session/:id/open` (now
   leader-only) mints a `screen_token` (migration 0005); the SessionDO
   validates it for screen-role WebSocket connections on `lab-` rooms.
   The token never lingers in the projected URL bar — RoomScreen strips
   `?st=` after capture and mirrors it to sessionStorage.
6. **SessionDO input hardening**: unknown segment keys rejected;
   submissions capped at 2,000 chars / 100 per segment; vote option ids
   capped at 200 chars (caps in `src/session-protocol.ts`).
7. **Prompt upgrades** (EVALUATOR/PROBER/SYNTHESIZER): facilitator-grade
   quality bars, specificity standards, doctrinal-neutrality guardrails;
   JSON contracts unchanged so all parsing tests still pass.

**Consequences**: `review-cycle/:id/complete` now rejects a `programId`
from another org; COACH nudge failures degrade per-step to the template;
Stripe `customer.subscription.deleted` clears `subscription_tier`; audio
chunks cap at 10 MB; queue consumer retries cap at 5; `CF_ACCESS_AUD`
(audience binding) is enforced when configured. New test:
`test:guide-runtime`; `test-session-integration` covers the screen-token
gate; smoke-web's exit-code bug (could never exit 0) fixed.
