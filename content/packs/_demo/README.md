# `_demo` — Synthetic Reference Pack (test labs only)

**This is NOT real curriculum. It never claims to be.**

The `_demo/` prefix keeps this directory OUT of the shipped `SEGMENT_SPECS`
bundle (see `scripts/compile-segment-specs.ts`). It exists so a member of the
team — or a pilot rehearsal — can run a rich, realistic test lab *before* real
curriculum exists, without the guide falling back to the generic 3-criterion
rubric.

## Why it is safe

- Written from the build plan §7 reference itinerary, which is itself labeled
  *"a technical test fixture only until approved curriculum exists."*
- Uses only the IP-safe planning vocabulary from `docs/vocabulary.md`
  (purpose, vision, values, current reality, priorities, initiatives, review
  rhythm, renewal) — no trademarked terms, no protected methodology, no
  replicated worksheet structure.
- Doctrinally neutral: no theological position is taken or assumed.

## How it is used

The compiler emits these into `src/generated/demo-segment-specs.ts`, which the
guide can load independently (they are **not** merged into `SEGMENT_SPECS`).
`demoSpecFor(segmentKey)` in `src/guide-engine/session-guide.ts` resolves a
segment's spec from here by key, falling back to `defaultSpecFor`. That lets a
test lab define segments whose titles/keys match demo keys and immediately get
segment-specific objectives and rubrics — the same pipeline real packs will use.

## Caveat

When Jeremy has organic content in `content/packs/church/` and that pack ships,
`demo` remains a dev/test aid and is never treated as deliverable curriculum.
Replace `_demo` segments with the real pack via the same key-resolution path.