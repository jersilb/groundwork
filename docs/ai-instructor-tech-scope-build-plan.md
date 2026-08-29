# Groundwork AI Instructor — Technical Scope & Build Plan

**Status:** Proposed architecture and delivery plan
**Date:** 2026-08-28
**Audience:** Product, engineering, curriculum, pilot facilitators

## 1. Product target

Groundwork is not merely an AI-assisted workshop application. The Guide is a first-class AI instructor that leads a known program in front of participants who have been told what it is and consented to its operation.

The target experience is:

> The AI leads the process; participants supply experience, judgment, and decisions; a human sponsor owns organizational, pastoral, safety, and final decision authority.

The AI instructor must be able to run a six-hour working session with scheduled breaks and breakout exercises while remaining transparent, interruptible, recoverable, and curriculum-bound.

## 2. Non-negotiable boundaries

1. **Visible AI identity:** Participants always know that the instructor is AI. The Guide introduces itself, explains its role, identifies uncertainty, and accepts correction.
2. **Human authority:** The Guide recommends, instructs, asks, summarizes, and manages process. It never claims theological, pastoral, legal, personnel, or organizational authority.
3. **Instructor override:** A human sponsor can pause, redirect, edit, skip, repeat, or end any activity.
4. **No false consensus:** Agreement, disagreement, abstention, and unresolved questions remain distinguishable.
5. **Source integrity:** Generated artifacts cite only participant input or approved curriculum; fabricated quotations are rejected.
6. **Consent and privacy:** Recording, transcription, retention, and AI processing are visible and controllable. Sensitive issues can be handed to the human sponsor.
7. **Graceful degradation:** A model outage, network loss, or device failure must not destroy participant work or make the room unsafe.
8. **Curriculum/IP firewall:** Facilitation engine code contains no protected source methodology or unapproved curriculum content. Curriculum remains reviewable data.

## 3. Scope of the target system

### In scope

- Guide identity, introduction, and operating contract
- Curriculum-defined multi-hour itineraries
- Durable session state machine
- Session clock, drift detection, and time-budget recommendations
- Break lifecycle and re-entry
- Structured breakout sessions
- Participant and group progress tracking
- Instructor console and action audit
- Guide recommendation queue
- Output quality and closing audit
- Human handoff and recovery protocols
- Multi-session confirmed memory
- Voice-ready facilitation contracts with text fallback
- Deterministic simulation and pilot instrumentation

### Out of scope for the first pilot

- Autonomous advancement without a human action
- Psychological profiling, sentiment diagnosis, or hidden participant scores
- Automatic consensus declaration
- Private inference about a participant's beliefs or emotional state
- Complex algorithmic group matching
- Fully autonomous handling of safeguarding, pastoral, or crisis content
- Source curriculum creation without approved human-authored principles
- Voice-only operation before text orchestration is proven

## 4. Current foundation and required evolution

The current application already has:

- Cloudflare Worker, Durable Object, D1, R2, Queue, and Workers AI bindings
- React/Vite PWA with shared-screen and phone clients
- WebSocket session state and reconnect/checkpoint behavior
- PACER, EVALUATOR, PROBER, SYNTHESIZER, and COACH modules
- Guide messages broadcast through `guideLog`
- Leader-only screen actions and screen-token authorization
- Submission limits, provenance validation, and offline input queue

The main architectural gap is not another prompt. It is the absence of a durable, explicit model for the whole session. The current three-segment fake lab and `SessionState` should become an adapter-compatible first implementation of a richer itinerary runtime.

## 5. Target architecture

```text
Curriculum Pack
  -> Session Plan Compiler
  -> Session Orchestrator
       -> State Machine
       -> Session Clock
       -> Break Manager
       -> Breakout Manager
       -> Recovery Manager
       -> Completion Audit
       -> Guide Runtime
       -> Instructor Actions
  -> Session Durable Object
       -> WebSocket state broadcast
       -> D1 checkpoints/events/artifacts
       -> R2 audio/transcripts/exports
  -> Shared Screen / Participant Phones / Instructor Console
```

### 5.1 Curriculum data

Curriculum is declarative and versioned. It defines intended activities, not runtime state.

```ts
interface SessionPlan {
  id: string;
  version: string;
  title: string;
  plannedMinutes: number;
  segments: SegmentPlan[];
  breaks: BreakSpec[];
  breakouts: BreakoutSpec[];
  closing: ClosingSpec;
}

interface SegmentPlan {
  key: string;
  title: string;
  objective: string;
  plannedMinutes: number;
  inputMode: "phone_submit_then_discuss" | "discussion_only" | "vote_then_discuss" | "silent_write";
  requiredOutputs: OutputRequirement[];
  rubric: RubricCriterion[];
  exitCriteria: ExitCriterion[];
  allowedAdaptations: Adaptation[];
  fallbackIfStuck: RecoveryStrategy[];
}

interface BreakSpec {
  id: string;
  afterSegmentKey: string;
  plannedMinutes: number;
  minimumMinutes: number;
  reentryPrompt: string;
}

interface BreakoutSpec {
  id: string;
  title: string;
  purpose: string;
  durationMinutes: number;
  groupStrategy: "random" | "mixed" | "role" | "manual";
  roles: string[];
  instructions: string[];
  requiredFields: OutputRequirement[];
  reportBackMinutes: number;
  stuckProtocol: RecoveryStrategy[];
}
```

Curriculum packs should be compiled and schema-validated before deployment. A pack cannot ship with missing objectives, impossible timing, no required output, or a breakout without a report-back protocol.

### 5.2 Runtime state

Runtime state is separate from curriculum and persisted through DO storage plus D1 checkpoints.

```ts
interface SessionRuntimeState {
  sessionId: string;
  planId: string;
  planVersion: string;
  phase: "setup" | "welcome" | "active" | "break" | "breakout" | "reentry" | "recovery" | "closing" | "complete";
  currentSegmentIndex: number;
  segmentState: "not_started" | "active" | "awaiting_confirmation" | "complete" | "parked";
  startedAt: string;
  phaseStartedAt: string;
  pausedAt?: string;
  clock: SessionClockState;
  breakState?: BreakRuntimeState;
  breakoutState?: BreakoutRuntimeState;
  requiredOutputs: OutputStatus[];
  parkedIssues: ParkedIssue[];
  guideMode: "ai_led" | "human_assisted" | "human_led" | "paused";
  guideLog: GuideMessage[];
  lastCheckpointVersion: number;
}
```

### 5.3 Guide actions

The Guide runtime should produce typed recommendations/actions, not only free-form text.

```ts
type GuideAction =
  | { type: "introduce"; text: string }
  | { type: "announce_segment"; segmentKey: string; text: string }
  | { type: "ask_question"; text: string }
  | { type: "time_check"; minutesRemaining: number; text: string }
  | { type: "announce_break"; breakId: string; minutes: number; text: string }
  | { type: "launch_breakout"; breakoutId: string; text: string }
  | { type: "request_confirmation"; outputKeys: string[]; text: string }
  | { type: "summarize"; text: string; provenance: ProvenanceRef[] }
  | { type: "recommend_recovery"; strategy: RecoveryStrategy; reason: string }
  | { type: "request_human_intervention"; reason: string }
  | { type: "pause"; reason: string };
```

The action is shown to the room or instructor according to its audience. It is not authoritative until the appropriate human or participant action confirms it.

### 5.4 Human actions

```ts
interface InstructorAction {
  id: string;
  actorId: string;
  type:
    | "start"
    | "pause"
    | "resume"
    | "start_break"
    | "extend_break"
    | "end_break"
    | "start_breakout"
    | "send_broadcast"
    | "accept_recommendation"
    | "edit_recommendation"
    | "dismiss_recommendation"
    | "repeat_segment"
    | "skip_segment"
    | "park_issue"
    | "return_to_segment"
    | "enter_human_led"
    | "return_to_ai_led"
    | "complete_output"
    | "end_session";
  payload: Record<string, unknown>;
  reason?: string;
  createdAt: string;
}
```

All instructor actions must be persisted and included in the session event log.

## 6. Build plan

### Release 0 — Contract and safety foundation

**Goal:** Establish stable contracts without changing the current pilot behavior.

#### Engineering

- Add `SessionPlan`, `SegmentPlan`, break, breakout, output, and Guide action schemas.
- Add runtime-state versioning and migration helpers.
- Introduce a session event log abstraction.
- Separate Guide recommendations from authoritative state mutations.
- Add `GUIDE_ORCHESTRATION_V2` feature flag.
- Add Guide identity/configuration object.
- Add consent/data-use and AI-role fields to session setup.
- Preserve the current fake lab through an adapter.

#### Tests

- Schema valid/invalid fixtures
- State migration tests
- Event append/idempotency tests
- Authorization tests for instructor actions
- Existing session regression suite

#### Exit criteria

- Current sessions behave exactly as before with the flag off.
- A restored DO can recover its itinerary and event cursor.
- Every state change has an auditable event.
- No Guide action can directly advance or mutate authoritative planning state.

### Release 1 — First-class AI identity and welcome

**Goal:** Participants understand the AI instructor before work begins.

#### Product behavior

- Guide introduction on shared screen and phones
- Name, role, capabilities, limitations, and correction mechanism
- Human sponsor introduction
- Recording/transcription explanation
- Visible AI indicator throughout the session
- “Why are we doing this?” explanation for each segment
- Confirm/correct previous-session memory before use

#### Engineering

- `GuideIdentity` and `GuideSessionContext`
- Welcome and consent states in the state machine
- Participant acknowledgement tracking
- Guide contract content supplied by approved configuration
- Persistent identity in all Guide messages

#### Acceptance test

A new participant can explain who the Guide is, what it does, what the human sponsor does, whether it can be corrected, and how their input is used.

### Release 2 — Six-hour session orchestrator

**Goal:** Reliably conduct the whole session arc.

#### Engineering

- Implement explicit state machine: setup, welcome, active, break, reentry, breakout, recovery, closing, complete.
- Implement `SessionClock` with planned, elapsed, remaining, drift, and closing buffer.
- Add break lifecycle, countdown, checkpoint, and reentry.
- Add pacing modes: on track, behind, recovery, closing protection.
- Add compression/extension recommendations.
- Add output status and completion audit.
- Add resume-after-restart behavior.
- Add participant-facing time checks and instructor-facing rationale.

#### Acceptance test

A simulated six-hour session:

- Executes the itinerary in order.
- Takes every scheduled break or records an explicit instructor override.
- Detects 15-, 30-, and 60-minute schedule drift.
- Protects a configurable closing buffer.
- Uses an approved compression plan when behind.
- Resumes after Durable Object restart.
- Cannot silently complete with missing required outputs.

### Release 3 — Instructor console

**Goal:** A human sponsor can supervise the AI without developer tools.

#### Views

- Session overview and timeline
- Current objective and next action
- Clock/drift/break status
- Required outputs and missing fields
- Guide recommendation queue
- Participant connection and submission health
- Parked issues and unresolved disagreements
- Event/audit history

#### Controls

- Start, pause, resume
- Extend/end break
- Accept, edit, dismiss, defer Guide recommendation
- Repeat, skip, or return to segment
- Enter human-led mode
- Broadcast room message
- Park issue
- Mark output complete
- Emergency stop and close session

#### Acceptance test

An instructor can run the complete simulated session, intervene during every major state, recover from a stuck segment, and explain every Guide recommendation.

### Release 4 — Breakout orchestration

**Goal:** Run structured small-group work and return it safely to the main room.

#### Engineering

- Participant roster and group assignment
- Manual reassignment
- Group-specific instruction packets
- Role assignment
- Group timer and progress status
- Required response form
- Stuck/escalation path
- Report-back queue
- Cross-group comparison
- Agreement/conflict/unique-insight classification
- Instructor acceptance before canonical plan update

#### Acceptance test

- Six to twelve participants can be assigned to groups.
- Every group sees a purpose, prompt, roles, timer, and done criteria.
- Missing or late groups are visible and recoverable.
- Conflicting responses are preserved.
- The instructor chooses what enters the canonical plan.

### Release 5 — Recovery, safety, and degraded operation

**Goal:** Keep the room productive and safe during disruptions.

#### Scenarios

- LLM unavailable
- Network outage
- Participant disconnect
- Screen disconnect
- Breakout group returns empty
- Circular discussion
- Sensitive/pastoral issue
- Participant challenges Guide summary
- Required output incomplete near closing

#### Engineering

- Pre-authored fallback prompts from curriculum
- Offline cached next activity
- Manual facilitation mode
- Human intervention request
- Issue parking
- Resume from checkpoint
- Explicit uncertainty and correction flow
- Sensitive-topic handoff

#### Acceptance test

Every listed scenario has a deterministic recovery path that preserves work and never forces the Guide to invent content or consensus.

### Release 6 — Voice-ready instructor

**Goal:** Make the AI instructor feel present without making voice a dependency.

#### Engineering

- Text-to-speech action channel
- Captions synchronized with spoken output
- Replay, pause, speed controls
- Interruptible speech
- Text-only fallback
- Audio health state
- Accessibility preferences

#### Acceptance test

The Guide can conduct all instructional transitions by voice while every action remains visible and usable through text.

### Release 7 — Confirmed multi-session memory

**Goal:** Continue a program across sessions without inventing history.

#### Engineering

- Confirmed decision records
- Open questions and parked issues
- Prior output references
- Change log between sessions
- Start-of-session memory review
- Participant/instructor correction workflow
- Retention and deletion controls

#### Acceptance test

The next session presents only confirmed prior work as fact, clearly labels uncertain or unresolved items, and records corrections before continuing.

### Release 8 — Adaptive facilitation and pilot learning

**Goal:** Improve facilitation using evidence from real sessions.

#### Engineering

- Observable participation signals
- Repetition/loop detection
- Silence and response-latency signals
- Adaptive prompt selection within curriculum bounds
- Pilot analytics
- Prompt/rubric evaluation harness
- Cost and latency instrumentation

#### Guardrails

- No personality or emotional diagnosis
- No hidden participant ranking
- No automatic sensitive inference
- No autonomous authority escalation

#### Acceptance criteria

Pilot evidence demonstrates improved specificity, fewer repetitive interventions, lower instructor burden, preserved disagreement, and no unacceptable doctrinal or privacy failures.

## 7. Suggested six-hour reference itinerary

This is a technical test fixture only until approved curriculum exists:

| Time | Activity | Required system behavior |
|---|---|---|
| 00:00–00:20 | Welcome and orientation | Guide identity, consent, role contract, technology check |
| 00:20–01:05 | Individual reflection and sharing | Silent-write support, submissions, targeted probes |
| 01:05–01:50 | Whole-group mapping | Evaluation, clarification, output confirmation |
| 01:50–02:05 | Break | Countdown, checkpoint, protected minimum break |
| 02:05–02:50 | Breakout 1 | Group assignment, prompt packet, timer, required output |
| 02:50–03:20 | Report-back and synthesis | Preserve differences, confirm shared themes |
| 03:20–03:35 | Break | Checkpoint and reentry |
| 03:35–04:20 | Prioritization | Vote/decision state, dissent capture |
| 04:20–05:00 | Breakout 2 | Initiative/ownership packet, group progress |
| 05:00–05:15 | Break | Closing-buffer protection begins |
| 05:15–05:45 | Consolidation and challenge review | Output audit, missing owners, unresolved issues |
| 05:45–06:00 | Commitments and close | Confirmed actions, owners, next review, export |

## 8. Testing strategy

### Unit and property tests

- State transition legality
- Clock arithmetic and drift
- Break minimums and closing protection
- Compression plan selection
- Breakout assignment invariants
- Output completion rules
- Instructor authorization
- Event idempotency
- Checkpoint restoration
- Guide action schema validation

### Scenario simulations

Create deterministic session simulations for:

1. Cooperative on-time group
2. Group 30 minutes behind
3. Group 60 minutes behind
4. Silent group
5. Dominant speaker pattern
6. Conflicting breakout outputs
7. Missing participant
8. LLM outage
9. Network loss during report-back
10. DO restart during a break
11. Instructor skips a segment
12. Instructor extends a break
13. Sensitive-topic handoff
14. Incomplete required output at closing

### Human pilot scorecard

- Did participants understand that the instructor was AI?
- Did they understand how to correct it?
- Did scheduled breaks occur?
- Did the session finish with a protected close?
- Were instructions clear without human translation?
- Were breakout tasks completed?
- Were summaries accurate and provenance-linked?
- Did the Guide preserve disagreement?
- How often did the instructor intervene?
- Were interventions easy to understand?
- Did participants leave with clear next actions?
- Did the Guide make any inappropriate doctrinal, pastoral, or authority claims?

## 9. Delivery sequence and ownership

### Engineering tracks

- **Runtime track:** state machine, clock, persistence, events, recovery
- **Guide track:** identity, typed actions, orchestration, prompts, memory
- **Collaboration track:** breakouts, roster, report-back, conflict preservation
- **Instructor UX track:** console, controls, audit, accessibility
- **Reliability track:** offline behavior, model failure, observability, load tests
- **Data/security track:** consent, retention, authorization, redaction, deletion

### Cross-functional gates

- Curriculum schema review before runtime integration
- Human authority and safeguarding review before pilot
- IP firewall review before curriculum content lands
- Security review before instructor controls ship
- Real-device rehearsal before six-hour pilot
- Facilitator acceptance before claiming the AI can lead independently

## 10. Milestone definition of done

The product is ready for a supervised six-hour pilot only when:

- A reviewed curriculum pack exists.
- The Guide introduces itself and explains its boundaries.
- A human sponsor can pause and override it.
- The complete itinerary is durable and recoverable.
- Breaks and re-entry work.
- At least one structured breakout works end to end.
- Required outputs and closing commitments are audited.
- LLM/network failure has a usable fallback.
- Real device rehearsal passes.
- The human sponsor signs off on Guide language and escalation behavior.

The product is ready to claim that the AI can lead the program only after supervised pilots show that the Guide can perform those responsibilities reliably. The claim should be earned by observed behavior, not inferred from model quality or passing unit tests.
