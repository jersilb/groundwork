# HANDOFF — Groundwork

**Instructions**: Fill this in before pasting it into Claude Code at the start of any manual session. Keep it under 1,500 tokens.

---

## Date & Session Context

**Date**: 2026-08-16
**Session goal**: Production-ready MVP — achieved. Full frontend built (web/, Vite/React PWA), session resilience + leader override + real lab wiring landed, 15/15 verification gates green, **deployed to https://groundwork.jersilb.workers.dev and verified live** (health, SPA shell, real WebSocket session).

---

## What Happened Since Last Session

- Six-agent build under an AI director: shared-screen room UI, phone client (durable offline outbox), org dashboard/program screens, real-tier billing, install flow, landing, production service worker.
- Worker now serves the PWA (assets binding + SPA fallback); reconnect/replay hardened (D1 checkpoint restore on eviction); POST /lab-session/:id/open opens real lab rooms; leader-override contract added.
- New tests: scripts/test-session-integration.mjs, scripts/smoke-web.mjs (full-stack real-Chromium). All 15 gates green.
- Deployed 2026-08-16 (replaced the 2026-08-02 frontend-less build). Secrets persist: ANTHROPIC_API_KEY, STRIPE_SECRET_KEY.

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

---

## After This Session, AI Should (Autonomous Follow-Up)

- Nothing pending: build is complete and deployed. Awaiting Jeremy's calls on Phase 2 strategy, real-device gates, pilot churches, trademark, Phase 8 curriculum.

---

*AI: acknowledge this handoff, confirm the session goal, check DASHBOARD.md for current status, then proceed.*
