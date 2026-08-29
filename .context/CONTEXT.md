# CONTEXT — Groundwork AI Instructor Program

**Charter owner:** Jeremy (executive sponsor) · **Director:** ai-director (this session) · **Started:** 2026-08-28

---

## Objective

Build the Groundwork AI Instructor per `docs/ai-instructor-tech-scope-build-plan.md`: a first-class AI
Guide that visibly leads a six-hour strategic session — identity, itinerary, breaks, breakouts,
output audits — while a human sponsor retains final authority.

## Definition of done (concrete, checkable)

1. A reviewed curriculum pack compiles through the SessionPlan schema with zero validation errors.
2. A simulated six-hour session (deterministic harness) executes the full itinerary: every break
   taken or explicitly overridden; 15/30/60-minute drift detected; closing buffer protected;
   DO restart resumes without state loss; cannot silently complete with missing required outputs.
3. An instructor can run that same session using only the console UI — no dev tools — and every
   Guide recommendation shows accept / edit / dismiss with a stated reason.
4. Participants see the Guide's identity, contract, and correction mechanism before work begins
   (R1 acceptance check passes in a real browser).
5. Breakout: 6–12 participants assigned, group packets delivered, report-back collected, conflicts
   preserved, instructor accepts what becomes canonical.
6. `npm run typecheck` + full session test suite green; vocabulary lint clean; no banned terms.
7. All fourteen degraded scenarios in the rehearsal harness have a deterministic documented path.

## Constraints

- IP firewall absolute: no trademarked terms, no source-methodology content anywhere (vocabulary lint is a CI gate).
- Strict doctrinal neutrality in every generated string.
- §5.5: leader override is absolute — the Guide never mutates planning state or auto-advances.
- No live Cloudflare resource creation without Jeremy present; local emulation only for dev/test.
- $200/mo soft cap; model routing per smart-model rubric, announced per task.
- Console must extend the existing Fraunces/Sora "planning-room" design system (web/src/theme.css).

## Out of scope (this program)

Voice-first operation, sentiment/personality inference, autonomous advancement, automatic consensus
declaration, complex group-matching algorithms, real curriculum content (human-gated, Tier 2/3).

## Effort budget

Eight releases (R0–R8) per the tech-scope plan; this campaign staffs R0–R4 (pilot-critical path).
R5–R8 briefs are pre-drafted in `docs/ai-instructor-agent-team.md` §8 but not dispatched.

## Verification

All checks live in `.context/VERIFY.md`. Anchor-grade checks are executable (run the harness);
nothing passes on an agent's say-so. See also `.context/LESSONS.md` before writing briefs.
