# P0 Scorecard — demo↔spine keys + LLM→console bridge

**Date:** 2026-09-02 (America/Chicago)  
**Branch:** `feat/groundwork-p0-spine-keys`  
**Base:** `claude/subagent-team-build-plan-s2getk`  
**Actor:** local git+gh as jersilb (CloudAgent blocked)

## P0 checklist

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Fix demo vs spine key mismatch (underscore vs hyphen) causing generic rubrics | **DONE** | Demo YAML `key:` fields aligned to spine hyphens (`s2-current-reality`, `s9-closeout`). Regenerated `src/generated/demo-segment-specs.ts`. `specFor()` aliases underscore↔hyphen as a safety net. |
| 2 | Do NOT enable `SESSION_SPINE` until keys are wired correctly | **DONE (kept off)** | `SESSION_SPINE` remains unset in `wrangler.toml` `[vars]` and `.dev.vars`. Comment added documenting why. Keys are now aligned — enabling is Jeremy's explicit env flip, not this PR. |
| 3 | Bridge LLM → console (broken path) | **DONE** | `enqueueGuideRecommendation()` maps probe/evaluator/pacer/synthesis onto the console recommendation queue. Wired from `SessionDO.publishGuideMessage` when `runtime` exists. Announcements/deterministic spineTick kinds stay out of the bridge (no double-queue). |
| 4 | Remeasure EVALUATOR after fix | **DONE** | Real Anthropic harness, 16/16 clean: **precision 1.000**, recall 0.667, TP=4 FP=0 FN=2 TN=10. Phase 2 gate (precision > 0.8): **PASS**. (Fixture harness uses its own segment spec; remasure confirms post-change quality. Existing Anthropic/Workers AI retained — not Grok-only.) |

## Verify (local)

| Gate | Result |
|------|--------|
| `test-demo-pack` | 27/27 PASS (incl. spine-key + underscore-alias checks) |
| `test-session-runtime` | 20/20 PASS (incl. bridge enqueue) |
| `test-session-plan` | 12/12 PASS |
| `test-evaluator-prober-parsing` | 7/7 PASS |
| `test-guide-runtime` | 9/9 PASS |
| `test-six-hour-simulation` | 11/11 PASS |
| `tsc --noEmit` | PASS |
| `run-eval-harness` (REAL) | precision **1.000** — gate PASS |

## Root cause (keys)

- Spine plan + filenames: hyphenated (`s2-current-reality`, `s9-closeout`)
- Demo YAML `key:` fields were underscored (`s2_current_reality`, `s9_commitments_close`)
- `specFor()` exact-match miss → generic 3-criterion rubric on every spine segment

## Out of scope / not done in this PR

- Flipping `SESSION_SPINE=true` in production or `.dev.vars`
- Playwright console operability gate
- Live `test:spine-integration` against wrangler (needs `SESSION_SPINE=true` locally for that harness only)
- Force-push / secret commits
