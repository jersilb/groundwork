// Client-side mirror of the Worker's session protocol
// (src/session-protocol.ts) and session-spine runtime
// (src/session-runtime.ts). Keep these in sync with the server types.

export type ClientRole = "screen" | "phone";

export interface SegmentDef {
  key: string;
  title: string;
  plannedMinutes: number;
}

export interface VoteRecord {
  optionId: string;
  logicalClock: number;
}

export interface SubmissionRecord {
  content: string;
}

/** A Guide Engine message addressed to the room (mirror of the server's
 * session-protocol.ts type). Guide messages ride the normal state
 * broadcast as `guideLog` so a rejoining client sees the full history. */
export type GuideMessageKind = "pacer" | "probe" | "synthesis" | "evaluator" | "announcement" | "time_check" | "intervention";

export interface GuideMessage {
  id: string;
  kind: GuideMessageKind;
  text: string;
  detail?: string;
  segmentKey: string;
  createdAt: string;
}

export interface SessionState {
  sessionId: string;
  stateVersion: number;
  currentSegmentIndex: number;
  segments: SegmentDef[];
  submissionCounts: Record<string, number>;
  submittedClientUuids: Record<string, string[]>;
  /** segmentKey -> clientUuid -> submission. Mirrors submittedClientUuids;
   * content lives here so the shared screen can display it and leader
   * overrides can replace it. */
  submissions: Record<string, Record<string, SubmissionRecord>>;
  votes: Record<string, Record<string, VoteRecord>>; // segmentKey -> voterUuid -> vote
  startedAt: string;
  /** ISO timestamp of when the current segment started (PACER's input). */
  segmentStartedAt?: string;
  /** Guide Engine messages to the room, oldest last, capped server-side. */
  guideLog?: GuideMessage[];
  /** Session-spine runtime — present when the session was opened with
   * SESSION_SPINE=true (mirrors src/session-runtime.ts SpineRuntime). */
  runtime?: SpineRuntime;
}

// ---- Session-spine runtime mirror (src/session-runtime.ts) ----

export type SpinePhase =
  | "setup"
  | "active"
  | "break"
  | "breakout"
  | "reentry"
  | "recovery"
  | "closing"
  | "complete";

export type GuideMode = "ai_led" | "human_led" | "paused";
export type SegmentState = "active" | "complete" | "skipped" | "parked";
export type OutputState = "pending" | "in_progress" | "complete" | "skipped";

export interface OutputStatus {
  key: string;
  segmentKey: string;
  title: string;
  kind: string;
  required: boolean;
  status: OutputState;
  completedAt?: string;
  by?: string;
}

export interface ParkedIssue {
  id: string;
  text: string;
  source: "leader" | "guide" | "participant";
  aboutMessageId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type GuideActionType =
  | "introduce"
  | "announce_segment"
  | "ask_question"
  | "time_check"
  | "announce_break"
  | "launch_breakout"
  | "request_confirmation"
  | "summarize"
  | "recommend_recovery"
  | "request_human_intervention"
  | "pause";

export type GuideAction =
  | { type: "introduce"; text: string }
  | { type: "announce_segment"; segmentKey: string; text: string }
  | { type: "ask_question"; text: string }
  | { type: "time_check"; minutesRemaining: number; text: string }
  | { type: "announce_break"; breakId: string; minutes: number; text: string }
  | { type: "launch_breakout"; breakoutId: string; text: string }
  | { type: "request_confirmation"; outputKeys: string[]; text: string }
  | { type: "summarize"; text: string; provenance: string[] }
  | { type: "recommend_recovery"; strategy: string; reason: string }
  | { type: "request_human_intervention"; reason: string }
  | { type: "pause"; reason: string };

export interface RecommendationEntry {
  id: string;
  action: GuideAction;
  reason: string;
  status: "pending" | "accepted" | "edited" | "dismissed" | "deferred";
  editedText?: string;
  decidedAt?: string;
  decidedBy?: string;
}

export type EventKind =
  | "system"
  | "phase"
  | "segment"
  | "break"
  | "breakout"
  | "output"
  | "recommendation"
  | "override"
  | "guide_message"
  | "feedback";

export interface SessionEvent {
  id: string;
  seq: number;
  at: string;
  kind: EventKind;
  actor: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface SpineRuntime {
  planId: string;
  planVersion: string;
  phase: SpinePhase;
  phaseStartedAt: string;
  guideMode: GuideMode;
  segmentState: SegmentState;
  currentSegmentIndex: number;
  breakState?: {
    breakId: string;
    startedAt: string;
    plannedMinutes: number;
    minimumMinutes: number;
    extraMinutes: number;
  };
  breakoutState?: {
    breakoutId: string;
    startedAt: string;
    durationMinutes: number;
  };
  outputs: OutputStatus[];
  parkedIssues: ParkedIssue[];
  recommendations: RecommendationEntry[];
  events: SessionEvent[];
  segmentActualMinutes: Record<string, number>;
  breakActualMinutes: Record<string, number>;
  lastDriftThresholdAnnounced: number;
  voteCompletedAnnouncedFor: Record<string, true>;
  completedWithMissingOutputs?: boolean;
}

/** Instructor actions over the spine (mirror of src/session-runtime.ts). */
export type SpineAction =
  | { type: "start_session" }
  | { type: "pause_session"; reason?: string }
  | { type: "resume_session" }
  | { type: "advance_segment" }
  | { type: "backtrack_segment" }
  | { type: "skip_segment" }
  | { type: "repeat_segment" }
  | { type: "start_break" }
  | { type: "extend_break"; minutes: number }
  | { type: "end_break"; force?: boolean }
  | { type: "start_breakout" }
  | { type: "end_breakout" }
  | { type: "enter_human_led" }
  | { type: "return_to_ai_led" }
  | { type: "park_issue"; text: string; source: "leader" | "guide" | "participant"; aboutMessageId?: string }
  | { type: "mark_output"; outputKey: string }
  | { type: "decide_recommendation"; recommendationId: string; decision: "accepted" | "edited" | "dismissed" | "deferred"; editedText?: string }
  | { type: "end_session"; force?: boolean };

/** Ephemeral room health attached to state broadcasts (never persisted). */
export interface RoomPresence {
  phones: number;
  screens: number;
}

/** Leader-only mutation payloads (screen role) — server contract for
 * §5.5 "Leader override is absolute". The UI calls these; no
 * conflict-resolution UI is built in this layer. */
export type LeaderOverride =
  | { kind: "submission"; segmentKey: string; clientUuid: string; newContent: string }
  | { kind: "vote"; segmentKey: string; voterUuid: string; optionId: string };

export type ClientToServerMessage =
  | { type: "join"; role: ClientRole; clientId: string }
  | { type: "advance_segment" }
  | { type: "backtrack_segment" }
  | { type: "submit"; segmentKey: string; clientUuid: string; content: string }
  | { type: "vote"; segmentKey: string; voterUuid: string; optionId: string; logicalClock: number }
  | { type: "leader_override"; override: LeaderOverride }
  /** Session-spine instructor action — screen role only (§5.5). `actionId`
   * dedupes one-shot actions across reconnect replays (no double-advance). */
  | { type: "spine_action"; action: SpineAction; actionId?: string }
  /** Participant correction of the Guide — any role, records a parked issue. */
  | { type: "guide_feedback"; aboutMessageId?: string; text: string };

// The server responds to every mutation with a full `state` broadcast and
// signals problems with `error` — those two are the only server message
// types, so no resync message type is needed (a rejoin receives the full
// state on connect).
export type ServerToClientMessage =
  | { type: "state"; state: SessionState; presence?: RoomPresence }
  | { type: "error"; message: string };

/** The session-spine reference plan served by GET /session-plans/reference
 * (mirror of src/session-plan.ts — the console renders the itinerary from
 * it; the DO itself owns the runtime's authoritative copy). */
export interface SessionPlan {
  id: string;
  version: string;
  title: string;
  plannedMinutes: number;
  segments: { key: string; title: string; objective: string; plannedMinutes: number; inputMode: string }[];
  breaks: { id: string; afterSegmentKey: string; plannedMinutes: number; minimumMinutes: number; reentryPrompt: string }[];
  breakouts: {
    id: string;
    title: string;
    purpose: string;
    appliesToSegmentKey: string;
    durationMinutes: number;
    groupStrategy: string;
    roles: string[];
    instructions: string[];
    reportBackMinutes: number;
  }[];
  closing: { bufferMinutes: number; commitmentsRequired: boolean };
}
