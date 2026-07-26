# Economics & Resource Model — Groundwork
**Last Updated**: 2026-07-26 — AI CEO should update actual costs monthly once there's real usage.

---

## Build-Phase Monthly Cost Model (pre-revenue)

| Service / Resource | Provider | Billing Model | Est. Monthly | Actual (Last Month) |
|--------------------|----------|---------------|--------------|---------------------|
| Compute / Hosting | Cloudflare Workers | Free tier during dev | $0 | — |
| D1 / R2 / KV | Cloudflare | Free tier during dev (local emulation, Phase 0) | $0 | — |
| LLM API usage | Anthropic | Per-token, build + eval-suite testing | ~$30–80 | — |
| Stripe | Stripe | Test mode, no live charges | $0 | — |
| **Total Estimated** | | | **< $200/mo** | — |

Update "Actual" from real invoices/API dashboards once Phase 1+ generates real usage.

---

## Build-Phase Budget Gates

| Threshold | Trigger Condition | Action |
|-----------|-------------------|--------|
| Monthly build spend | > $200/month (Jeremy's soft cap, 2026-07-26) | Escalation brief, halt non-critical spend |
| Single LLM call cost | Unusually high for the call type | Log + flag; do not repeat without approval |
| Any new paid service | Any unplanned addition | Always escalate before subscribing |
| Cumulative session spend | Trending to exceed a meaningful fraction of the monthly cap in one session | Pause and report before continuing |

---

## Product Cost Model (from Phase 2 onward — the real target)

Per session-day, instrument and measure against these plan estimates:
- Transcription: ~8 hours audio through Workers AI Whisper.
- EVALUATOR: ~16 segments × 2–3 calls, Sonnet.
- PROBER: ~10–20 calls, Sonnet.
- SYNTHESIZER: ~16 segment syntheses + 1 full-session synthesis, Opus.
- PACER: mostly deterministic, occasional Sonnet escalation.

**Target**: cost per session-day under 8% of amortized subscription revenue for that pricing band. Assumptions here will be wrong until measured — track actuals starting with the first real Phase 2 eval run.

---

## Pricing (from the build plan §9 — reference, not a build-phase concern yet)

| Band (annual operating budget) | Year 1 (4 labs + platform) | Year 2+ sustain (renewal + dashboard + reviews) |
|---|---|---|
| Under $250K | $2,400 | $900/yr |
| $250K–$1M | $4,800 | $1,800/yr |
| $1M–$5M | $9,600 | $3,600/yr |
| $5M+ | Quote | ~40% of year 1 |

Annual billing, ~20% premium for monthly. Free trial covers setup + first two segments of Lab 1 — not a time window. Pricing changes are Tier 2 (propose to Jeremy).

---

## Value / ROI Tracking

| Value Type | Metric | Baseline | Target (3–6 months post-launch) | Current |
|------------|--------|----------|----------------------------------|---------|
| Lab 1 → Lab 4 completion | % of churches finishing all four labs | — (pre-launch) | > 60% | — |
| Year 1 → sustain conversion | % renewing into year 2 | — (pre-launch) | > 70% | — |

**How to measure**: count against `program.status` and `program.renewal_due_at` in D1 once real orgs exist. Not measurable until Phase 6+ is live with real customers.

---

## Cost Optimization Notes

- Cheap models on fan-out (Haiku for `integration-reducer`), Sonnet for in-session agents (latency matters live), Opus reserved for synthesis and verification.
- PACER stays deterministic in the common case — LLM calls only to decide what to cut.
- Keep Phase 0–1 entirely on local wrangler emulation; no billed Cloudflare resources until there's a reason to pay for them.
