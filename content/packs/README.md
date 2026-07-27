# Content Packs — Groundwork

Curriculum as data, per build plan §5.2 and §6. Each subdirectory here is a context pack (`church/`, `parachurch/`, `nonprofit/`, `school/`) containing segment spec YAML files that `scripts/compile-segment-specs.ts` compiles into `src/generated/segment-specs.ts`.

**This directory is intentionally empty right now.**

Writing real segment content here is `curriculum-author`'s job (see `.claude/agents/curriculum-author.md`), and it is blocked on `docs/source-principles.md` having entries — which only Jeremy can write, per the IP firewall protocol in build plan §2.3. No AI session should populate this directory.

Ship order per §6: `church/` only in v1. `parachurch/`, `nonprofit/`, and `school/` are expansion releases needing real domain input.

The segment spec schema itself (`src/guide-engine/segment-schema.ts`) and the loader/compiler are architecture, already built (Phase 2) — they don't require curriculum content to exist. A synthetic, clearly-marked test fixture lives at `src/guide-engine/__fixtures__/test-segment.yaml` for validating the loader mechanics only; it is not real curriculum and never gets compiled into a shipped pack.
