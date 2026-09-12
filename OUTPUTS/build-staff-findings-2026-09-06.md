# Groundwork Build Staff — Consolidated Findings
**Date:** 2026-09-06 · **Repo:** `Documents/Jeremy Apps/Groundwork App/groundwork` · **HEAD:** `974262b`

**Sources:** HOLMES baseline bug hunt (`ee90cf21ddf5`, 08:13) · PROBE test-suite run (`531253ed7baf`, 08:16) · ATLAS architecture dive (`b864b3e989c5`, 08:16). IRIS (design) and VM-setup reports have **not yet been produced** — their cron output dirs do not exist yet.

---

## 1. Bug List

No confirmed code bugs. Typecheck is clean, all fast suites pass, zero TODO/FIXME/HACK/XXX markers. Findings are risks and one housekeeping nit:

| # | Severity | Location | Issue |
|---|---|---|---|
| 1 | HIGH (risk) | `src/session-do.ts` (eval/pacer/synthesis catch paths) | **Silent failure swallowing, zero observability.** `maybeRunEvaluation().catch(() => {})` and `runPacerIfDue` bare-catch: a persistently failing EVALUATOR (bad prompt, model outage, 400s) is invisible in production. No metrics/logs/D1 record of verdicts or parse errors. |
| 2 | HIGH (risk) | `src/session-do.ts` → `runBoundarySynthesis` | **Boundary synthesis can be silently dropped.** Returns immediately when `guideWorkInFlight` is set (single global mutex shared by eval/pacer/synthesis) with no retry — synthesis pass at a segment boundary can vanish permanently. |
| 3 | HIGH (risk) | `src/guide-engine/evaluator.ts`, `prober.ts`, `synthesizer.ts` (prompt builders) | **Unbounded prompt budgets.** `MAX_SUBMISSIONS_PER_SEGMENT = 100` × `MAX_SUBMISSION_CHARS = 2000` = up to 200 KB per prompt, no truncation — context-overflow failures and token-cost blowups one chatty room away. |
| 4 | MED (risk) | `src/session-do.ts` (guide tick scheduling) | **Parse-failure retry = money pump.** Persistent parse failure re-spends every 30 s forever; no backoff or consecutive-failure tracking. PROBER failure discards the whole (already paid-for) evaluator verdict instead of falling back to a canned probe. |
| 5 | MED (risk) | `src/guide-engine/synthesizer.ts` → `verifyProvenance` | **Provenance check brittle.** Raw `String.includes` verbatim-substring match; Whisper punctuation / smart quotes / paraphrase-slip turns legitimate synthesis into a hard failure + lost LLM spend. No normalization or re-prompt retry. |
| 6 | MED (risk) | `src/session-do.ts` → `guideClient()` | **New `AnthropicLlmClient` per guide action**, no caching, no timeout around `llm.complete` — a hung SDK call holds `guideWorkInFlight` indefinitely. |
| 7 | MED (risk) | `web/src/lib/types.ts` | **Hand-mirrored copy** of server protocol/runtime types ("Keep these in sync with the server types") — no generation or drift test. |
| 8 | MED (risk) | `web/src/features/org/program-store.ts` | **Client-side org data of record** (sessions/initiatives/cycles in localStorage) because Worker has no list endpoints — multi-device divergence and loss risk. |
| 9 | MED (risk) | `src/program/coach.ts` + `program/routes.ts` | **COACH nudges client-triggered per Dashboard load** — no server-side throttle, cache, or already-nudged dedupe; refresh-spam burns API budget. |
| 10 | LOW (risk) | `src/synthesis/routes.ts` → `handleSynthesize` | **Two synthesis entry paths, different trust models.** DO synthesis uses stored server-side submissions; manual `POST /session/:id/synthesize` trusts request-body `submissions` (org-authorized, acceptable — but asymmetry undocumented). |
| 11 | LOW (nit) | `package.json` | **`test:eval-harness` npm entry** listed between phase1 and pacer but no command string / script file found — possibly removed/incomplete entry. |
| 12 | LOW (info) | `src/guide-engine/models.ts` (7 lines) | Anomalously small for a domain-models module; likely intentional barrel (types live in `segment-schema.ts`/`session-plan.ts`) — confirm intentionality. |

**HOLMES "throw new Error" hits — all legitimate guards, not stubs:** `src/auth/cloudflare-access.ts:72` (certs fetch failed), `web/src/main.tsx:15` (missing #root), `web/src/features/room/phone/useOutbox.ts:55` (socket not open).

---

## 2. Test Results

**ALL GREEN — 12/12 suites passed (exit 0), typecheck clean, vocab lint clean. Zero failures.**

| Suite | Result |
|---|---|
| `test:pacer` | 6/6 ✓ |
| `test:guide-runtime` | 9/9 ✓ |
| `test:evaluator-prober-parsing` | 7/7 ✓ |
| `test:session-plan` | 12/12 schema checks ✓ |
| `test:session-runtime` | 20/20 ✓ |
| `test:session-integration` | ✓ incl. **real wrangler D1 checkpoint verification** (403 auth-first, screen-token reject, 409 phase gate, `segment_key=welcome` row recorded) |
| `test:spine-integration` | ✓ smoke (human-led floor recovery, phone role gating §5.5, closing protection, **DO-eviction survival with runtime intact**) |
| `test:synthesizer-provenance` | 4/4 ✓ (fabricated provenance quote rejected) |
| `test:demo-pack` | 28/28 ✓ |
| `test:stripe-webhook` | 4/4 ✓ (valid sig accepted; tampered/wrong-secret/malformed rejected) |
| `lint:vocab` (+selftest) | clean / planted term flagged, clean text left alone ✓ |
| `typecheck` | `tsc --noEmit` root + web, exit 0 ✓ |

**Skipped by design (env/network/long-running, NOT code bugs):** `test:six-hour-simulation` (6h), `test:phase1/3/4/5/6/7*` (need live `wrangler dev` + Playwright + real network; phase3 uses `context.setOffline`, phase4 real audio consent, phase7-commerce-live is live commerce), `test:eval-harness` (no script surfaced).

---

## 3. Architecture Notes

**Architecture is sound and unusually disciplined** — pure runtime, leader-absolute guide (§5.5), curriculum-as-data, provenance-as-hard-failure, cost gating. **But it is *silent by design*:** every failure path swallows errors, synthesis can be lost at boundaries, prompt budgets are uncapped.

- **Single Cloudflare Worker + one Durable Object.** `src/index.ts` route fan-out; `session-do.ts` (892 ln) is the WS hub + state machine + guide orchestration + D1 checkpointing (every 30s + boundaries).
- **Two decoupled loops, one `LlmClient` contract** (`complete({system, messages, maxTokens, model}) → {text}`), model routing centralized in `models.ts` (`IN_SESSION: claude-sonnet-5`, `SYNTHESIS: claude-opus-5`).
- **In-session loop:** phone submit → validation/dedupe (clientUuid) → `maybeRunEvaluation` (gated: key present, `GUIDE_ENABLED`, !inFlight, ≥2 submissions, 30s min interval; runs via `ctx.waitUntil` off the message path) → **EVALUATOR** (rubric passed as data, zod-validated verdict `on_track|thin|off_track|conflict|stuck`, `weakest_criterion` must be real rubric id) → branch: `on_track`=silence · `conflict`=leader de-escalation · `stuck`=canned `spec.fallback_if_stuck` · `thin|off_track`→**PROBER** (must reference specifics the room said) → **PACER** (30s alarm, deterministic `decidePacerAction`; only LLM call is `escalateCompressDecision` on compress; no-nag same-action silence) → **SYNTHESIZER** (boundary, Opus, `DraftArtifact[]` with provenance verified as verbatim substring; fabrication = hard failure published honestly in-room).
- **Output channel:** all agents emit `GuideMessage` → `guideLog` (cap 25, rides state broadcast) → spine mode bridges onto console queue (`probe→ask_question`, `evaluator→request_human_intervention`, `pacer→time_check`, `synthesis→summarize`). Guide NEVER mutates state / advances segments — all transitions through pure `applyAction` with screen-role gating.
- **COACH** (between-session, outside live engine): dashboard → `getOverdueSteps` (pure SQL, no LLM) → per-step nudge with strict "use ONLY the facts given" template.
- **Persistence triangle:** DO memory → DO durable storage (authoritative) → D1 `session_checkpoint` (DR, restore re-schedules alarm). Transcription: R2 chunk → Queue → Whisper → D1.
- **IP firewall is physical:** `generated/segment-specs.ts` exports `SEGMENT_SPECS: SegmentSpec[] = []` — nothing to leak.
- **God-object risk:** `session-do.ts` (892) + `session-runtime.ts` (877) = 56% of session layer; `session-guide.ts` (310) largest agent file. Pure-runtime extraction mitigates, but guide-integration block (~120 ln) belongs in its own coordinator class.

---

## 4. Design Proposal

**Not yet available.** IRIS (design) cron output dir (`75d6a371e940`) does not exist — report pending. No design issues identified by HOLMES/PROBE/ATLAS.

---

## 5. VM Status

**Not yet available.** VM-setup cron output dir (`548de2efaaae`) does not exist — report pending.

---

## 6. Recommended Fix Order

Priority from ATLAS attack plan (1–4 = highest leverage, all small surgical edits):

1. **Prompt budget caps** — truncate submissions (~12) + char ceiling (~24 KB) + transcript cap in `buildEvaluatorUserContent` (`evaluator.ts`), `buildProberUserContent` (`prober.ts`), `buildUserContent` (`synthesizer.ts`). → kills Bug #3.
2. **Boundary synthesis retry** — stash `pendingSynthesisKey` when `guideWorkInFlight` blocks; run on next alarm or in-flight `.finally()`. → kills Bug #2.
3. **Guide telemetry** — structured D1 row (session_id, agent, kind, error, ts) in catch paths of `maybeRunEvaluation`/`runPacerIfDue`/`runBoundarySynthesis` + parse-error paths. → kills Bug #1.
4. **Per-agent backoff** — consecutive-failure tracking with exponential skip (2×, 4× … up to 5 min) in `session-do.ts`. → kills Bug #4.
5. **PROBER fallback** — on parse/network error, emit canned probe from `weakest_criterion` + `fail_example_shape` instead of discarding verdict (`session-guide.ts` → `evaluateAndMaybeProbe`).
6. **Provenance normalization + one re-prompt** — normalize both sides (whitespace, curly→straight quotes) before substring match; optional single retry (`synthesizer.ts` → `verifyProvenance`). → fixes Bug #5.
7. **LLM client lifecycle** — cache `AnthropicLlmClient` on DO instance; wrap `llm.complete` in ~20s timeout so hung call can't wedge `guideWorkInFlight`. → fixes Bug #6.
8. **Unify synthesis trust boundary** — `handleSynthesize` reads submissions from D1 by sessionId (or validate body matches stored). → fixes Bug #10.
9. **Shared-types drift test** — diff `web/src/lib/types.ts` vs `src/session-protocol.ts`/`session-runtime.ts` in CI. → fixes Bug #7.
10. **COACH throttle + dedupe** — cache nudges per program with TTL or `nudged_at` column, skip within 24h. → fixes Bug #9.
11. **Server-side list endpoints** — GET lists for lab sessions/initiatives/review cycles so localStorage stops being source of truth. → fixes Bug #8.
12. **Extract `GuideCoordinator`** — move guide-loop bookkeeping out of `session-do.ts` into `guide-engine/coordinator.ts` (largest task; last).
13. (Housekeeping) Remove or restore `test:eval-harness` npm entry; confirm `models.ts` intentionality.

**Bottom line:** No bugs block shipping. The codebase is in post-MVP hardening with a clean bill of static + test health. Residual risk is concentrated in silent-failure observability and unbounded LLM prompt costs — both fixable in small, surgical edits before any real production traffic.
