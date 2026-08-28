// WebSocket protocol between clients and SessionDO. Node contract: explicit
// input/output shapes, no free-text — per docs/agent-team.md's topology rules.

export type ClientRole = "screen" | "phone";

export interface SegmentDef {
  key: string;
  title: string;
  plannedMinutes: number;
}

/** The hardcoded three-segment fake lab used through Phase 1-5 testing
 * (build plan §7 Phase 1: "Segment advance, hardcoded three-segment fake
 * lab. No AI yet."). Real segment specs load from content/packs/ starting
 * Phase 2 — see guide-engine-architect. Lives here so the SessionDO and
 * the program layer (lab_session open → opening segment_run) share one
 * definition. */
export const FAKE_LAB_SEGMENTS: SegmentDef[] = [
  { key: "welcome", title: "Welcome", plannedMinutes: 2 },
  { key: "warmup", title: "Warm-up question", plannedMinutes: 3 },
  { key: "wrapup", title: "Wrap-up", plannedMinutes: 2 },
];

/** A single voter's current vote for a segment. `logicalClock` is a
 * client-incrementing counter, not wall-clock time — build plan §3.3:
 * "last-write-wins is wrong here; use per-field vector timestamps." A
 * vote reconciles by logicalClock, not by arrival order or timestamp,
 * so replaying a queued offline vote after reconnect can't clobber a
 * newer vote the same voter cast on another device. */
export interface VoteRecord {
  optionId: string;
  logicalClock: number;
}

/** One participant submission as tracked by the server. Content is stored
 * (not just counted) so the shared screen can display it and so
 * leader_override can replace it — §5.5 "Leader override is absolute." */
export interface SubmissionRecord {
  content: string;
}

export interface SessionState {
  sessionId: string;
  stateVersion: number;
  currentSegmentIndex: number;
  segments: SegmentDef[];
  submissionCounts: Record<string, number>;
  submittedClientUuids: Record<string, string[]>;
  /** segmentKey -> clientUuid -> submission. Mirrors submittedClientUuids
   * (same key set); kept as its own map so a leader override can rewrite
   * content without touching the dedup index. */
  submissions: Record<string, Record<string, SubmissionRecord>>;
  votes: Record<string, Record<string, VoteRecord>>; // segmentKey -> voterUuid -> vote
  startedAt: string;
  /** ISO timestamp of when the current segment started — PACER's input.
   * Optional so pre-guide checkpoints (which lack it) still restore; the
   * restore path defaults it to the checkpoint time. */
  segmentStartedAt?: string;
  /** Guide Engine messages addressed to the room, oldest last, capped.
   * Rides the normal state broadcast so rejoins see full history. */
  guideLog?: GuideMessage[];
}

/** Protocol input limits. Rooms are 6-12 people; these caps exist to stop a
 * misbehaving client from growing the in-memory state, every future
 * broadcast, and the D1 checkpoint without bound — not to constrain real
 * facilitation (a 2,000-char answer is already an essay). */
export const MAX_SUBMISSION_CHARS = 2000;
export const MAX_VOTE_OPTION_CHARS = 200;
export const MAX_SUBMISSIONS_PER_SEGMENT = 100;
export const MAX_GUIDE_LOG_ENTRIES = 25;

/** A Guide Engine message addressed to the room. Emitted by PACER (pacing
 * recommendations — never a forced advance; §5.5 keeps the leader
 * absolute), EVALUATOR/PROBER (follow-up questions when input runs thin),
 * and SYNTHESIZER (segment-boundary draft summaries). Guide messages ride
 * inside the normal state broadcast as `guideLog` so a rejoining client
 * sees the full history — no separate replay transport needed. */
export type GuideMessageKind = "pacer" | "probe" | "synthesis" | "evaluator";

export interface GuideMessage {
  id: string;
  kind: GuideMessageKind;
  /** What the room sees. Professional facilitator voice, no emoji. */
  text: string;
  /** Machine context: why the guide said this (verdict, overrun %, ...). */
  detail?: string;
  segmentKey: string;
  createdAt: string;
}

/** Leader-only mutation payloads (screen role). §5.5: "Leader override is
 * absolute" — the human in the room can always rewrite a submitted entry
 * or force a vote. This is the server-side contract the UI calls; no
 * conflict-resolution UI is built here. */
export type LeaderOverride =
  | { kind: "submission"; segmentKey: string; clientUuid: string; newContent: string }
  | { kind: "vote"; segmentKey: string; voterUuid: string; optionId: string };

export type ClientToServerMessage =
  | { type: "join"; role: ClientRole; clientId: string }
  | { type: "advance_segment" }
  | { type: "backtrack_segment" }
  | { type: "submit"; segmentKey: string; clientUuid: string; content: string }
  | { type: "vote"; segmentKey: string; voterUuid: string; optionId: string; logicalClock: number }
  | { type: "leader_override"; override: LeaderOverride };

// Every server response is either a full `state` broadcast — all mutations
// fan out the complete SessionState, so a rejoining client receives
// everything it missed and needs no separate resync message — or an
// `error`. No other server message types exist.
export type ServerToClientMessage =
  | { type: "state"; state: SessionState }
  | { type: "error"; message: string };
