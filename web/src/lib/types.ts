// Client-side mirror of the Worker's session protocol
// (src/session-protocol.ts). Keep these in sync with the server types.

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
export type GuideMessageKind = "pacer" | "probe" | "synthesis" | "evaluator";

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
  | { type: "leader_override"; override: LeaderOverride };

// The server responds to every mutation with a full `state` broadcast and
// signals problems with `error` — those two are the only server message
// types, so no resync message type is needed (a rejoin receives the full
// state on connect).
export type ServerToClientMessage =
  | { type: "state"; state: SessionState }
  | { type: "error"; message: string };
