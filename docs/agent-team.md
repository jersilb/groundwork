# Groundwork Build Team — Agent Graph

This document defines the team of subagents that builds Groundwork, and the
graph they run as. It is the output of applying the `async-agent-graph-engineering`
skill to the Groundwork build plan.

Read this before dispatching any agent. The agent definitions live in
`.claude/agents/`. This file is the map; those files are the contracts.

---

## 1. Why a graph, not a single builder

The build plan is nine phases and roughly a dozen distinct engineering domains.
A single agent grinding phase-by-phase would lose the clock, forget the rubric,
and grade its own work. That is exactly the failure the skill exists to prevent.

But a graph is not automatically right either. The skill's first rule is the
**fake-edge test**: keep an edge only if the downstream node actually consumes
the upstream node's concrete output. Applied to the plan, most *phase* edges are
real (you cannot run the Guide Engine against a session spine that does not
exist), but a surprising amount of *cross-cutting* work is falsely serialized.
Cutting those fake edges is where the parallelism — and the team — comes from.

---

## 2. Fake-edge analysis of the build plan

### Real edges (keep — genuine data dependencies)

| Edge | Why it is real |
|---|---|
| Phase 0 → Phase 1 | The Durable Object and WebSocket spine need the Workers/Wrangler scaffold and the D1 schema to exist. |
| Phase 1 → Phase 2 | The Guide Engine evaluates submissions and segment state that only the session spine produces. |
| Phase 1 → Phase 3 | Offline mirror / reconnect reconciliation wrap the DO's live state; there is nothing to mirror without it. |
| Phase 1 → Phase 4 | Audio capture attaches to the shared-screen client and tags chunks to the active `segment_run`. |
| eval-suite → EVALUATOR | Tuning EVALUATOR to precision > 0.8 requires the labeled fixture set first. This is an anchor, not a preference. |
| EVALUATOR → PROBER | PROBER consumes `weakest_criterion` + `evidence`. A probe with no evaluator output is the generic "can you be more specific?" failure. |
| Phase 2 → Phase 5 (partial) | SYNTHESIZER consumes segment specs and structured submissions. Artifact versioning, provenance schema, and PDF export do **not** wait on it. |
| Phase 6 → Phase 8 | A real pilot needs the program layer (org setup, sequencing, dashboard) running. |

### Fake edges (cut — parallelizable)

| Serialized in the plan | Actually independent because | Runs in parallel with |
|---|---|---|
| Curriculum authoring after the engine | Segments are **data written from ministry reasoning**, per §2.3/§5.2. The engine consumes a spec shape, not finished content. | All engine phases (human-gated) |
| UI after each feature | The design system + component library + phone/screen shells depend on the data model, not on finished features. Only final screen-wiring has real edges. | Phases 1–7 |
| IP firewall / vocabulary lint after content | It is a **continuously-running invariant and verifier**, not a predecessor step. | Everything, always |
| COACH after the in-session engine | Different runtime (out-of-session, scheduled). Depends on the data model, not on PACER/EVALUATOR. | Phases 2–6 |
| Cost instrumentation after Phase 2 | The logging harness and cost dashboard can be built ahead and switched on at first LLM call. | Phases 1–2 |
| PACER vs EVALUATOR/PROBER | PACER is deterministic in the common case; it escalates to an LLM only to decide *what to cut*. Independent of the evaluator path. | EVALUATOR/PROBER build |
| Stripe / commerce vs session engine | Independent domain gated only by the org/user tables. | Phases 1–6 |

---

## 3. The topology — a diamond per phase

Each phase runs the skill's default **diamond**, driven by the orchestrator
(the "brain"). Builders are the "hands" — interchangeable, isolated, replaceable.

```
                    ┌────────────────────────┐
                    │  groundwork-orchestrator│  brain: fake-edge test,
                    │        (planner)        │  dispatch, model routing,
                    └────────────┬───────────┘  cost caps, durable log
                                 │  fan-out (only across CUT edges; cap 3–4 concurrent)
        ┌───────────┬───────────┼───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ builder │ │ builder │ │ builder │ │ frontend│ │curriculum│   isolated
   │  (hand) │ │  (hand) │ │  (hand) │ │   -ux   │ │ -author │   workspaces
   └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
        └───────────┴───────────┼───────────┴───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │   integration-reducer   │  cheap fan-in: collect diffs,
                    │        (Haiku)          │  COUNT expected vs actual,
                    └────────────┬───────────┘  surface missing branches
                                 ▼
              ┌──────────────────┴──────────────────┐
              ▼                                      ▼
   ┌────────────────────┐              ┌────────────────────────┐
   │ clean-context-     │              │  ip-firewall-guardian   │  parallel
   │ verifier (Opus)    │              │       (Sonnet)          │  verify lenses
   │ 5-lens + anchors   │              │  frozen invariant       │  (clean context)
   └─────────┬──────────┘              └────────────┬───────────┘
             └──────────────────┬──────────────────┘
                                ▼
                    ┌────────────────────────┐
                    │  groundwork-orchestrator│  synthesize: phase-gate
                    │      (synthesize)       │  sign-off → open next real edge
                    └────────────────────────┘
```

The verifier and the IP guardian run in **clean context** — they never receive a
builder's internal reasoning, only the task/rubric, the final artifact, and
external evidence. That is the non-negotiable rule that stops self-grading.

---

## 4. The roster

| # | Agent | Model | Node type | Owns (build-plan tasks) |
|---|---|---|---|---|
| 1 | `groundwork-orchestrator` | Opus | Brain / planner+synth | Phase sequencing, fake-edge test, dispatch, gates, cost, durable log, dreaming |
| 2 | `platform-infra-engineer` | Sonnet | Hand | Phase 0: Workers, Wrangler, D1 migrations, R2/KV, CI + vocabulary lint |
| 3 | `session-spine-engineer` | Sonnet | Hand | Phase 1: Durable Object, WebSocket fanout, join-by-code, segment advance, `stateVersion` |
| 4 | `guide-engine-architect` | Opus | Hand (design) | §5: segment graph, five runtime-agent contracts, spec-as-data loader |
| 5 | `evaluator-engineer` | Sonnet | Hand | Phase 2: PACER, EVALUATOR, PROBER, eval suite, LLM instrumentation |
| 6 | `resilience-engineer` | Sonnet | Hand | Phase 3: offline mirror, queue/replay, reconnect reconciliation, degraded mode, pre-cache |
| 7 | `audio-pipeline-engineer` | Sonnet | Hand | Phase 4: capture, R2 upload, Whisper queue, transcript window, consent, retention |
| 8 | `synthesis-engineer` | Opus | Hand | Phase 5: SYNTHESIZER, plan artifacts, versioning, provenance, one-page plan, PDF |
| 9 | `program-coach-engineer` | Sonnet | Hand | Phase 6: org/team/roles, 4-lab sequencing, initiatives, monthly review, COACH, dashboard |
| 10 | `commerce-pwa-engineer` | Sonnet | Hand | Phase 7: Stripe tiers/trial/portal, PWA manifest, service worker, install |
| 11 | `frontend-ux-engineer` | Sonnet | Hand (cross-cutting) | UI for every screen; shared-screen + phone clients; `ultimate-web-designer` |
| 12 | `curriculum-author` | Opus | Hand (human-gated) | Phase 8: church-pack Lab 1 from ministry reasoning; segment specs as data |
| 13 | `integration-reducer` | Haiku | Reduce | Fan-in compression; expected-vs-actual counting; gap surfacing |
| 14 | `clean-context-verifier` | Opus | Verify | Five-lens verification + fake-edge/contract/anchor audit; phase-gate sign-off |
| 15 | `ip-firewall-guardian` | Sonnet | Verify (invariant) | §2 enforcement: trademarks, close-paraphrase, vocabulary map, manual-content block |

---

## 5. Anchors — the external ground truth the graph may not argue with

Topology and verifiers still live inside the model ecosystem. These anchors are
things outside it that refuse to move. Every phase gate is one.

| Anchor | Source | Owner |
|---|---|---|
| `wrangler dev` runs; migrations apply; **vocabulary lint fails on a planted banned term** | Real command output | platform-infra-engineer → verifier |
| Three real devices advance segments with no state divergence | Real multi-client run | session-spine-engineer → verifier |
| **EVALUATOR `thin`-verdict precision > 0.8** on the labeled fixture set — do not proceed below this | Measured metric | evaluator-engineer → verifier |
| Network killed 10 min, 6 clients: all submissions survive, state reconciles | Real fault-injection drill | resilience-engineer → verifier |
| 4 hrs recording, zero lost chunks, transcript lag < 90 s | Real recording run | audio-pipeline-engineer → verifier |
| One-page plan needs < 5 leader edits | Simulated lab | synthesis-engineer → verifier |
| Simulated org completes Lab 1, gets nudges, runs a review | Simulated run | program-coach-engineer → verifier |
| Test org signs up, trials, converts, installs on iOS + Android | Real device test | commerce-pwa-engineer → verifier |
| **A real church completes a real Lab 1** — the true gate on the whole project | Pilot | orchestrator + Jeremy |
| **No trademarked term anywhere in the repo** (StratOp, LifePlan, Paterson Process, W.I.N. Wheel, Plan-On-A-Page, …) | CI lint | ip-firewall-guardian |
| Decision-authority tiers (§10) never self-escalated | Frozen rule | every agent |

Bad anchors we explicitly reject: "the agent said it was done," one model's
opinion of another model's text, internal consistency with no external signal.

---

## 6. Model routing and cost discipline

The skill says cheap models on fan-out, strong models on judgment, verification,
and synthesis. The plan says Sonnet in-session, Opus at synthesis. Same rule.

- **Haiku** — `integration-reducer` only (mechanical compression + counting).
- **Sonnet** — every builder hand, and the IP guardian (pattern-matching lint).
- **Opus** — orchestrator (planning/synthesis), guide-engine-architect,
  synthesis-engineer, curriculum-author (board-facing / IP-sensitive prose),
  clean-context-verifier (must be hard to fool).

Caps, set and enforced by the orchestrator:

- No more than **3–4 builder hands running concurrently** on the first passes.
- Token spend logged **per phase**; surfaced in the phase digest.
- Any graph run that would exceed the phase budget is **opt-in with explicit
  supervision**, never silent.
- The runtime cost model (§9) — Whisper hours, EVALUATOR/PROBER Sonnet calls,
  SYNTHESIZER Opus calls — is instrumented from Phase 2 in `docs/economics.md`.

---

## 7. Reliability — brain/hands, durable log, dreaming

- **Brain vs hands.** The orchestrator holds no irreplaceable state. Builder
  hands are cattle: a crashed hand is a tool error, re-provisioned and retried.
  Credentials (Anthropic API, Stripe, Cloudflare) stay outside the hands.
- **Durable session log.** Progress lives in an append-only log
  (`.context/progress.md` + the git history), not only in a model context
  window. Recovery = wake a fresh orchestrator from the log + `.context/`.
- **Isolated workspaces.** Parallel hands never share a working tree. Cross-phase
  builders that touch the same files (schema, shared types) are serialized behind
  a real edge, not run as false-independent siblings.
- **Offline dreaming.** After each phase, a consolidation pass reviews the trace,
  reconciles decisions into `.context/decisions.md`, and corrects any memory that
  would send the next phase through the same trapdoor. This ties into
  `context-architect`.

---

## 8. The six failure modes and how this team blocks each

| Failure | Guard in this team |
|---|---|
| Context collapse | `integration-reducer` compresses each batch; the orchestrator never stuffs raw fan-out into synthesis. |
| False independence | Isolated workspaces; shared-file work sits behind real edges; the reducer audits for shared resources. |
| Silent node failure | Every merge counts **expected vs actual** inputs and surfaces missing/empty branches before sign-off. |
| Self-grading | `clean-context-verifier` and `ip-firewall-guardian` run in fresh context on artifact + rubric + evidence only. |
| Memory drift | Offline dreaming after every phase; `.context/` is reviewed and rewritten, not just appended. |
| Cost explosion | Concurrency caps, Haiku on reduce, per-phase token logging, opt-in for expensive runs. |

---

## 9. Decision authority (from §10 — a frozen invariant)

No agent self-escalates. When uncertain, treat as Tier 2 and stop for Jeremy.

- **Tier 1 (autonomous):** health checks, COACH nudges within approved
  templates, dashboard updates, runbooks, weekly reports, routine dep updates.
- **Tier 2 (propose → Jeremy approves):** curriculum content, guide prompt/rubric
  changes, pricing, new integrations, changes to a live customer's artifacts,
  public copy.
- **Tier 3 (Jeremy initiates only):** theological/doctrinal content, IP/legal
  exposure, refunds/disputes, the product name, strategy pivots.

`curriculum-author` and `guide-engine-architect` operate under Tier 2 by default.
Anything the `ip-firewall-guardian` flags as IP-adjacent is Tier 3.

---

## 10. How to run a phase

1. Orchestrator reads the phase's real inputs from `.context/` + the durable log.
2. Orchestrator applies the fake-edge test to the phase's tasks and fans out only
   across cut edges, capped at 3–4 concurrent hands in isolated workspaces.
3. Hands emit **structured** outputs against their contracts (not prose walls).
4. `integration-reducer` collects, counts expected vs actual, compresses to a digest.
5. `clean-context-verifier` + `ip-firewall-guardian` audit in clean context
   against the phase's anchor(s).
6. Orchestrator synthesizes: if the anchor passes and no gap is open, sign off the
   gate, run the dreaming pass, open the next real edge. Otherwise, re-dispatch.

The pilot (Phase 8) is the only gate that a model cannot sign off. Line up two or
three willing churches before Phase 0, per the plan.
