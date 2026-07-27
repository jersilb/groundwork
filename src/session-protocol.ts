// WebSocket protocol between clients and SessionDO. Node contract: explicit
// input/output shapes, no free-text — per docs/agent-team.md's topology rules.

export type ClientRole = "screen" | "phone";

export interface SegmentDef {
  key: string;
  title: string;
  plannedMinutes: number;
}

export interface SessionState {
  sessionId: string;
  stateVersion: number;
  currentSegmentIndex: number;
  segments: SegmentDef[];
  submissionCounts: Record<string, number>;
  submittedClientUuids: Record<string, string[]>;
  startedAt: string;
}

export type ClientToServerMessage =
  | { type: "join"; role: ClientRole; clientId: string }
  | { type: "advance_segment" }
  | { type: "submit"; segmentKey: string; clientUuid: string; content: string };

export type ServerToClientMessage =
  | { type: "state"; state: SessionState }
  | { type: "error"; message: string };
