// WebSocket protocol between clients and SessionDO. Node contract: explicit
// input/output shapes, no free-text — per docs/agent-team.md's topology rules.

export type ClientRole = "screen" | "phone";

export interface SegmentDef {
  key: string;
  title: string;
  plannedMinutes: number;
}

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

export interface SessionState {
  sessionId: string;
  stateVersion: number;
  currentSegmentIndex: number;
  segments: SegmentDef[];
  submissionCounts: Record<string, number>;
  submittedClientUuids: Record<string, string[]>;
  votes: Record<string, Record<string, VoteRecord>>; // segmentKey -> voterUuid -> vote
  startedAt: string;
}

export type ClientToServerMessage =
  | { type: "join"; role: ClientRole; clientId: string }
  | { type: "advance_segment" }
  | { type: "submit"; segmentKey: string; clientUuid: string; content: string }
  | { type: "vote"; segmentKey: string; voterUuid: string; optionId: string; logicalClock: number };

export type ServerToClientMessage =
  | { type: "state"; state: SessionState }
  | { type: "error"; message: string };
