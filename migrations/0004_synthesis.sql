-- Phase 5 addition: plan artifacts for the fake-lab test sessions used in
-- Phases 1-5. Parallels session_checkpoint/session_audio_chunk rather than
-- forcing the real plan_artifact table's program_id FK, which no real
-- program row satisfies until Phase 6.
CREATE TABLE session_plan_artifact (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purpose','vision','value','strategy','assumption','risk','driver')),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT REFERENCES session_plan_artifact(id),
  provenance_json TEXT NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_plan_artifact_session ON session_plan_artifact(session_id);
CREATE INDEX idx_session_plan_artifact_kind ON session_plan_artifact(session_id, kind);
