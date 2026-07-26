# Architecture — Groundwork

Full system design. Quick reference lives in `README.md` and `AI_CEO_INSTRUCTIONS.md`.

---

## Two agent graphs — the distinction that matters most

This repo contains two separate multi-agent systems. Confusing them is the single most likely source of future architectural mistakes.

### 1. The build team

Builds Groundwork. Defined in `docs/agent-team.md` and `.claude/agents/`. An orchestrator (brain), 11 builder hands, and 3 reduce/verify nodes, following the `async-agent-graph-engineering` skill's diamond pattern. Exists only during development. Ships nowhere.

### 2. The Guide Engine

*Is* Groundwork. Designed under §5 of the build plan by `guide-engine-architect`, implemented by `evaluator-engineer`, `synthesis-engineer`, and `program-coach-engineer`. Five specialized runtime agents:

- **PACER** — owns the clock. Deterministic in the common case; escalates to an LLM only to decide what to cut.
- **EVALUATOR** — reads submissions + transcript against a segment's rubric, passed in as data.
- **PROBER** — generates a re-prompt specific to what the room actually said.
- **SYNTHESIZER** — turns raw input into versioned plan artifacts with provenance.
- **COACH** — the between-session agent; nudges, prep briefs, review agendas.

Runs live, in a church, for up to eight hours. Ships to every paying customer.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Edge / API | Cloudflare Workers | Low cold start, matches Jeremy's existing stack |
| Live session state | Durable Objects, one per session | Single-threaded consistency for a room of up to 12 clients |
| Realtime transport | WebSockets to the session DO | Shared screen and phones connect to the same object |
| Relational data | D1 | Organizations, users, subscriptions, plan artifacts |
| Object storage | R2 | Audio chunks, generated PDFs, exports |
| Transcription | Workers AI Whisper, chunked | On-platform, no third-party audio egress |
| Guide reasoning | Anthropic API — Sonnet in-session, Opus at synthesis | Latency matters live; quality matters for the board-facing plan |
| Front end | React + Vite, PWA | One build serves the shared screen and every phone |
| Auth | Cloudflare Access or Clerk | Not rolled in-house |
| Payments | Stripe | Subscriptions, tiers, trials |

## Why Durable Objects specifically

A full-day session has one shared screen and up to a dozen phones mutating the same state concurrently — submissions, votes, the clock, guide prompts. A stateless Worker with D1 reads produces inconsistent views and lost writes. One Durable Object per session gives a single authoritative in-memory copy with serialized access, plus WebSocket hibernation so idle connections during discussion cost nothing.

**Keyed `session:{orgId}:{labId}:{sessionId}`.** Holds live state, broadcasts to connected clients, checkpoints to D1 every 30 seconds and at every segment boundary.

## Offline resilience (Phase 3, non-negotiable)

Church wifi fails. A session that dies at hour four is unrecoverable. Requirements: full local mirror in IndexedDB on the shared screen, phone submission queue with UUID-deduplicated replay, reconnect reconciliation via `stateVersion` + per-field vector timestamps (not last-write-wins), and a full-offline degraded mode using pre-cached segment prompts when the network is down more than 5 minutes. See `.claude/agents/resilience-engineer.md`.

## Audio pipeline (Phase 4)

No true streaming transcription — unnecessary for an 8-hour room recording. 60-second Opus chunks → R2 → queue-triggered Workers AI Whisper → transcript segments in D1, tagged to the active segment. ~60 seconds of lag is acceptable; the guide evaluates outcomes, not sentences. Speaker diarization is out of scope for v1.

## Data model

See `migrations/0001_init.sql` for the authoritative schema. Tables: `organization`, `user`, `program`, `lab_session`, `segment_run`, `submission`, `vote`, `transcript_chunk`, `evaluation`, `plan_artifact`, `initiative`, `initiative_step`, `review_cycle`.

Retention: raw audio in R2 auto-deletes at 90 days via lifecycle rule. Transcripts and derived artifacts persist until the org deletes them. Both stated plainly on the consent screen.

## Curriculum as data

Segments are declarative specs, not prompt text — see the schema `guide-engine-architect` produces. This keeps the IP firewall scoped to a reviewable content layer (`content/packs/church/`) instead of scattered through engine code.
