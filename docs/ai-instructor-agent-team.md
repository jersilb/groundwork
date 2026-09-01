# AI Instructor Build Team — Campaign Roster & Dispatch Plan

Read with `docs/agent-team.md` (the parent graph) and `docs/ai-instructor-tech-scope-build-plan.md`
(the campaign plan). This file is the map; `.claude/agents/*.md` are the contracts.

---

## 1. Relationship to the existing build team

The AI Instructor program is a **campaign over the existing diamond**, not a competing graph.
`groundwork-orchestrator` remains the brain; `integration-reducer` remains the fan-in;
`clean-context-verifier` and `ip-firewall-guardian` remain the clean-context verify nodes.
This campaign adds four specialist hands and re-casts existing ones onto new workstreams.

## 2. Risk-ranked workstreams (fable move 3: likelihood × cost)

| # | Workstream | Owner | Risk | Why it ranks here |
|---|---|---|---|---|
| W1 | Session runtime: itinerary, state machine, clock, checkpoint, audit | `session-orchestrator-engineer` | **Highest** | A clock/state bug destroys a six-hour room day and is unrecoverable in front of a live church |
| W2 | Guide identity + typed actions + welcome/memory | `instructor-runtime-engineer` | High | This is the product's defining surface; wrong voice or false consensus kills trust |
| W3 | Instructor console + participant surfaces | `instructor-ux-designer` | High | A sponsor who can't steer the AI won't run it; design-system drift fragments the product |
| W4 | Simulation + 14-scenario rehearsal harness | `reliability-rehearsal-engineer` | Medium | Proves W1–W3; wrong here means false confidence, not live failure |
| — | Curriculum pack (human-gated) | `curriculum-author` (existing) | High but human-gated | Tier 2/3; engine consumes schema shape, not content |

Dispatch order follows risk: **W1 starts first with Expert tier and the strictest review**;
W2/W3/W4 fan out in parallel once W1's Release-0 contracts land (they are the real edge).

## 3. Roster (new + re-cast)

| Agent | Node type | Default tier | Owns (campaign releases) |
|---|---|---|---|
| `session-orchestrator-engineer` **(new)** | Hand | Expert | R0 contracts, R2 orchestrator, checkpoint/restore, completion audit |
| `instructor-runtime-engineer` **(new)** | Hand | Balanced (Expert for identity/consent copy) | R1 identity/welcome, R2 typed actions, R7 memory |
| `instructor-ux-designer` **(new)** | Hand | Balanced (Expert for console visual system) | R1 participant surfaces, R3 console, R4 breakout UI |
| `reliability-rehearsal-engineer` **(new)** | Hand | Balanced | R2 simulation gate, R5 rehearsal gate, pilot scorecard |
| `session-spine-engineer` (existing) | Hand | — | Reviewer-of-record on DO integration PRs |
| `frontend-ux-engineer` (existing) | Hand | — | Implements R4 participant UI under instructor-ux-designer's direction |
| `curriculum-author` (existing) | Hand (human-gated) | — | R0 reference pack fixtures (synthetic, IP-safe), real packs later |
| `ip-firewall-guardian` (existing) | Verify | — | Every new user-visible string |
| `clean-context-verifier` (existing) | Verify | Expert | W1/W2 gates |
| `groundwork-orchestrator` (existing) | Brain | — | Phase gates, dispatch, model routing, cost caps |

## 4. Topology (Waves)

```text
                    groundwork-orchestrator (brain)
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  [Wave 0 — R0 contracts]  [Wave 0 — fixtures]     [Wave 0 — design brief]
  session-orchestrator     curriculum-author       instructor-ux-designer
        │   (SessionPlan/runtime/action schemas land)
        ├───────────────┬──────────────────┬──────────────┐
        ▼               ▼                  ▼              ▼
  [Wave 1 — R1/R2]  [Wave 1 — R3]   [Wave 1 — R2 gate]  [Wave 1 — R1 gate]
  session-          instructor-ux-  reliability-        instructor-runtime-
  orchestrator      designer        rehearsal-engineer  engineer
        │               │                  │              │
        └───────────────┴─────────┬────────┴──────────────┘
                                  ▼
                        integration-reducer (count expected vs actual)
                                  ▼
              clean-context-verifier ──── ip-firewall-guardian
                                  ▼
                    groundwork-orchestrator (gate sign-off)
```

Real edges (wait): schemas before UI and harness; DO integration after state-machine tests pass.
Fake edges (parallel): participant surfaces vs console vs harness; prompts vs runtime wiring.

## 5. Anchors (campaign gates — no model signs these off alone)

| Anchor | Source | Owner |
|---|---|---|
| SessionPlan schema compiles a reference 6-hour plan and rejects 8 malformed fixtures | `scripts/test-session-plan.ts` | session-orchestrator → verifier |
| Six-hour simulation: breaks taken-or-overridden, drift 15/30/60 detected, closing buffer protected, restart resumes, silent completion blocked | `scripts/test-six-hour-simulation.mjs` | reliability-rehearsal → verifier |
| Instructor runs a full simulated session via UI only; every recommendation has accept/edit/dismiss + reason | Playwright console gate | instructor-ux-designer → verifier |
| Fresh participant sees identity + contract + correction affordance before any prompt | Playwright R1 gate | instructor-runtime → verifier |
| Breakout: 6–12 phones, packets, report-back, conflicts preserved, canonical-accept | E2E harness | instructor-ux + orchestrator → verifier |
| All 14 degraded scenarios end in documented deterministic recovery | rehearsal harness | reliability-rehearsal → verifier |
| Level 1–2 regression gates stay green on every merge (zero behavior change behind `GUIDE_ORCHESTRATION_V2=false`) | `.context/VERIFY.md` | every hand |
| Vocabulary lint clean; identity copy Jeremy-approved before R1 exit | Tier 2 | ip-firewall-guardian + Jeremy |

## 6. Decision authority (unchanged — §10)

Tier 1 autonomous: harness code, console scaffolding, schema code, docs.
Tier 2 propose-and-wait: identity/contract copy, prompt changes, output-gate thresholds.
Tier 3 Jeremy-only: doctrinal content, IP, product naming, pilot go/no-go.
Any task touching consent, screen-token auth, or checkpoint recovery routes Expert regardless of score (D3).

## 7. Wave-1 task briefs (director-issued)

Each brief cites `.context/` files and lessons by ID. Checks are executable; an agent that
reports without running its check is returned unread.

### Brief W1-a — SessionPlan contracts (R0)
**To:** session-orchestrator-engineer · **Tier:** Expert (new interface, long-lived)
**Objective:** Land `SessionPlan`/`SegmentPlan`/`BreakSpec`/`BreakoutSpec`/`OutputRequirement` schemas, runtime-state shape, and the typed `GuideAction`/`InstructorAction` unions as compilable TS with migration helpers — behavior-neutral.
**Inputs:** tech-scope §5.1–5.4; `src/session-protocol.ts`; `.context/VERIFY.md` (plan-schema gate).
**DoD:** `scripts/test-session-plan.ts` compiles a reference six-hour plan and rejects 8 malformed fixtures; typecheck green; `GUIDE_ORCHESTRATION_V2` flag exists; Level 1–2 suites green.
**Out of scope:** state-machine wiring (W1-b), UI, prompts.
**Report:** verdict → file list → check output verbatim → labeled risks.

### Brief W2-a — Console visual system + overview screen (R3 start)
**To:** instructor-ux-designer · **Tier:** Expert for the visual system, then Balanced
**Objective:** Extend the planning-room tokens into an instructor console design language (clock ribbon, recommendation queue, override history) and implement the session-overview screen against the W1-a types.
**Inputs:** theme.css; `web/src/features/room/`; frontend-design skill; tech-scope §6 R3 views.
**DoD:** Console overview renders live session state from the existing fake-lab DO in a real browser; `npm run typecheck` + `build:web` green; smoke-web passes; accessibility notes included.
**Out of scope:** protocol changes; participant phones (separate brief); recommendation actions until W1-a unions land.
**Report:** verdict → component inventory → check results → token deltas → labeled risks.

### Brief W3-a — Six-hour simulation harness (R2 gate)
**To:** reliability-rehearsal-engineer · **Tier:** Balanced (fixtures Fast)
**Objective:** Build the deterministic simulation driver (injected clock, scripted groups) and the assertion set for the R2 gate, wired to fail loudly until W1-b's orchestrator satisfies it.
**Inputs:** tech-scope §7–8; `.context/LESSONS.md` L1/L2; existing integration scripts.
**DoD:** Harness runs to completion today (documents "blocked-by-W1-b" per assertion, no hangs), exits non-zero, ≤120s warm; L1 process-group pattern used.
**Out of scope:** implementing the orchestrator; live-LLM anything.
**Report:** verdict → scenario table → timing → labeled risks.

### Brief W4-a — Guide identity + welcome flow (R1)
**To:** instructor-runtime-engineer · **Tier:** Expert for copy, Balanced for wiring
**Objective:** `GuideIdentity`/`GuideSessionContext`, welcome/introduction/consent-acknowledgement states, and participant correction affordance — speech-only, no state mutation (D2).
**Inputs:** tech-scope §5.3; `session-guide.ts`; `.context/LESSONS.md` L4/L5.
**DoD:** R1 Playwright gate passes against the fake lab; identity copy **proposed to Jeremy** (Tier 2) — may merge behind a flag with placeholder-neutral copy pending approval.
**Out of scope:** prompts inside EVALUATOR/PROBER (separate Tier-2 brief); memory (R7).
**Report:** verdict → action inventory → gate output → labeled risks.

## 8. Pre-drafted briefs — later waves (not dispatched this campaign)

- **W1-b (R2)**: state machine + clock + break lifecycle + completion audit → six-hour gate.
- **W2-b (R3)**: recommendation queue actions, override controls, audit log view.
- **W3-b (R4)**: breakout packets, roster, timers, report-back, conflict preservation.
- **W4-b (R5)**: 14-scenario degraded harness.
- **W5 (R6)**: voice channel — only after R4 exit (D4).
- **W6 (R7)**: confirmed memory review + corrections.
- **W7 (R8)**: participation signals + adaptive prompt selection within curriculum bounds.

## 9. Failure-mode guards (inherited from the parent graph)

Context collapse → reducer fan-in · False independence → schemas are a real edge ·
Silent node failure → expected-vs-actual counting · Self-grading → clean-context verify ·
Memory drift → `.context/` rewrite per phase · Cost explosion → tier scoring per brief,
3–4 concurrent hands max, token spend logged per phase.

## 6. Wave-1 execution status (2026-08-28, fallback director execution)

All four Wave-1 briefs executed in this session under the fallback rule (D5 — no subagent
spawner in-session; the director executed each specialist's brief sequentially):

| Brief | Owner role | Delivered | Gate |
|---|---|---|---|
| W1-a session spine (schemas + reference plan) | session-orchestrator-engineer | `src/session-plan.ts` + `SPINE_REFERENCE_PLAN` | `test:session-plan` 12/12 |
| W1-b runtime (state machine, clock, break lifecycle, audit, events) | session-orchestrator-engineer | `src/session-runtime.ts` (pure) | `test:session-runtime` 19/19 |
| W1-c DO wiring behind `SESSION_SPINE` + vote quorum + PACER overrun fix | session-orchestrator-engineer | `src/session-do.ts`, protocol extension | `test:spine-integration` 22/22 live |
| W2 six-hour simulation harness | reliability-rehearsal-engineer | `scripts/test-six-hour-simulation.ts` | 11/11 (drift ladder, buffer, restart, 6 degraded scenarios) |
| W3 instructor console | instructor-ux-designer | `web/src/features/console/InstructorConsole.tsx` at `/console/:key` | typecheck + build; Playwright operability run pending (R3 exit) |
| W4 phone identity + correction | instructor-runtime-engineer | `GuideIntroCard`, `GuideCorrection`, `guide_feedback` protocol | typecheck; Playwright identity run pending (R1 exit) |

Remaining for later waves: group assignment + report-back collection (R4), Playwright
operability/identity runs, the other 8 degraded scenarios (R5), voice (R6), memory (R7),
adaptive facilitation (R8). `SESSION_SPINE` is not yet set in production [vars] — Jeremy's
go/no-go before enabling on real rooms.
