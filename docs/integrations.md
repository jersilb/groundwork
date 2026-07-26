# Integration Map — Groundwork
**Last Updated**: 2026-07-26
**Maintained by**: AI CEO — update whenever a new service is added or access levels change.

This file tells the AI exactly what it can do autonomously with each connected service, and what needs Jeremy's approval. When in doubt, err toward "requires approval."

---

### Cloudflare (Workers, Durable Objects, D1, R2, Workers AI, KV)

| Field | Value |
|-------|-------|
| Connection method | Wrangler CLI, `wrangler.toml` |
| Auth stored in | Jeremy's Cloudflare account — not attached in this build phase |
| Rate limit / cost | Free tier while local; real usage costs apply once live resources exist |

**AI autonomous actions**:
- Local dev via `wrangler dev` (local emulation of D1/DO/R2, no live account needed).
- Local D1 migration apply (`wrangler d1 migrations apply --local`).

**Requires Jeremy approval**:
- Creating any real (non-local) D1 database, R2 bucket, or KV namespace.
- Any `wrangler deploy` to a live environment.
- Any spend-incurring configuration change.

**Never do autonomously**:
- Provision billed infrastructure under Jeremy's account without him present.

**Fallback if unavailable**: work stays local; log to `docs/capability-gaps.md`.

---

### Anthropic API

| Field | Value |
|-------|-------|
| Connection method | API key |
| Auth stored in | Environment secret, not committed |
| Rate limit / cost | Per-token; Sonnet for in-session agents, Opus for synthesis/verification |

**AI autonomous actions**:
- Calls within the eval suite and build-phase testing, under the $200/mo cap.

**Requires Jeremy approval**:
- Any change to which model tier serves a given agent role (cost/quality tradeoff).
- Sustained spend trending toward the monthly cap.

**Fallback if unavailable**: log to `docs/capability-gaps.md`; do not silently retry against a different provider.

---

### Stripe

| Field | Value |
|-------|-------|
| Connection method | API key (test mode during build) |
| Auth stored in | Environment secret, not committed |
| Rate limit / cost | Per-transaction, live mode only |

**AI autonomous actions**:
- Test-mode integration work (Phase 7).

**Requires Jeremy approval**:
- Any live-mode configuration.
- Pricing tier changes (Tier 2, per `AI_CEO_INSTRUCTIONS.md`).

**Never do autonomously**:
- Refunds or dispute handling (Tier 3).

**Fallback if unavailable**: log to `docs/capability-gaps.md`.

---

### Auth provider (Cloudflare Access or Clerk — not yet decided)

| Field | Value |
|-------|-------|
| Connection method | TBD |
| Auth | TBD |
| Rate limit / cost | TBD |

**AI autonomous actions**: none yet — decision pending for Phase 6/7.

**Requires approval**: the choice itself (new external integration — Tier 2).

**Fallback if unavailable**: flag in `docs/capability-gaps.md` before Phase 6 starts.

---

## Internal Tool Schemas

### `scripts/collect_metrics.py`
- **Purpose**: Collect health metrics, write `ops/status.json`.
- **Run**: `python3 scripts/collect_metrics.py`
- **Output**: `ops/status.json` (overwrites previous).
- **Side effects**: None — read-only.

### `scripts/update_dashboard.py`
- **Purpose**: Read `ops/status.json`, rewrite `DASHBOARD.md`.
- **Run**: `python3 scripts/update_dashboard.py`
- **Output**: `DASHBOARD.md` (overwrites).
- **Depends on**: `ops/status.json` existing.

### `scripts/lint-vocabulary.mjs`
- **Purpose**: Fail CI if a banned trademark term appears in a tracked, non-exempt file.
- **Run**: `node scripts/lint-vocabulary.mjs`
- **Self-test**: `node scripts/lint-vocabulary.mjs --self-test` — plants a banned term in a throwaway fixture, asserts the lint catches it, cleans up.
- **Output**: exit code 0 (clean) or 1 (violation found), with file:line matches printed.
- **Depends on**: `docs/vocabulary.md` (term source), `.vocabignore` (exemptions).

---

## Dependency Health Log

| Service | Status | Last Verified | Notes |
|---------|--------|----------------|-------|
| Cloudflare (local emulation) | 🟢 | 2026-07-26 | `wrangler` 4.114.0 via npx, no live account |
| npm registry | 🟢 | 2026-07-26 | Reachable through configured proxy |
| Anthropic API | — | Not yet tested in this repo | Pending Phase 2 |
| Stripe | — | Not yet integrated | Pending Phase 7 |
