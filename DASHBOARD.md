# DASHBOARD — Groundwork
**Last Updated**: 2026-07-31T21:30:00Z
**Updated by**: Claude (session teleported to Jeremy's local machine)

---

## Overall Status: 🟡 DEGRADED

Phases 0, 1, 3, 6 gates passed — Phase 6's fully for real, no proxy needed. **Phase 7's commerce sub-gate now also passes for real** (real Stripe checkout/customer/billing-portal calls from Jeremy's machine, no longer sandbox-blocked) alongside its already-passing PWA sub-gate. Phase 2's gate remains **measured and failed** — precision 0.750 as of the latest real re-measurement, and a temperature-based fix was tried and found impossible on this model (see Pending Decisions). Phase 4 (Whisper) still needs a working Cloudflare account ID before it can be verified for real. Phase 5 built and tested against real Opus; its gate needs a real human's edit-count judgment. No live customer, no revenue, no production infrastructure — nothing to break yet.

---

## Active Metrics

| Metric | Value | Status | Last Checked |
|--------|-------|--------|--------------|
| Gates passed | Phase(s) 0, 1, 3, 6 | 🟢 | 2026-07-27T06:00:00Z |
| Gates measured and FAILED | Phase(s) 2 | 🔴 | 2026-07-31T21:30:00Z |
| Built, awaiting gate | Phase(s) 4, 5 | 🟡 | 2026-07-31T21:30:00Z |
| vocabulary_lint | clean | 🟢 | 2026-07-27T06:00:00Z |
| monthly_spend_usd | 0 | 🟢 | 2026-07-27T06:00:00Z |

Full definitions and thresholds → `docs/metrics.md`.

---

## Pending Decisions (Needs Jeremy)

| Item | Filed | Urgency | Brief |
|------|-------|---------|-------|
| Phase 2 temperature fix tried and reverted — `claude-sonnet-5` rejects the parameter outright. Approve a repeated-run measurement strategy instead (median/worst of N runs), or accept single-run variance as-is? | 2026-07-31 | Low — doesn't block continued build | `docs/decisions.md`, 2026-07-31 |
| Phase 4 (Whisper) blocked on Cloudflare account ID — the one supplied (`caf597c...`) returned HTTP 401 on the Workers AI endpoint | 2026-07-31 | Medium — blocks the one remaining unverified network-dependent gate | `docs/decisions.md`, 2026-07-31 |

**Resolved this session**: auth provider → **Cloudflare Access** (Jeremy's call, 2026-07-31). GitHub Actions repo secrets → **declined** (Jeremy's call, 2026-07-31) — credentials stay local-only in `.dev.vars`.

---

## Active Incidents

✅ Empty = no active incidents.

---

## Last 7 Days

- 2026-07-26: Build plan received. `async-agent-graph-engineering` skill installed (was missing). Subagent build team (15 agents) designed and committed to `docs/agent-team.md` / `.claude/agents/`.
- 2026-07-26: Phase 0 scaffold built and gate-verified (wrangler dev, D1 migration, vocabulary lint self-test).
- 2026-07-27: Phase 1 (session spine) built and gate-verified via automated 3-client proxy test. Real `SessionDO` with WebSocket hibernation, dedup, D1 checkpointing.
- 2026-07-27: Phase 2 (Guide Engine) built — PACER, EVALUATOR, PROBER, segment spec compiler.
- 2026-07-27: Phase 3 (resilience) built and gate-verified via a real Playwright/Chromium test — IndexedDB queue, offline replay, per-field logical-clock vote reconciliation.
- 2026-07-27: Jeremy supplied Anthropic, Cloudflare, and Stripe credentials. Cloudflare/Stripe found to be network-blocked from this sandbox regardless (policy, not credentials). Anthropic worked once credits were added.
- 2026-07-27: **Real Phase 2 gate measurement**: EVALUATOR precision 0.667 against real `claude-sonnet-5` — genuinely below the 0.8 threshold. Two real bugs fixed along the way (invalid `weakest_criterion`, JSON truncation); one prompt-clarity tuning attempt made no measurable difference. Flagged as a Tier 2 decision for Jeremy rather than kept under autonomous tuning.
- 2026-07-27: Phase 4 (audio pipeline) built and its non-AI mechanics gate-verified for real: consent gating, kill switch, R2/D1/Queue dispatch, and confirmed graceful degradation when Whisper is unreachable.
- 2026-07-27: Phase 5 (synthesis) built and tested against real `claude-opus-5`. Found and fixed a real data-model bug live (two distinct risks in one synthesis pass would have wrongly overwritten each other) by splitting artifact kinds into singular/versioned vs. plural/additive. Provenance verification (rejecting fabricated quotes) proven with a deterministic test.
- 2026-07-27: Phase 6 (program layer) built and its gate **passed for real, no proxy needed** — first phase since 0/1/3. Real org/program/lab_session/initiative/review_cycle CRUD, phase-gated lab sequencing, and COACH (real personalized nudges with a template fallback for Tier 1 autonomy).
- 2026-07-27: Phase 7 (commerce and PWA) built. PWA sub-gate **passed for real** — Chrome DevTools Protocol's own `Page.getInstallabilityErrors` check came back with zero real errors (manifest, service worker, and generated icons all satisfy Chrome/Android's actual install criteria). Stripe pricing (§9's exact bands) and webhook signature verification (4/4 deterministic tests) built and tested; live checkout/billing-portal calls need `api.stripe.com`, which is network-blocked from this sandbox regardless of the valid key on hand. Literal iOS/Android device install logged as a capability gap, same category as Phase 1's physical-device gap. This closes out all 8 build-plan phases this sandbox can reach — Phase 8 needs Jeremy's curriculum content and a real pilot church.
- 2026-07-28: Re-ran the Phase 2 eval harness while preparing a consolidated decision-request report and found the precision measurement isn't reproducible (0.667/0.750/0.500 across three identical runs) — root cause is EVALUATOR's Anthropic calls never setting `temperature`, so every call samples at the API default. Filed as a new Tier 2 decision rather than fixed autonomously. Compiled `OUTPUTS/jeremy-review-items-2026-07-28.md` — every open decision and every input only Jeremy can provide, in one report.
- 2026-07-31: Session teleported to Jeremy's local machine (normal network access, unlike the cloud sandbox). Jeremy resolved 3 pending decisions: EVALUATOR temperature fix approved (tried, found `claude-sonnet-5` rejects the parameter outright, reverted same session — real baseline re-measurement: precision 0.750), auth provider set to Cloudflare Access, GitHub Actions secrets declined. **Phase 7's commerce sub-gate now passes for real** — real Stripe checkout session, customer, and billing portal all verified against the live test-mode API from Jeremy's machine. Phase 4 (Whisper) attempted via direct Workers AI REST call with real synthesized audio; blocked on a Cloudflare account ID that returned HTTP 401 — asked Jeremy to double-check it.
- 2026-07-31: Ran a 105-agent deep-research workflow on the "Groundwork" name/brand per Jeremy's request. **Real collision risk found**: a firm already explicitly serves faith-based organizations under this exact name, a near-identical church small-group app exists, and five+ nonprofit-consulting/AI-SaaS companies use the name. Full cited report: `OUTPUTS/groundwork-brand-name-research-2026-07-31.md`. Recommendation given, not acted on — renaming is Jeremy's call.

---

## Next 7 Days (Planned)

- Before the first real pilot: run the literal Phase 1 (physical multi-device), Phase 3 (6 clients / 10 minutes), Phase 5 (real leader edit count), and Phase 7 (real iOS/Android install) gates for real.
- Get a working Cloudflare account ID from Jeremy to finish Phase 4's real Whisper verification — now feasible from his machine, just blocked on the ID itself.
- Awaiting Jeremy's call on the Phase 2 repeated-run measurement proposal above.
- Awaiting Jeremy's call on the "Groundwork" name — attorney clearance search and/or considering alternatives, per `OUTPUTS/groundwork-brand-name-research-2026-07-31.md`.
- Phase 8 (church-pack curriculum + real pilot) is next, and is explicitly gated on Jeremy populating `docs/source-principles.md` — no autonomous action there per the IP firewall protocol. Jeremy is still waiting on the original source-methodology documents (see `docs/vocabulary.md`) before he can write it.

---

## System Vitals

| Item | Value |
|------|-------|
| Last health check | 2026-07-26 (manual) |
| Last deployment | None — no live deploy yet |
| Last weekly report | N/A — reporting is event-driven, not weekly |
| Errors (7-day count) | 0 |
| Monthly spend (MTD / budget) | $0 / $200 |
| `docs/capability-gaps.md` open items | 7 (live Cloudflare provisioning, auth provider choice, physical device test, Phase 3 literal-scale drill, Cloudflare/Stripe network-blocked in this sandbox, Phase 5 needs a real leader's edit count, Phase 7 needs real iOS/Android device installs) — 3 resolved, 2 superseded this session |

---

## Quick Links

| | |
|--|--|
| Decision history | `docs/decisions.md` |
| Cost model | `docs/economics.md` |
| KPI definitions | `docs/metrics.md` |
| Operating schedule | `ops/schedules.md` |
| Incident runbooks | `ops/runbooks/` |
| Capability gaps | `docs/capability-gaps.md` |
| Start a manual session | `HANDOFF.md` |
| Integration map | `docs/integrations.md` |
| Build team graph | `docs/agent-team.md` |
