# Team Review — Groundwork, AI-Guide-focused (2026-08-28)

**Reviewers (adversarial roles in clean context):** session-runtime, guide-engine,
content/curriculum, frontend-UX, reliability. Each ran its checks against the
actual code, not against the docs.

---

## Verdict

The architecture is sound and unusually well-disciplined — the IP firewall, the
"curriculum is data" compiler, the §5.5 leader-override invariant, and the
provenance-verified SYNTHESIZER are genuinely well-built. The single most
important finding is structural, not cosmetic:

> **Curriculum-as-data is compiled but never consumed.** The `content/packs/`
> compiler produces `SEGMENT_SPECS`, yet no runtime code imports it. Every guide
> call site (`maybeRunEvaluation`, `runBoundarySynthesis`, `runPacerIfDue`) calls
> `defaultSpecFor()` — a hardcoded generic 3-criterion rubric. So even if a rich
> pack existed, the Guide would grade every segment with the same generic lens.

That is both the report's headline finding and the thing this pass fixed: I wired a
`specFor(segment)` resolver (demo/reference pack by key → generic fallback) and
added a synthetic, clearly-labeled `_demo` reference pack + rehearsal so test labs
run with segment-specific objectives and rubrics.

---

## Missing (should have existed)

### M1 — Runtime never consumes the compiled curriculum  [critical, fixed this pass]
`SEGMENT_SPECS` was generated (0… then would-be populated) and orphaned. The guide
hardcoded `defaultSpecFor`. Real packs would have silently degraded to the generic
rubric. Now: `specFor()` resolves demo keys, falls back to generic.

### M2 — No non-trivial reference content for any test lab  [fixed this pass]
The product ran a 3-segment, 7-minute fake lab (`welcome / warm-up / wrap-up`) with
zero meaningful objectives or rubrics. No way to rehearse a rich session. Now: a
9-segment, ~5h15m `content/packs/_demo/` pack mapped to the build plan §7 arc, with
segment-specific objectives, input modes (silent-write, vote-then-discuss, phone-
submit, discussion-only), exit criteria, and rubrics. Compiled separately from the
live bundle so it can never ship as curriculum.

### M3 — No "better feature" path for break/breakout orchestration yet
The §7 itinerary references breaks and breakouts, but the schema and runtime have
no BreakSpec/BreakoutSpec. This is Release-2 territory in the build plan and is
correctly deferred — but it is worth flagging that the demo pack's `planned_minutes`
sums to pure segment time (≈5h15m), so breaks are not yet representable.

### M4 — Exit criteria beyond `min_submissions_met` are unwired
Candidates like `vote_completed`, `candor_check_passed`, `leader_confirmed` are
declared in the schema but `computeExitCriteria()` only ever returns
`min_submissions_met`. Human-judgment criteria are deliberately manual (§5.5), but
`vote_completed` IS observable and could surface to the leader. Currently a vote
segment's PACER treats it as unsatisfiable until the master advances — correct but
leaves a UI affordance unexploited.

## Broken (real defects found)

### B1 — Compile was broken the moment a second source dir existed
The compiler had a hardcoded `SEGMENT_SPECS` name and single output; my first pass
at splitting live vs reference content left a duplicate `function compile` that
failed at load. Fixed and re-run green. (Caught, not shipped.)

### B2 — Demo-pack PACER test initially asserted the wrong behavior (test bug, not code bug)
Early rehearsal asserted "continue on pace" using `min_submissions` as the count —
which *correctly* satisfies exit criteria and advances. The assertion was wrong;
the code was right. Fixed the test to hold criteria pending.

## Better (opportunities, not defects)

- **Key-based resolution is the right seam.** Packs plug into `specFor()` the same
  way demo does. When real `content/packs/church/` lands, the Guide upgrades
  automatically by matching segment keys — no runtime change.
- **PROBER is under-powered today** (only fires on thin/off_track). A fully
  specified segment objective gives PROBER materially better material to build a
  specific follow-up from.
- **The 30s-tick model hides PACER's budget view.** `remainingBudgetMinutes()`
  sums *future* segments only; it deliberately ignores accumulated overrun. For a
  six-hour day that drift compounds. Recommend surfacing cumulative drift to the
  leader (Release-2 clocks work).

---

## What changed this pass (all verified green)

| File | Change |
|---|---|
| `scripts/compile-segment-specs.ts` | Split live vs `_`-reference packs; emit `demo-segment-specs.ts` separately |
| `src/guide-engine/session-guide.ts` | Added `specFor()` — demo-by-key → generic fallback |
| `src/session-do.ts` | All three guide call sites use `specFor()` |
| `content/packs/_demo/*.yaml` | 9 synthetic, IP-safe demo segments (six-hour arc) + README |
| `scripts/test-demo-pack.ts` | 24-check deterministic rehearsal (resolver + PACER full-day) |
| `package.json`, `.github/workflows/ci.yml` | `test:demo-pack` wired into Phase-2 gate |

**Verified:** `specs:compile` (9 demo, 0 live), `typecheck`, `test:guide-runtime`
(9), `test:pacer` (6), `test:demo-pack` (24), `lint:vocab` clean (IP firewall),
`build:web` green.

## Residual risk

- The `_demo` pack is not real curriculum; treat it as a rehearsal/demo fixture.
  When organic `content/packs/church/` ships, replace demo usage via the same
  `specFor()` path.
- `vote_completed` remains unobservable to the leader (M4) — flagged, not shipped.