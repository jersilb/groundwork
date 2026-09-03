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

## 2026-08-28 — AI Instructor team constituted; console is design-system-first, voice deferred

**Made by**: Buffy as ai-director; per Jeremy's direction (sub-agent team for
`docs/ai-instructor-tech-scope-build-plan.md`; "highest reasoning"; frontend-design
skill for the console design).

**Decisions**:
1. **Team topology follows the existing diamond** (`docs/agent-team.md`): orchestrator
   brain, 3–4 concurrent hands max, reducer fan-in, clean-context verify. The AI
   Instructor program is a *new campaign over the existing graph*, not a competing graph.
   New roster: `instructor-ux-designer` (owns console + participant surfaces),
   `session-orchestrator-engineer` (owns itinerary/state-machine/clock — the riskiest
   workstream), `instructor-runtime-engineer` (owns Guide identity + typed actions),
   `reliability-rehearsal-engineer` (owns degraded modes + 14-scenario harness).
   Existing nodes (session-spine, frontend-ux, synthesis, evaluator, resilience,
   curriculum-author, integration-reducer, clean-context-verifier, ip-firewall-guardian)
   are reused, not duplicated.
2. **§5.5 interpretation resolved**: the "leader override is absolute" invariant and the
   new typed `GuideAction` coexist — the Guide may *speak* (recommend/instruct/ask) but
   every *state transition* still requires a human action or a curriculum-defined
   deterministic trigger. This is logged now because both R1 and R2 depend on it.
3. **Model-tier policy**: smart-model rubric scored per task brief, not per agent.
   Session-orchestrator and clean-context-verifier default Expert; instructor-runtime
   Balanced; instructor-ux Balanced (Expert for the console visual system); reliability
   Balanced (Fast for fixture-boilerplate tasks). Hard rule override: any task touching
   consent, screen-token auth, or checkpoint recovery routes Expert regardless of score.
4. **Console is design-system-first**: `frontend-design` skill applied to the existing
   Fraunces/Sora "planning-room" tokens (theme.css) — the AI instructor surface must look
   like the same product that already ships. Voice (R6) is explicitly deferred; no voice
   work starts before R4 exit.

**Consequences**: new `.claude/agents/` cards + `docs/ai-instructor-agent-team.md`
roster; `.context/` bootstrapped (CONTEXT.md, VERIFY.md, DECISIONS.md, LESSONS.md);
console mockup is the first design deliverable, gated on the existing theme tokens.

---

## 2026-08-28 — Demo reference pack + curriculum-as-data wiring

**Decision**: The guide must consume compiled curriculum by key, and a synthetic
`content/packs/_demo/` pack should exist for test labs until organic content lands.

1. **`specFor()` resolves specs by segment key** (demo/reference first, generic
   fallback). All three live call sites in `session-do.ts` use it. Real packs plug
   into the same seam — when `content/packs/church/` ships, matching keys upgrade
   the Guide with no runtime change.
2. **`_`-prefixed packs are compiled separately**: `scripts/compile-segment-specs.ts`
   splits live vs reference dirs. Reference content emits to
   `src/generated/demo-segment-specs.ts` and is NEVER merged into the shipped
   `SEGMENT_SPECS` — so demo content cannot be mistaken for curriculum in prod.
3. **The demo pack is synthetic + IP-safe**, built from the build plan §7 reference
   itinerary and the §2.5 "what is safe" vocabulary. It is NOT real curriculum; it
   exists so a rehearsal room exercises segment-specific objectives/rubrics.
4. **Rehearsal is deterministic**: `test:demo-pack` (24 checks) resolves the arc and
   asserts PACER behavior across all nine segments with no LLM/key. Wired into the
   Phase-2 CI gate.
5. **IP firewall re-verified for untracked content**: `lint-vocabulary` only scans
   tracked files, so the new `_demo` YAML + report were scanned directly — 0 banned
   terms across all 14 new files before landing.

**Consequences**: `specFor()` seam (the better-feature fix); `_demo` pack runs a
5h15m rehearsal instead of the 7-minute fake lab; flagged-but-deferred: BreakSpec/
BreakoutSpec (Release-2) and observable `vote_completed` for the leader (M4).

## 2026-08-28 — Session spine shipped (Releases 0–2 core + console + phone identity)

1. **Canonical plan schemas + reference itinerary** (`src/session-plan.ts`): SessionPlan /
   SegmentPlan / BreakSpec / BreakoutSpec / ClosingSpec with cross-reference validation
   (unique keys, anchor existence, no double anchors, exact plan-total match, closing buffer
   fits the final segment). BreakSpec and BreakoutSpec both anchor to segment keys, and a
   breakout is the small-group delivery mode INSIDE its segment's window — this keeps the
   315-minute demo pack + three 15-minute breaks = exactly 360 minutes, one-to-one with the
   build plan §7 itinerary.
2. **Pure runtime** (`src/session-runtime.ts`): typed SpineActions, deterministic state machine
   (setup→active→break→breakout→closing→complete with reentry transient), SessionClock with
   instant-by-instant drift arithmetic (planned consumed = completed planned + min(current
   elapsed, current planned)), break lifecycle with protected minimums (forced early end is a
   recorded override), output audit with auto rules (statement = submission floor, ranking =
   ≥2 votes, owners/actions/cadence = leader mark) and a closing gate that blocks silent
   completion, capped event log, recommendation queue with leader-only decisions.
3. **DO wiring behind `SESSION_SPINE`** (env flag; [vars] not yet set in prod until Jeremy
   approves): spine sessions run the reference plan; legacy sessions unchanged. Instructor
   actions arrive as one `spine_action` message (screen-gated), deduped by `actionId` so a
   reconnect replay can never double-advance. Participant corrections arrive as
   `guide_feedback` and land as parked issues + events — never mutations.
4. **Vote quorum surfaced** (team-review fix): when every connected phone has voted, the room
   hears it once (L5 dedupe per segment).
5. **PACER budget fix** (team-review fix): remaining budget now subtracts cumulative overrun of
   completed segments and breaks, so an extend decision can no longer silently consume the next
   segment's time.
6. **Instructor console** (`/console/:key`, React, planning-room design system): clock ribbon
   with drift, sponsor controls with Esc-pause and two-step emergency stop, recommendation
   queue (accept/edit/dismiss/defer with recorded decisions), itinerary with break/breakout
   state, Guide's voice with why-lines, output audit with leader mark buttons, room health from
   broadcast presence, full event/override history. Screen-token auth inherited; console link
   added on the leader's room screen.
7. **Phone identity + correction** (build plan §6 R1): AI-instructor contract card on the
   welcome segment, persistent AI-led chip, and a "correct the Guide" affordance under every
   probe (only on spine sessions — no silent no-ops on legacy rooms).
8. **Verification added**: `test:session-plan` (12), `test:session-runtime` (19),
   `test:six-hour-simulation` (11: drift 15/30/60 ladder, buffer protection, restart resume,
   6 degraded scenarios), and `test:spine-integration` (22 live-protocol checks against a real
   wrangler dev, incl. DO eviction + runtime restore). Legacy regression suites unchanged and
   green. CI phase-2 and phase-1 jobs extended.

## 2026-08-31 — Session spine, instructor console, phone Guide shipped (a216f37)
- Implemented build-plan §5/§6: SessionPlan schema + pure runtime (state machine, clock with drift, break lifecycle with clock freeze, output audit, event log) in `src/session-plan.ts` / `src/session-runtime.ts`.
- Wired the spine into the SessionDO behind `SESSION_SPINE` with server-side action-id dedupe (replay double-advance attack closed) and `stateVersion` bumps on every spine mutation (client convergence + D1 checkpoints depend on it).
- Shipped the React instructor console (`/console/:sessionKey`) from the approved mockup design: clock ribbon, sponsor controls, Guide recommendations with Accept/Edit/Dismiss, itinerary health flags, room presence.
- Shipped the phone Guide identity card + operating contract and the correction affordance (spine sessions only — the server actually records corrections there).
- Break semantics decided: a break anchors to the boundary AFTER a completed segment; the next segment's clock does not run during the break; planned consumed = completed planned + min(current elapsed, current planned).
- New permanent gates: `test:session-plan` (12), `test:session-runtime` (19), `test:six-hour-simulation` (11, injected clock + degraded scenarios), `test:spine-integration` (22 against real wrangler dev) — all wired into CI.
- Verified: typecheck, guide-runtime 9/9, pacer 6/6, demo-pack 24/24, vocab lint clean, build:web green. Deployed to groundwork.jersilb.workers.dev (root 200, session route 200).

## 2026-08-31 — Full verification sweep (user-simulation audit, session 2)
- Re-ran the complete gate set on the committed spine batch (a216f37): typecheck, session-plan 12, session-runtime 19, six-hour simulation 11, guide-runtime 9, pacer 6, demo-pack 24, evaluator/prober parsing, spine integration smoke 22, phase1-multiclient, phase3-resilience (submission/vote replay) — all PASS.
- Live-server verification (wrangler dev, local): / 200, /session-plans/reference 200 (9 segments / 3 breaks / 2 breakouts / 360 min), /console/:key 200, /session/:key 200.
- Live-asset sanity: PWA manifest + cache manifest regenerate; console route serves the React app shell.
- No new defects found in this sweep. Known open items unchanged: BreakSpec/BreakoutSpec (Release 2), degraded-mode replay harness extension.

## 2026-09-02 — P0: demo↔spine key alignment + LLM→console bridge

1. **Demo pack keys are hyphenated** to match `SPINE_REFERENCE_PLAN` (`s2-current-reality`,
   `s9-closeout`). Underscore keys were causing `specFor()` misses and generic rubrics.
   `normalizeSegmentKey` / dual-index alias keeps legacy underscore lookups working.
2. **`SESSION_SPINE` stays unset** in `[vars]` — keys are wired; enabling remains Jeremy's
   explicit env change (documented in `wrangler.toml`).
3. **LLM Guide speech bridges to the console recommendation queue** via
   `enqueueGuideRecommendation` (probe/evaluator/pacer/synthesis → Accept/Edit/Dismiss).
4. **EVALUATOR remasured** on Anthropic: thin precision **1.000** (16/16 clean) — gate PASS.
   Workers AI / Anthropic stack unchanged; not blocked on Grok.

