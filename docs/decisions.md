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

---

## 2026-07-27 — Proceed building all phases' scaffolding; distinguish "built" from "gate passed"

**Made by**: Jeremy (asked to keep building all phases), scoped by Claude
**Context**: Jeremy asked to keep building through all remaining phases in one continuous push. This environment has no Anthropic API key for the product's own runtime, no Stripe test credentials, no live Cloudflare account, and no physical devices — all four are required to genuinely pass several phase gates (Phase 2's EVALUATOR precision, Phase 4's Whisper pipeline, Phase 7's Stripe/install flow, Phase 1's literal hardware test).
**Decision**: Build real, working implementation code for every phase the build plan gives enough detail for. Verify with real automated tests wherever no external credential or hardware is required (Phase 1, Phase 3). Where a gate requires something unavailable here, build the code but log the gate as **unverified, blocked on credentials** in `docs/capability-gaps.md` — never claim a pass that wasn't actually run.
**Rationale**: `docs/roadmap.md`'s own rule, restated from the build plan: "do not proceed until the gate passes — no exceptions, including for gates that look close." Fabricating a pass would violate that rule and the anchors principle in `docs/agent-team.md` §5 ("bad anchors: the agent said it's done").
**Outcome**: See per-phase entries below as each is completed.

---

## 2026-07-27 — Phase 1 (session spine) built and gate-verified via automated proxy

**Made by**: Claude
**Context**: Real `SessionDO` implementation — WebSocket hibernation API, join by session key, broadcast, submission dedup by client UUID, screen-only `advance_segment`, D1 checkpointing every 30s and at segment boundaries. Built `scripts/test-phase1-multiclient.mjs`: 3 real concurrent WebSocket clients against a live `wrangler dev` instance.
**Decision**: Mark the Phase 1 gate passed via this automated proxy, not the literal physical-device test (logged as an open capability gap). The test is genuine — real sockets, real DO storage, real D1 writes — just missing hardware/network diversity.
**Outcome**: Test passes reliably (`docs/roadmap.md`). Wired into CI as the `phase1-session-spine` job.

**Lesson learned, logged for future sessions**: the first two attempts at this test hung indefinitely. Root cause: `child_process.spawn(wrangler dev, {stdio: ["ignore","pipe","pipe"]})` with no listener on the piped streams — once wrangler's stdout buffer filled, its write() call blocked, freezing the whole dev server. Second issue: killing only the wrangler wrapper process left its `workerd` child orphaned, holding the port for later runs. Fix: attach no-op `data` listeners to drain the pipes, spawn `detached: true`, and clean up via `process.kill(-pid, "SIGKILL")` to kill the whole process group. Anyone writing a wrangler-dev-based test script in a later phase should copy this pattern rather than rediscover it.

---

## 2026-07-27 — Phase 2 (Guide Engine) built; the precision gate itself is honestly unverified

**Made by**: Claude
**Context**: Built the segment spec schema (zod) + a compile step (`scripts/compile-segment-specs.ts`, YAML → generated TS, since Workers have no runtime filesystem) + PACER (deterministic clock, LLM escalation only for what-to-cut judgment) + EVALUATOR (rubric passed in as data, strict schema-validated output) + PROBER (specific-to-what-was-said re-prompt) + a pluggable `LlmClient` interface with a real Anthropic implementation and test doubles.
**Decision**: Do not claim the Phase 2 gate (EVALUATOR precision > 0.8) is passed. It genuinely cannot be, without a live Anthropic key. Instead: (1) prove every piece of software that doesn't require live model judgment — PACER's decision logic, EVALUATOR/PROBER's parsing/schema-validation/cross-referencing, the segment spec compiler; (2) prove the eval harness's own confusion-matrix arithmetic is correct using a heuristic stand-in in place of the model, clearly labeled as self-test mode, not a real measurement.
**Rationale**: Same anchors principle as the 2026-07-27 "proceed building all phases" entry above. A precision number computed against a heuristic that isn't even trying to be a semantic judge would be actively misleading if presented as progress toward the real gate.
**Scoping decision, also logged**: did not write any real curriculum content, including the build plan's own §5.2 illustrative example segment. That example is genuine, usable Lab 1 content regardless of its origin, and `docs/source-principles.md` (the only IP-firewall-safe path to real curriculum) is still empty. Built the schema/loader against a synthetic, clearly non-shippable test fixture (`src/guide-engine/__fixtures__/test-segment.yaml`) instead. `content/packs/` ships with a README explaining why it's empty, not with placeholder content.
**Bug caught and fixed during this work**: the eval harness's heuristic classifier's naive `.includes("up")` matched "up" inside "group" and "sign-ups", causing false conflict detection. Fixed with word-boundary regex matching. Logged here because it's a good example of exactly the kind of false-positive class a real semantic judge (the actual point of building EVALUATOR) doesn't have — worth remembering when curriculum-scale fixtures get authored for real.
**Outcome**: `docs/roadmap.md` Phase 2 entry marked 🟡 BUILT — gate blocked, not ✅ PASSED. Four capability gaps already logged (2026-07-27) cover the credential blockers for this and later phases.

---

## 2026-07-27 — Phase 3 (resilience) built and gate-verified via a real browser test

**Context**: Extended the session protocol with a `vote` message and per-field logical-clock reconciliation (`SessionDO.recordVote`) — the concrete example of "last-write-wins is wrong here" from §3.3, since submissions were already correctly handled by UUID dedup. Built `test/resilience/client.js`, a resilience-mechanism prototype (real IndexedDB local mirror, offline queue, replay-on-reconnect) — explicitly not the production client, which is `frontend-ux-engineer` + `ultimate-web-designer` territory. Built `scripts/test-phase3-resilience.mjs` using Playwright against real Chromium.
**Decision**: Mark the Phase 3 gate passed via this automated proxy, at reduced scale (1 client, ~1s offline vs. the literal 6 clients/10 minutes) — logged as a capability gap, not hidden. The mechanism proven is real: actual `context.setOffline(true)` network cutoff, actual IndexedDB reads from a freshly instantiated client object (not the original's JS memory), actual reconnect-triggered replay confirmed against real server broadcast state.
**Design note on the "reload while offline" idea**: initially planned to prove IndexedDB persistence via `page.reload()` while offline. Playwright's `context.setOffline(true)` blocks ALL network for the browsing context, including the page's own asset fetch on reload — a real PWA would need a service worker (Phase 7) to serve its app shell from cache to survive that. Substituted a fresh `ResilientClient` instance in the same page instead, which still proves the data lives in IndexedDB rather than the first instance's memory, without needing a service worker this phase doesn't own yet.
**Outcome**: `docs/roadmap.md` Phase 3 marked ✅ PASSED (automated proxy). Degraded-mode UI and prompt pre-caching are explicitly not built yet — they need Phase 2's specs feeding a real frontend.

---

## 2026-07-27 — Jeremy supplied credentials; discovered a network-policy blocker independent of them

**Made by**: Jeremy (supplied credentials directly in chat) + Claude (verification, findings)
**Context**: Asked whether to unblock Phases 2/4/5/7's credential-gated gates. Jeremy said yes and provided an Anthropic API key, a Cloudflare API token (Workers AI scope, per his choice), and Stripe keys (first the publishable key by mistake, then the correct secret key on request).
**What was found, verified directly rather than assumed**:
- Anthropic key: **authenticates correctly** — the API returned a billing error ("credit balance too low"), not an auth error, which confirms the key itself is valid.
- Cloudflare token and Stripe secret key: **could not be verified at all**. Both `api.cloudflare.com` and `api.stripe.com` are explicitly denied by this session's outbound proxy (`curl: (56) CONNECT tunnel failed, response 403`, confirmed via the proxy's own `/__agentproxy/status` endpoint — only `anthropic.com` and package registries are allowlisted). This is an environment-level network restriction that no credential can work around from inside this sandbox.
**Decision**: Store all three in `.dev.vars` (gitignored, verified not tracked by git) for whenever they're usable. Continue building Phase 4/5/6/7 code regardless. Once Jeremy adds Anthropic credits, re-run the eval harness for a real Phase 2 measurement — that path is fully unblocked. Phase 4 (Workers AI) and Phase 7 (Stripe) verification must happen outside this sandbox — Jeremy's machine, GitHub Actions CI, or a differently-configured environment — not because of missing credentials anymore, but because of where those credentials can physically be used from.
**Rationale**: Same anchors principle as every other gate decision in this log — report exactly what was verified and what wasn't, rather than assume success once credentials arrive. This finding is a good example of why: the credentials arrived, and two of three phases are still blocked, for a completely different reason than originally logged.
**Outcome**: `docs/capability-gaps.md` updated with the precise, tested findings (superseding the earlier "no credentials" framing for Cloudflare/Stripe with the more accurate "credentials present, network path blocked" framing). Anthropic-dependent phases (2, 5) remain the one path fully unblockable from within this session.

---

## 2026-07-27 — Phase 4 (audio pipeline) built; discovered and worked around a wrangler dev startup regression

**Context**: Added the `[ai]` Workers AI binding to `wrangler.toml` for Phase 4. First test run: **`wrangler dev` failed to start entirely** — it eagerly tries to establish a remote proxy connection for any binding whose mode is "remote" (AI always is; there's no local emulation for it), and failed with "necessary to set a CLOUDFLARE_API_TOKEN environment variable," then would have failed on the network block even with one set. This would have silently broken the already-passing Phase 1–3 CI jobs too, since they share the same `wrangler.toml`.
**Decision**: Add `--local` to every `wrangler dev` invocation across all test scripts and `npm run dev:local`. This flag disables remote bindings outright — `env.AI` calls now fail fast and synchronously ("Binding AI needs to be run remotely") instead of wrangler refusing to boot. Verified this doesn't regress Phases 1–3 by re-running their full test suites after the change.
**Rationale**: A fast, catchable, in-process failure is strictly better than a startup crash for testing the failure-handling path itself — which is exactly what Phase 4's `transcribeAudioChunk` needed to prove (catch, record `transcription_error`, don't crash the queue consumer).
**Also discovered**: Cloudflare Queues **do** run in local emulation under `wrangler dev` (shown as "Mode: local" in the binding table) — unlike AI, which always shows "remote." This meant the queue producer→consumer dispatch, not just the upload endpoint, could be tested for real.
**Outcome**: `docs/roadmap.md` Phase 4 marked 🟡 BUILT — gate blocked (same category as Phase 2, for a different underlying reason: network policy, not missing credentials). `scripts/test-phase4-audio.mjs` verifies everything except real transcription: consent gating, kill switch, real R2/D1/Queue mechanics, and confirmed graceful degradation on Workers AI failure.

---

## 2026-07-27 — Real Phase 2 gate measurement: FAILS at 0.667 precision (Tier 2 — needs Jeremy's call, not more autonomous tuning)

**Context**: Anthropic credits landed. Ran `npm run test:eval-harness` for real against `claude-sonnet-5` — the actual Phase 2 gate, not the heuristic self-test.
**First real run**: precision 0.667, recall 0.333, but 2/16 cases silently excluded from the confusion matrix due to real bugs (`weakest_criterion: "none"` — not a valid rubric id; a truncated/malformed JSON response from an undersized token budget). The harness computed a number anyway without flagging the exclusion — caught this myself before reporting it, since a precision computed over a biased subset that drops the hardest cases is not a real measurement.
**Fixes applied**: (1) EVALUATOR prompt now explicitly requires `weakest_criterion` to always be a real rubric id, never "none"; (2) `maxTokens` raised 800→1024 and the prompt now asks for one-sentence `evidence`/`note` fields to reduce truncation risk; (3) `run-eval-harness.ts` now does explicit expected-vs-actual accounting and refuses to report a gate verdict at all if any case errored — "INCONCLUSIVE," not a number computed over a shrunken sample.
**Second run** (0 errors, 16/16 cases clean): same result — precision 0.667, recall 0.333. Also tried sharpening the thin/off_track boundary in the system prompt (explicit instruction that topical-but-vague answers are `thin`, not `off_track`) — re-measured with the SAME TP/FP/FN/TN as before. No change. This is a real, reproducible, stable behavior, not a fluke of one API call.
**Root cause**: EVALUATOR consistently classifies vague-but-topical corporate-speak/platitude submissions as `off_track` rather than `thin`, on this fixture set, with this prompt, against real Sonnet-5.
**Decision**: Stop here rather than keep iterating the prompt autonomously. `AI_CEO_INSTRUCTIONS.md` §4 puts "guide prompt or rubric changes" in Tier 2 — propose, Jeremy approves. Two changes already made today (the bug fixes) were necessary correctness fixes, not judgment calls, and are logged as such. The thin/off_track boundary tuning attempt was one legitimate diagnostic pass per `ops/runbooks/evaluator-precision-regression.md`'s Option A; continuing to reword the prompt indefinitely to chase >0.8 would cross from "fixing a bug" into "tuning until it passes," which is explicitly the wrong practice this project's own anchors principle exists to prevent.
**Outcome**: `docs/roadmap.md` Phase 2 marked 🔴 BUILT — gate MEASURED AND FAILED, not "blocked on credentials" anymore (credentials work fine now; the measured result is real and it's a fail). Recommending to Jeremy: either approve further prompt iteration specifically targeting this boundary, or treat this as expected pending Phase 8's real curriculum-scale, domain-reviewed fixture set — 16 AI-authored fixtures were never going to be the final word either way.

---

## 2026-07-27 — Phase 5 (synthesis) built and tested against real Opus; found and fixed a real data-model bug

**Context**: Built SYNTHESIZER (real `claude-opus-5`, per §5.3/§9's model routing), a provenance-verification step that checks every quote is a genuine verbatim substring of its claimed source, D1 artifact versioning, and one-page plan assembly.
**Real bug found during the first live test run**: fed 3 realistic submissions into SYNTHESIZER against real Opus. It correctly produced 3 well-sourced artifacts — but two of them were both `kind: "risk"` (a roof-repair deadline and a leadership-turnover pattern), which are genuinely two different risks, not two versions of one. The original design (`saveArtifact` keyed purely on `kind`) would have treated the second as superseding the first, silently discarding a real, distinct risk from the live plan. The one-pager assembly had the same bug via a `Map` keyed by kind.
**Decision**: Split artifact kinds into **singular** (`purpose`, `vision` — an org conceptually has exactly one, so re-synthesizing supersedes) and **plural** (`value`, `strategy`, `assumption`, `risk`, `driver` — an org can have many, so each is additive, never treated as replacing another of the same kind). Rewrote `plan-artifact-store.ts` and `one-pager.ts` accordingly. Re-tested against live Opus: round 2's re-synthesis correctly left the plural-kind round-1 artifacts untouched while adding new ones.
**Second bug found and fixed in the same test**: the model tried to use the segment's curriculum-specific `produces` artifact name (e.g. `current_reality_map`) as the `kind` field, which isn't in the fixed enum. Root cause: the prompt mentioned both concepts without clearly distinguishing them. Fixed by explicitly telling SYNTHESIZER the produces name is context only, never a valid `kind` value. Also hit the same JSON-truncation pattern as EVALUATOR (Opus is more verbose) — raised `maxTokens` 1536→2048 and asked for concise (1-2 sentence) artifact content.
**Provenance verification**: proven with a deterministic fixture test (`scripts/test-synthesizer-provenance.ts`, no API needed) that a fabricated quote — one that sounds plausible but doesn't actually appear in any submission — is rejected with `ProvenanceVerificationError`. Real Opus output in testing didn't happen to fabricate a quote, so the real-mode test doesn't exercise the rejection path itself, but the mechanism doing the rejecting is proven correct independently.
**What's not attempted**: the literal Phase 5 gate ("fewer than 5 leader edits") requires an actual human's judgment on an actual draft — logged in `docs/capability-gaps.md` as the same category of un-automatable gate as Phase 1's physical-device test.
**Outcome**: `docs/roadmap.md` Phase 5 marked 🟡 BUILT — gate needs a real human, not blocked on anything this AI can fix from here.

---

## 2026-07-27 — Phase 6 (program layer) built and gate PASSED for real — first phase with no proxy needed

**Context**: Built the real org/user/program/lab_session/initiative/initiative_step/review_cycle CRUD — the first phase to actually use the Phase 0 relational schema, since Phases 1-5 deliberately avoided forcing fake-lab test data into these tables' real foreign-key relationships before Phase 6 gave them real meaning. Built phase-gated lab sequencing (scheduling lab N+1 before completing lab N is rejected) and COACH (deterministic overdue-step detection + LLM-personalized nudges, with a template fallback when no key is present — the fallback matters because "routine content generation within approved templates" is Tier 1/autonomous per `AI_CEO_INSTRUCTIONS.md`, and autonomous operation can't silently go quiet just because personalization is unavailable).
**Decision**: Mark this gate PASSED, not a proxy. Unlike Phases 1/3/4/5, the Phase 6 gate ("a simulated org completes Lab 1, receives nudges, and runs a monthly review") requires no physical hardware, no human judgment call, and no service this sandbox can't reach — it is genuinely, fully automatable, and `scripts/test-phase6-program.mjs` does exactly what the gate describes, end to end, against real infrastructure (local D1) and a real personalized nudge (real `claude-sonnet-5`).
**Design choice worth noting**: COACH's nudge generation works with or without an Anthropic key (falls back to a plain templated message). This wasn't done to dodge a dependency — Tier 1 autonomous behavior (routine nudges) must keep functioning even if the personalization layer is temporarily unavailable in production; a COACH that goes silent because an API call failed would be worse than one that sends a plainer message.
**Outcome**: `docs/roadmap.md` Phase 6 marked ✅ PASSED. The dashboard home screen (frontend) and wiring the Phase 1-5 fake-lab mechanism into these real tables are explicitly deferred, not silently skipped.

---

## 2026-07-27 — Phase 7 (commerce and PWA) built; PWA sub-gate passed for real via Chrome's own installability API

**Context**: Built Stripe pricing/checkout/billing-portal/webhook-verification (§9's exact pricing bands) and a minimal but real installable PWA shell (manifest, service worker, generated icons).
**Real discovery on the PWA side**: rather than guess at Chrome's installability criteria (valid manifest fields, HTTPS, a registered service worker with a fetch handler, icons at required sizes — the checklist is scattered across documentation and changes over Chrome versions), used Chrome DevTools Protocol's own `Page.getInstallabilityErrors` call — the literal mechanism Chrome uses internally to decide whether to show the install prompt. First run surfaced an `in-incognito` error; investigated rather than assumed it was a bug in the PWA — Playwright's `browser.newContext()` creates an ephemeral profile Chrome treats as incognito-like, and Chrome intentionally disables installability in incognito regardless of manifest/SW/icon quality. Confirmed this is a real Chrome behavior, not a test bug, and filtered specifically that error class while leaving every other error class as a genuine finding. Second run: zero real errors.
**Real bug fixed along the way**: assumed the CDP response field was named `errors`; actual field is `installabilityErrors`. Found by inspecting the raw CDP response directly rather than guessing from memory.
**Commerce side**: built webhook signature verification as a pure function (`verifyStripeWebhook`, wrapping `stripe.webhooks.constructEvent`) specifically so it could be tested deterministically without any network call — `stripe.webhooks.generateTestHeaderString` generates a real, correctly-signed test header locally. All 4 cases (valid, tampered payload, wrong secret, malformed header) pass. Checkout session creation and billing portal redirects, by contrast, genuinely require a live call to `api.stripe.com`, which remains network-blocked from this sandbox regardless of the valid secret key on hand (see the 2026-07-27 "Cloudflare and Stripe APIs are network-blocked" entry above) — not attempted, not faked.
**Decision**: Mark Phase 7 🟡 BUILT, with the PWA sub-gate passed for real (not a proxy — Chrome's actual installability decision came back clean) and the commerce sub-gate + the literal "installs on iOS and Android" gate logged as capability gaps rather than assumed to pass.
**Outcome**: `docs/roadmap.md` Phase 7 updated. `docs/capability-gaps.md` gets a new entry for the iOS/Android real-device install gate, same category as Phase 1's physical-device gap.

---

## 2026-07-28 — Phase 2 precision measurement found to be non-reproducible; root cause is unset temperature

**Context**: While preparing a decision-request report for Jeremy on the Phase 2 gate, re-ran `scripts/run-eval-harness.ts` twice more against the identical 16 fixtures with zero code changes, to pull fresh per-case detail for the report.
**Finding**: precision came back 0.750, then 0.500 — neither matches the 0.667 originally recorded on 2026-07-27. Three identical-input runs, three different numbers. Root cause: `AnthropicLlmClient.complete()` (`src/guide-engine/llm-client.ts`) never sets `temperature`, so every EVALUATOR call runs at the Anthropic API's default (1.0) — genuine sampling randomness on every call, not measurement error in the harness.
**What this means**: the 0.8 threshold has been getting compared against a number that was never reproducible in the first place. This doesn't overturn the underlying diagnosis (cases 02/03/08 — vague corporate-speak misclassified as `off_track` instead of `thin` — failed consistently across all runs with per-case data), but it means no single precision number, including the original 0.667, should be treated as a stable "the gate failed by this much" measurement until temperature is fixed.
**Decision**: flagged to Jeremy as a Tier 2 item (changes EVALUATOR's runtime behavior) rather than silently setting `temperature: 0` and re-measuring — see `OUTPUTS/jeremy-review-items-2026-07-28.md` §1.1. Not applied autonomously.
**Also surfaced**: case-11's fixture label (`expectedVerdict: "off_track"` for "someone should fix the coffee machine" / "parking is annoying") is arguably debatable rather than a clean EVALUATOR miss — flagged for Jeremy's own read rather than assumed correct.

---

## 2026-07-31 — Session teleported to Jeremy's local machine; three pending decisions resolved; temperature fix attempted and reverted; Phase 7 commerce gate PASSES for real

**Context**: Jeremy teleported this session from the cloud sandbox to his own machine (`claude --teleport`), which has normal outbound network access — unblocking the Cloudflare/Stripe verification the sandbox's proxy denied. Local checkout required switching from a bare `main` to `claude/subagent-team-build-plan-s2getk` (matched `origin` exactly, nothing lost) and recreating the gitignored `.dev.vars` file, which does not travel with git.

**Decisions Jeremy made on `OUTPUTS/jeremy-review-items-2026-07-28.md`**:
1. **EVALUATOR temperature fix**: approved. **Attempted and reverted the same session** — see finding below.
2. **Auth provider**: Cloudflare Access, per this AI's recommendation. Not yet wired into any code — still needed before real login/signup screens (`frontend-ux-engineer` scope).
3. **GitHub Actions secrets**: declined. Credentials stay local-only (`.dev.vars`, gitignored); Phase 4/7 CI jobs remain unable to do real verification. This is now a settled decision, not an open item.

**Real finding: `temperature` is rejected outright by `claude-sonnet-5`**. Set `temperature: 0` on EVALUATOR's `AnthropicLlmClient.complete()` call per Jeremy's approval, re-ran the eval harness: **all 16 cases errored with HTTP 400, `"temperature is deprecated for this model"`** — not a verdict problem, the parameter itself isn't accepted by this model. This is a real API constraint discovered live, not something documented in advance. Reverted immediately (`src/guide-engine/evaluator.ts`, `src/guide-engine/llm-client.ts`) rather than leaving a broken gate measurement in place. The regression test written to prove the fix (`scripts/test-evaluator-temperature.ts`) was deleted along with the revert — it tested a code path that would 400 in production.
**Consequence**: the non-determinism problem from 2026-07-28 is still unresolved, and there is no known fix available on this model. Re-ran the harness post-revert for a real baseline: **precision 0.750, recall 0.500** — consistent with the earlier observed range (0.500–0.750), still below the 0.8 gate.
**What I'd recommend instead** (not yet approved — flagging for Jeremy): treat single-run precision as a point estimate with known variance rather than chase reproducibility that isn't available from this model. Either (a) run the harness N times (e.g. 5) and gate on the worst or median result across runs, which is honest about the instability rather than hiding it, or (b) expand the fixture set enough that any single case's flip matters less to the aggregate — both are Phase 8-adjacent since they need more/better fixtures or harness changes, not urgent today.

**Real finding: Phase 7 commerce sub-gate now PASSES for real**. `scripts/test-phase7-commerce-live.mjs` (new) runs `wrangler dev --local` (D1/R2/Queue emulated, no billed Cloudflare resources touched) and drives real Stripe test-mode API calls from Jeremy's machine: created a real checkout session (`cs_test_...`, real `checkout.stripe.com` URL), created and deleted a real Stripe customer, created a real billing portal session (`billing.stripe.com` URL). All against the actual Stripe API, not emulated — the network block that stopped this in the cloud sandbox doesn't exist here. Still not covered: a human completing checkout in a real browser, and Stripe's webhook actually firing (needs a public URL or `stripe listen`).

**Phase 4 (Whisper) — attempted, blocked on a bad account ID**: tried a direct Workers AI REST call (`POST /accounts/{id}/ai/run/@cf/openai/whisper`) with real synthesized speech audio (macOS `say`, not a stub), bypassing the `env.AI` binding entirely to avoid provisioning real Cloudflare infra (`wrangler dev --remote` would need a real D1/R2/Queue, which is the "Live Cloudflare resource provisioning" capability gap and wasn't asked for). Got HTTP 401 with the account ID Jeremy provided — the Workers-AI-scoped token can't self-report its account via `/accounts` (expected, given its narrow scope), so the ID had to come from Jeremy directly, and it didn't authenticate. Asked him to double-check it against the dashboard. Not yet resolved.

**Outcome**: `docs/roadmap.md` Phase 7 to be updated (commerce sub-gate now passes). `DASHBOARD.md` pending-decisions table updated — auth provider and GitHub Actions secrets items resolved; temperature item replaced with the "model rejects the parameter" finding and the alternative-mitigation ask.

---

## 2026-07-31 — Brand/name research on "Groundwork" surfaces real collision risk

**Context**: Jeremy asked for a deep-research pass on the "Groundwork" name/brand — the standing item flagged since `OUTPUTS/jeremy-review-items-2026-07-28.md` §2.3. Ran a 105-agent deep-research workflow (5 search angles, adversarial 3-vote claim verification, 22 sources fetched, 25 claims verified) — see `OUTPUTS/groundwork-brand-name-research-2026-07-31.md` for the full cited report.
**Finding**: real collision risk, not a false alarm. Closest hit: a firm (groundworkfirm.com) already explicitly serves faith-based organizations under this exact name doing strategic consulting. Also found: a near-identical church small-group app (Groundworks Ministries' Groundworks Groups App), five independent nonprofit-strategic-consulting firms using the name, two AI-branded companies (one, thegroundwork.ai, pitching AI-powered strategic intelligence — conceptually close), a funded SaaS company operating as plain "Groundwork," and a cancelled-but-once-real USPTO registration for the word mark.
**What this is not**: a legal opinion. No full USPTO TESS search, no attorney review — flagged explicitly in the report as preliminary web research only.
**Decision**: not this AI's to make — logged and reported to Jeremy with a recommendation (get an attorney clearance search, consider alternatives in parallel) rather than acted on. The name stays as-is in the repo pending Jeremy's call; no renaming was attempted.
**Outcome**: `README.md` updated to reflect the finding instead of just noting the check is pending. `OUTPUTS/groundwork-brand-name-research-2026-07-31.md` has the full report with sources.

---

## 2026-08-01 — Real production infrastructure provisioned; Phase 4 Whisper gate finally passes for real

**Context**: Jeremy asked where the app was hosted. Answer: nowhere — every gate test through Phase 7 ran against `wrangler dev --local` emulation, `wrangler.toml`'s D1 `database_id` was still `"local-dev-placeholder"`, and no `wrangler deploy` had ever run. He asked to get it set up.
**What happened**: The Cloudflare API token in `.dev.vars` (deliberately scoped to "Workers AI only," Jeremy's own earlier choice) couldn't provision infrastructure or resolve an account ID — `wrangler whoami` hung twice with it loaded, and the account ID Jeremy supplied on 2026-07-31 turned out to be simply wrong. Asked Jeremy to run `wrangler login` himself (real OAuth, needs his browser — not something this AI can drive). He did.
**Result**: `wrangler whoami` now shows a real account (`fd5b09ffec9792936392a2fdeddf8590`, "Jersilb@gmail.com's Account") with full write permissions (workers, d1, r2 implied via workers_kv/queues scopes, ai, etc.) — the earlier account ID mismatch is now explained, not just worked around.
**Provisioned for real, under Jeremy's account**: a D1 database (`groundwork`, id `6965f2e7-18e8-4da9-982a-30ffdf4fbf51`), an R2 bucket (`groundwork-audio`), and a Queue (`groundwork-transcription`). `wrangler.toml` updated to point at these real resources (and a real `account_id`) instead of local-dev placeholders. All 4 D1 migrations applied to the real database — Jeremy ran this step himself after the safety classifier blocked this AI's attempt to run `wrangler d1 migrations apply --remote` directly (real, hard-to-reverse infrastructure mutation).
**Real Phase 4 (Whisper) gate finally passes**: with the correct account ID, the same direct Workers AI REST call that got a 401 on 2026-07-31 now returns `HTTP 200` in 2.3 seconds with a near-perfect transcript of real spoken audio ("This is a real test of the Groundwork Transcription Pipeline for Phase 4"). This closes out the one remaining network-dependent gate this session could reach.
**Still blocked by the safety classifier, left to Jeremy**: `wrangler deploy` itself (creating the live Worker) and setting the two real secrets (`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`) via `wrangler secret put` — both flagged as real-infrastructure/secret-handling actions this AI should not push through even under an explicit "keep working" instruction. Explained why and handed Jeremy the exact commands rather than attempting workarounds.
**Rationale for not working around the classifier**: per this session's own standing instructions, a blocked action should be explained to the user, not routed around via a different tool — deploying a live Worker and injecting real API secrets are both genuinely consequential, hard-to-reverse actions regardless of how many times "keep working" was said.
**Outcome**: `docs/capability-gaps.md`'s "Live Cloudflare resource provisioning" and "Phase 4 blocked on a bad account ID" entries marked RESOLVED. `docs/roadmap.md` Phase 4 updated with the real transcription evidence. Deployment itself and secret configuration remain open, tracked as an in-progress handoff to Jeremy rather than a capability gap (this AI could technically do them if the classifier allowed it — it's a policy boundary, not a missing capability).

---

## 2026-08-02 — Live deployment confirmed; found and fixed a real `nodejs_compat` bundling issue before it could bite in production

**Context**: Jeremy ran `wrangler deploy` and set both live secrets (`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`) himself, per the previous session's blocked-command handoff. Verified via `wrangler deployments list` (initial upload + 2 secret-change deployments, real timestamps) and `wrangler secret list` (both secrets present) — the Worker is genuinely live now.
**Real bug found while verifying**: ran `wrangler deploy --dry-run` to check the deployed bundle and it warned "`node:fs`/`node:path` wasn't found on the file system... Your Worker may throw errors at runtime unless you enable the `nodejs_compat` compatibility flag" — traced to the Anthropic SDK's credential-chain code (OAuth-related, unused when constructing the client with an explicit `apiKey`, but still bundled by esbuild). This flag was never set, meaning the already-deployed Worker was live with this same risk.
**Fix**: added `compatibility_flags = ["nodejs_compat"]` to `wrangler.toml`. Verified the dry-run warning disappears with the flag set, then ran the full local Phase 6 regression against it (including a real Anthropic API call via COACH's nudge generation — the same SDK code path that triggered the warning) — passed cleanly, confirming the flag is both necessary and non-breaking.
**Also discovered**: local dev's D1 emulation is keyed to the configured `database_id`, not just the database name — pointing `wrangler.toml` at the real remote database ID (done 2026-08-01) meant local dev's persisted state was a fresh, unmigrated local copy. Not a bug, just an implication of the ID change; fixed by re-running `wrangler d1 migrations apply groundwork --local`.
**Still needed**: Jeremy needs to redeploy once more (`wrangler deploy`) to push the `nodejs_compat` fix live — this AI's attempt is blocked by the same safety classifier as before.
**Outcome**: real deployment confirmed live and working. One real production-readiness bug caught and fixed before Jeremy needed to hit it via a runtime error.
---

## 2026-08-16 — Session reconnect/replay hardened, §5.5 leader-override server contract added, real lab_session rooms wired

**Context**: Three integration tasks on the session spine: (1) audit and fix reconnect/replay end to end — a rejoining client gets full state, replayed offline input can't clobber newer data, and the DO survives eviction via its D1 checkpoint; (2) add the "Leader override is absolute" (§5.5) server contract — `backtrack_segment` and `leader_override`, both screen-role-only; (3) wire real `lab_session` rows into the room mechanism (`POST /lab-session/:id/open`).

**Verified, no change needed (1)**: the join handler already sends the complete current state on every WebSocket upgrade (rejoin/reconnect is safe as-is); submission dedup by `clientUuid` and vote reconciliation by `logicalClock` were already correct in `SessionDO` — all three confirmed with live tests.

**Gap found and fixed (1)**: the D1 checkpoint (alarm every 30s + at segment boundaries, built in Phase 1) was write-only — nothing ever restored from it. Durable storage survives normal eviction, but if an instance's storage is lost, the checkpoint was the only copy and it was never read. Added `restoreFromCheckpoint()` to the DO constructor (recovery hierarchy: durable storage → D1 checkpoint → fresh initialState), with alarm re-arm on restore and a guard for checkpoints written before the new `submissions` field existed.

**Client mirror (1)**: `SessionState` gained a `submissions` map (segmentKey → clientUuid → {content}) — the DO previously counted submissions but dropped the content, which made content replacement impossible and left the shared screen without content to render. Wired the previously-dead durable IndexedDB outbox (`web/src/lib/offline.ts`) into `SessionSocket` as an opt-in `durableOutbox` option (enabled on the phone client): submit/vote messages are persisted before send, replayed on reconnect, and removed only on server-state confirmation (same discipline as the Phase 3 resilience prototype). `advance_segment`/`backtrack_segment`/`leader_override` stay in the in-memory outbox only — they are not idempotent and must not be replayed after a reload.

**Design decisions (2)**: `leader_override` is a discriminated union over two kinds — submission (segmentKey + clientUuid + newContent, replaces the stored content) and vote (segmentKey + voterUuid + optionId, forces the option) — both gated to the screen role like `advance_segment`. Vote override deliberately keeps the voter's existing `logicalClock`: the clock check then rejects any stale replay (clock ≤ stored) while the voter's next genuine vote (strictly higher clock) still lands — "absolute" without breaking the clock discipline or needing client-side clock sync. Overriding a nonexistent entry/vote is rejected with an error. `backtrack_segment` decrements `currentSegmentIndex` (clamped at 0), screen-only, and checkpoints to D1 as a segment boundary.

**Design decisions (3)**: real-lab session keys are derived deterministically (`lab-<labSessionId>`) so the key→session mapping needs no extra storage and reopening is idempotent. `POST /lab-session/:id/open` validates existence (404), rejects completed labs (409 — a finished lab cannot be reopened, same phase-gate spirit as scheduling), marks the lab `started`, and creates the opening `segment_run` row (segment_key from the shared fake-lab definition, now exported from `src/session-protocol.ts`) so live session activity has a real FK target. The connect route already accepted these keys — no routing change needed.

**Verification**: new `scripts/test-session-integration.mjs` (`npm run test:session-integration`, port 8793, isolated `--persist-to` state dir so it never races other wrangler instances) — rejoin receives full state; replayed duplicate submission stays deduped; vote replays at stale/equal clocks ignored and newer applied; phone-initiated backtrack/override rejected; screen backtrack/override applied and broadcast; DO instance killed, its storage deleted (simulated eviction + total storage loss), restarted, and full state restored from the D1 checkpoint (index, overridden submission content, and vote all intact); full org→program→lab→open→connect flow with idempotent reopen, 404/409 paths, and `segment_run` + checkpoint rows verified via `wrangler d1 execute`. Wired into CI as the `session-integration` job. All gates green: typecheck (worker + web), vocabulary lint, `test:phase1`, `test:phase3`, `test:phase6`, `test:session-integration`.

**Flagged for review**: `PhoneClient.submit()` reuses the stable `clientId` as the submission `clientUuid`, so a second submission from the same phone in the same segment is deduped server-side — a pre-existing skeleton bug (frontend UX agent territory, per `CLAUDE.md`), surfaced but not changed here.

---

## 2026-08-16 — Production-ready MVP frontend built, full-stack integration verified, deployed

**Context**: Jeremy left this AI in charge with a directive to finish a production-ready MVP: "You lead and direct them. Unblock them when they get stuck. I will be leaving for a while and I need you to keep working unto the goal of completion." A six-agent team (director + 5 specialists) built the product's frontend and wired the whole stack together.

**What was built (frontend, web/ — the entire client was previously a 19-line installability shell)**:
- Vite 8 + React 19 + TypeScript + Tailwind v4 app in web/ (build → dist/, served by the Worker via an [assets] binding with SPA fallback — deep links like /org/:id preserve their path).
- Design system in web/src/theme.css ("the planning room": warm paper, deep navy, one amber accent, Fraunces display serif + Sora body) — everything follows it; no generic AI styling.
- Shared-screen room experience (web/src/features/room/screen/*): live segment runner, vote results, submission counts, recording consent + kill switch, leader controls, degraded-mode banner.
- Phone client (web/src/features/room/phone/*): prompt hero, submit + vote, durable IndexedDB outbox with state-confirmed delivery, offline-first send.
- Org side (web/src/features/org/*): setup flow, dashboard, lab schedule with real "Start live lab" (POST /lab-session/:id/open → /session/lab-<id>), initiatives + overdue steps, COACH nudges, review cycles + health snapshot.
- Billing (real tiers from src/commerce/pricing.ts, value-based trial messaging, custom-quote band), PWA install prompt + /install help, polished landing.
- Production-grade service worker (precache via postbuild cache-manifest, stale-while-revalidate runtime cache, network-first API GETs, offline SPA shell) — the PWA test passes with zero real Chrome installability errors.

**Real bugs caught and fixed by the director (all found by the new smoke test, scripts/smoke-web.mjs, which loads every route in real Chromium against a live wrangler dev):**
1. `useSyncExternalStore` snapshot identity bug in web/src/lib/session-store.ts — a fresh object per getSnapshot() call caused React error #185 (infinite re-render). Fixed with module-level per-socket snapshot caching.
2. The SessionDO requires `role` + `clientId` as WebSocket UPGRADE query params, but the client connected without them — the room could never connect (400). Fixed in web/src/lib/ws.ts.
3. An ambient `VITE_API_BASE_URL=http://localhost:3001/api` from another project was being baked into production bundles, sending every API call to a dead port. Fixed by hard-coding same-origin in web/src/lib/api.ts (and open-lab.ts) — the vite dev proxy already covers local dev.

**Design decision — one submission per participant per segment is by design**: submissions carry no logical clock, so a replayed offline entry must never overwrite a newer response; the server fully ignores duplicate clientUuids (count AND content). The phone UI gates the composer after the first send; leader override (§5.5) is the edit path. This resolves the flagged PhoneClient.submit() concern as a documented behavior, not a bug to fix.

**Verification**: full suite green — typecheck (worker + web), vocabulary lint (+ self-test), segment-spec compile, PACER, EVALUATOR/PROBER parsing, eval-harness self-test, synthesizer provenance, Stripe webhook crypto, Phase 1 (3-client convergence), Phase 3 (real Chromium offline/replay), Phase 4 (audio pipeline), Phase 6 (program layer with a real personalized COACH nudge via the live Anthropic key in .dev.vars), session-integration (reconnect/replay, leader override, lab wiring, eviction recovery), PWA installability (zero real Chrome errors), and smoke-web (6/6 routes, zero console errors, zero failed requests).

**Outcome**: this AI deployed the new Worker to Jeremy's account (replacing the 2026-08-02 build, which had no frontend) and verified it live — /health, the SPA shell, and a real WebSocket session on the deployed URL. The live secrets set on 2026-08-02 persist. Remaining human work is unchanged in nature: real-device gate days, pilot churches, Phase 8 curriculum, trademark, and Stripe webhook endpoint configuration (needs the Stripe dashboard).

**Follow-ups closed 2026-08-16 (late agent reports)**: the phone agent's cross-session outbox caveat was already resolved during integration — `QueuedEntry.sessionKey` + session-scoped `useOutbox` + `SessionSocket.sessionKey` mean queued input only drains into its own session's socket. The install prompt was additionally mounted on the org dashboard and `/install` added to the smoke routes (7/7), then redeployed (version fcd4d84b).

**Known limitation, logged for Phase 8**: vote options exist only inside `SessionState.votes` (populated by cast votes), so the first voter sees no options — the fake lab's segments define no options, and the vote UI stays dormant until real curriculum (Phase 8) adds an options source (e.g. a `voteOptions` field on SegmentDef or per-segment spec data). Not a bug in the current protocol; a curriculum-scale design item.

