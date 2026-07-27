-- Phase 4 addition: audio consent/kill-switch and chunk tracking for the
-- fake-lab test sessions used in Phases 1-4 (no real org/program/lab_session
-- rows exist yet — that wiring is Phase 6 scope). Parallels the
-- session_checkpoint pattern from migration 0002 rather than forcing FK
-- references the real schema can't satisfy pre-Phase-6.

CREATE TABLE audio_consent (
  session_id TEXT PRIMARY KEY,
  consented_at TEXT,
  consented_by TEXT,
  kill_switch_engaged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_audio_chunk (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  text TEXT,
  started_offset_ms INTEGER NOT NULL,
  transcribed_at TEXT,
  transcription_error TEXT
);
CREATE UNIQUE INDEX idx_session_audio_chunk_sequence ON session_audio_chunk(session_id, sequence);
CREATE INDEX idx_session_audio_chunk_segment ON session_audio_chunk(session_id, segment_key);
