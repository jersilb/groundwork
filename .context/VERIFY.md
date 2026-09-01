# VERIFY — AI Instructor Program

Executable > checklist > named reviewer. Run top to bottom; a red line blocks delivery.

## Level 1 — Repo gates (run on every merge)

```bash
npm run typecheck                 # worker + web TS, zero errors
npm run lint:vocab                # IP firewall; must be clean
npm run test:guide-runtime        # guide orchestration contract
npm run test:pacer                # deterministic PACER logic
npm run test:evaluator-prober-parsing
npm run test:synthesizer-provenance
npm run test:stripe-webhook
```

## Level 2 — Session/spine regression (every merge touching src/session* or guide-engine)

```bash
node scripts/test-session-integration.mjs   # includes screen-token gate
node scripts/test-phase1-multiclient.mjs
node scripts/test-phase3-resilience.mjs
```

## Level 3 — AI Instructor program gates (added by this campaign)

| Gate | Check | Status |
|---|---|---|
| Itinerary schema | `npm run test:session-plan` — compiles the reference six-hour plan, rejects 11 malformed fixture classes (missing output, impossible timing, no report-back, overlapping break, unknown input mode, negative minutes, duplicate segment keys, unclosed plan, oversized buffer, ghost anchors, garbage) | **shipped R0 (2026-08-28) — 12 checks green** |
| Session runtime | `npm run test:session-runtime` — transition legality, protected break minimums + forced-override recording, drift arithmetic, closing gate, event cap, recommendation lifecycle, JSON round-trip | **shipped R0/R2 (2026-08-28) — 19 checks green** |
| Six-hour simulation | `npm run test:six-hour-simulation` — deterministic scripted run; asserts break count, drift ladder 15/30/60 once each, closing-buffer protection, resume-after-restart, blocked silent completion, degraded paths (LLM outage, skip, break extension, forced end, participant correction) | **shipped R2 (2026-08-28) — 11 checks green** |
| Spine integration | `npm run test:spine-integration` — live wrangler dev with SESSION_SPINE=true: full protocol walk (start/break/extend/forced-end/breakout/human-led/phone-gate/correction/closing gate/force-close) + DO eviction with runtime restore | **shipped R0/R2 (2026-08-28) — 22 checks green** |
| Console operability | Playwright: instructor completes a full simulated session via UI only; every recommendation exposes accept/edit/dismiss; overrides logged | planned R3 (UI shipped 2026-08-28; Playwright run pending) |
| Breakout E2E | 6–12 phone clients, group packets, report-back, conflict preservation, instructor canonical-accept | planned R4 (breakout phase + packets shipped in the runtime; group assignment pending) |
| Identity/consent | Playwright: fresh participant sees Guide identity + contract + correction affordance before any prompt | planned R1 (UI shipped 2026-08-28; Playwright run pending) |
| Degraded rehearsal | 14-scenario harness — every scenario ends in a documented deterministic recovery | partial: 6 scenarios covered in the six-hour simulation; remaining 8 planned R5 |

## Level 4 — Review gates (human or clean-context agent)

- Clean-context verifier pass on any state-machine or clock change (Expert tier).
- IP-firewall guardian on any new user-visible string or pack content.
- Jeremy's facilitation language sign-off before R1 exit (Tier 2: guide prompt/identity copy).
