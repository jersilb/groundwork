# HANDOFF — Groundwork

**Instructions**: Fill this in before pasting it into Claude Code at the start of any manual session. Keep it under 1,500 tokens.

---

## Date & Session Context

**Date**: 2026-08-27
**Session goal**: Deep-dive hardening — achieved. The AI Guide now runs live inside real sessions (PACER/EVALUATOR/PROBER/SYNTHESIZER wired into SessionDO), critical security holes from the auth session are closed, and the Worker redeploys with migration 0005. Full findings: `OUTPUTS/deep-dive-report-2026-08-27.md`.

---

## What Happened Since Last Session

- Guide Engine wired live in `SessionDO` (`src/guide-engine/session-guide.ts`): guide messages ride `guideLog` in the state broadcast; shared screen shows a Guide panel, phones show probe prompts. `GUIDE_ENABLED=true` in prod, false locally so tests stay deterministic.
- `/webhooks/stripe` fixed (was 401-dead in production — the auth gate pre-routed ALL non-GETs; Stripe can't present an Access JWT). Subscription deletion now clears the tier.
- Org authorization on session-scoped routes (`src/auth/authorize.ts`): plan reads, synthesize, consent/kill-switch/chunk uploads for `lab-` rooms require org membership.
- Screen-role token (migration 0005): opening a room (leader-only) mints `screen_token`; the DO rejects tokenless screen connections on `lab-` rooms. RoomScreen strips `?st=` so the token never projects.
- SessionDO input caps; 10 MB chunk cap; queue `max_retries=5`; `CF_ACCESS_AUD` binding; review-cycle cross-tenant leak closed; COACH per-step error isolation; PWA maskable icon + real screenshots restored; smoke-web exit-code bug fixed.
- New test `test:guide-runtime`; session-integration covers the token gate. All suites green 2026-08-27.

---

## Decisions Already Made (Treat as Settled)

- One submission per participant per segment is by design (no submission clocks; leader override is the edit path).
- API is same-origin always — do NOT reintroduce VITE_API_BASE_URL (an ambient env var once baked localhost:3001 into a prod bundle).
- SessionSocket connects with role/clientId as WS upgrade query params (the DO's identity gate).
- web/ design system in web/src/theme.css — every screen follows it.

---

## Open Questions for the AI

- None blocking. Next session: run the real-device gate day, then Phase 8 planning.

---

## Constraints for This Session

- IP firewall: never touch docs/source-principles.md or content/packs/ (curriculum is human-gated); no trademarked terms (node scripts/lint-vocabulary.mjs must stay clean).
- $200/mo soft cap (docs/economics.md). Do not create billed infra without Jeremy.
- The guide's generic facilitation rubric (`session-guide.ts`) is our own methodology language — keep it generic until real pack specs replace `defaultSpecFor`.

---

## After This Session, AI Should (Autonomous Follow-Up)

- None pending. Next: real-device gate day, then Phase 8 planning. Watch the first live-guide session's `guideLog` quality (probe specificity, pacer tone) and tune prompts only with eval-harness evidence.

---

*AI: acknowledge this handoff, confirm the session goal, check DASHBOARD.md for current status, then proceed.*
