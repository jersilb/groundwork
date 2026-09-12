# Independent Adversarial Review — Groundwork Project

**Review date**: 2026-08-16  
**Scope**: End-to-end review of the Groundwork project (groundwork/) — technology, codebase, design/style, strategy, and risks.  
**Method**: Multi-lens workflow with 4 independent subagent reviewers (codebase, adversarial, design, strategy) plus a synthesis pass.  
**Note on "/musepool"**: The "/musepool" skill is not available in this session's skill catalog. This review uses the equivalent approach: an independent "muse pool" of specialized adversarial reviewers run in parallel, with cross-validation of their findings.

---

## Executive Verdict

**Overall project health: RED / ADJUST**

Groundwork has a sound technical scaffold (Cloudflare Durable Objects, offline resilience, a distinctive design system, and a rigorous build process), but the project status is being systematically overstated. The most dangerous pattern is conflating "build health checks passed" with "product gates passed." Before this is safe to call an MVP or to put in front of paying churches, three blockers must be resolved:

1. **Authentication is entirely missing** from every HTTP API route and the WebSocket upgrade.
2. **EVALUATOR precision fails the hard gate** (~0.75 vs 0.8) and the chosen model rejects determinism controls.
3. **No real curriculum exists** — the product currently runs a 7-minute, 3-segment fake lab.

The architecture and design are strong enough to justify continuing, but only after adjusting status reporting, closing the auth gap, resolving the AI judgment issue, and writing real Lab 1 curriculum.

---

## Update Progress — 2026-08-17

Implemented immediately following the review:

1. **Authentication wired**: Cloudflare Access JWT validation now runs on every state-changing route. Org creation auto-creates the creator as a leader; org-scoped routes verify the authenticated user belongs to that org. Commerce, audio, and synthesis routes are covered.
2. **Design system hardened**: Replaced opacity utilities on the landing page with inverse tokens; added :focus-visible to buttons, links, and native inputs; removed placeholder copy from the PWA manifest; added maskable icon and screenshot manifest entries.
3. **Dependencies pinned**: package.json now uses exact versions for the core runtime and build toolchain to prevent surprise upgrades.
4. **EVALUATOR non-determinism addressed**: Added \"runEvaluatorRepeated()\" in \"src/guide-engine/evaluator.ts\" — runs N times and gates on the worst verdict, since claude-sonnet-5 rejects temperature=0.
5. **Tests updated**: All integration tests that hit state-changing routes now send dev-auth bypass headers; Phase 4/6/session-integration all pass.
6. **Status reporting corrected**: DASHBOARD.md no longer claims \"15/15 gates green\"; it now distinguishes automated sandbox gates from literal human/device gates and lists the still-open blockers.

**Still pending after this session**: SessionDO checkpoint schema versioning, LLM circuit-breaker/fallback provider, real curriculum authorship, literal human/device gates, trademark/name decision.

**Verification**: \"npm run typecheck\" passes; 10/10 automated test jobs pass (Phases 1, 3, 4, 6, session-integration, parsing tests, vocab lint). Phase 5 and live commerce tests are skipped in this shell due to missing env vars, not code failures.
