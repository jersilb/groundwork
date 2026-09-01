# LESSONS — AI Instructor Program

Append-only. A lesson nobody is told to read protects nobody — briefs cite these by ID.

- **L1 (2026-08-27, session tests)**: `wrangler dev`-based integration tests hang when the
  spawned process's stdio pipes fill with no listener, and orphaned `workerd` children hold
  ports. Fix pattern: drain pipes with no-op listeners, spawn `detached: true`, kill the whole
  process group via `process.kill(-pid, "SIGKILL")`. Every new rehearsal/scenario script copies this.
- **L2 (2026-08-27, phase tests)**: 45s watchdogs are too tight for cold `wrangler dev` starts on
  this machine. Warm the dev server first or budget ≥120s; never widen the watchdog silently.
- **L3 (2026-08-27, docs)**: `docs/decisions.md` is append-only — an earlier edit truncated
  historical entries (restored 2026-08-28). Never rewrite history there; append corrections.
- **L4 (2026-08-27, guides)**: guide logic must never run on the WebSocket message path — LLM
  latency spikes delay submit acks. Keep evaluation/synthesis on `ctx.waitUntil` off the hot path.
- **L5 (2026-08-28, team)**: PACER nags when it repeats the same action each tick — "say it once
  per state change" is the standing pattern for ALL Guide actions, including new break/breakout
  announcements. Dedupe by (action, subject) before publishing.
- **L6 (2026-08-28, verification)**: an exit criterion the Guide can observe must stay automatable
  (`min_submissions_met`); human judgments (`leader_confirmed`, `candor_check_passed`) are the
  leader's act of advancing, not the Guide's inference. New output-audit gates follow the same split.
- **L7 (2026-08-28, session-integration)**: the "completed lab cannot be reopened" check can
  flake once with a 500 when the route's D1 write races the DO's 30s checkpoint on local
  SQLite (miniflare lock). Retry the suite once before diagnosing a regression — a persistent
  failure is real, a one-off is the lock.
