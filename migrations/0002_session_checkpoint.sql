-- Phase 1 addition: generic session-state checkpoint, independent of the
-- org/program tables (those don't get wired to the live session engine
-- until Phase 6). SessionDO upserts this every 30s and at segment
-- boundaries, per build plan §3.2.
CREATE TABLE session_checkpoint (
  session_id TEXT PRIMARY KEY,
  state_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  checkpointed_at TEXT NOT NULL
);
