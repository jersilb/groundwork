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
| Itinerary schema | `node --experimental-strip-types scripts/test-session-plan.ts` — compiles a reference six-hour plan, rejects 8 malformed fixtures (missing output, impossible timing, no report-back, overlapping break, unknown input mode, negative minutes, duplicate segment keys, unclosed plan) | planned R0 |
| Six-hour simulation | `node scripts/test-six-hour-simulation.mjs` — deterministic scripted run; asserts break count, drift detection at 15/30/60 min, closing-buffer protection, resume-after-restart, blocked silent completion | planned R2 |
| Console operability | Playwright: instructor completes a full simulated session via UI only; every recommendation exposes accept/edit/dismiss; overrides logged | planned R3 |
| Breakout E2E | 6–12 phone clients, group packets, report-back, conflict preservation, instructor canonical-accept | planned R4 |
| Identity/consent | Playwright: fresh participant sees Guide identity + contract + correction affordance before any prompt | planned R1 |
| Degraded rehearsal | 14-scenario harness — every scenario ends in a documented deterministic recovery | planned R5 |

## Level 4 — Review gates (human or clean-context agent)

- Clean-context verifier pass on any state-machine or clock change (Expert tier).
- IP-firewall guardian on any new user-visible string or pack content.
- Jeremy's facilitation language sign-off before R1 exit (Tier 2: guide prompt/identity copy).
