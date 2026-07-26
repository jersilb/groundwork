-- Groundwork initial schema — build plan §4.
-- Timestamps are ISO8601 text (D1/SQLite has no native datetime type).
-- Booleans are INTEGER 0/1.

PRAGMA foreign_keys = ON;

CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('church', 'parachurch', 'nonprofit', 'school')),
  context_pack TEXT NOT NULL DEFAULT 'church',
  annual_budget_band TEXT,
  subscription_tier TEXT,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE user (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('leader', 'member', 'observer')),
  invited_at TEXT,
  last_active_at TEXT
);
CREATE INDEX idx_user_org ON user(org_id);

-- One org's journey through the four labs.
CREATE TABLE program (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization(id),
  status TEXT NOT NULL DEFAULT 'not_started',
  started_at TEXT,
  target_completion TEXT,
  current_lab INTEGER NOT NULL DEFAULT 0,
  renewal_due_at TEXT
);
CREATE INDEX idx_program_org ON program(org_id);

-- One scheduled full day.
CREATE TABLE lab_session (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES program(id),
  lab_number INTEGER NOT NULL CHECK (lab_number BETWEEN 1 AND 4),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  started_at TEXT,
  ended_at TEXT,
  actual_duration_min INTEGER,
  consent_recorded_at TEXT,
  consent_recorded_by TEXT REFERENCES user(id)
);
CREATE INDEX idx_lab_session_program ON lab_session(program_id);

-- One timeboxed block inside a session.
CREATE TABLE segment_run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES lab_session(id),
  segment_key TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  planned_duration_min INTEGER NOT NULL,
  actual_duration_min INTEGER,
  extended_by_leader INTEGER NOT NULL DEFAULT 0,
  exit_criteria_met INTEGER NOT NULL DEFAULT 0,
  guide_notes TEXT
);
CREATE INDEX idx_segment_run_session ON segment_run(session_id);

-- Phone input.
CREATE TABLE submission (
  id TEXT PRIMARY KEY,
  segment_run_id TEXT NOT NULL REFERENCES segment_run(id),
  client_uuid TEXT NOT NULL,
  user_id TEXT REFERENCES user(id),
  content TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  is_anonymous INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_submission_segment_run ON submission(segment_run_id);
CREATE UNIQUE INDEX idx_submission_client_uuid ON submission(segment_run_id, client_uuid);

CREATE TABLE vote (
  id TEXT PRIMARY KEY,
  segment_run_id TEXT NOT NULL REFERENCES segment_run(id),
  submission_id TEXT NOT NULL REFERENCES submission(id),
  user_id TEXT REFERENCES user(id),
  weight REAL NOT NULL DEFAULT 1.0
);
CREATE INDEX idx_vote_segment_run ON vote(segment_run_id);
CREATE INDEX idx_vote_submission ON vote(submission_id);

CREATE TABLE transcript_chunk (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES lab_session(id),
  segment_run_id TEXT REFERENCES segment_run(id),
  sequence INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  text TEXT,
  started_offset_ms INTEGER NOT NULL,
  transcribed_at TEXT
);
CREATE INDEX idx_transcript_chunk_session ON transcript_chunk(session_id);
CREATE UNIQUE INDEX idx_transcript_chunk_sequence ON transcript_chunk(session_id, sequence);

-- Guide's read on a segment's input.
CREATE TABLE evaluation (
  id TEXT PRIMARY KEY,
  segment_run_id TEXT NOT NULL REFERENCES segment_run(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('on_track', 'thin', 'off_track', 'conflict', 'stuck')),
  reasoning TEXT,
  reprompt_issued INTEGER NOT NULL DEFAULT 0,
  leader_feedback_rating INTEGER
);
CREATE INDEX idx_evaluation_segment_run ON evaluation(segment_run_id);

-- The durable outputs.
CREATE TABLE plan_artifact (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES program(id),
  kind TEXT NOT NULL CHECK (kind IN ('purpose', 'vision', 'value', 'strategy', 'assumption', 'risk', 'driver')),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT REFERENCES plan_artifact(id),
  created_in_session_id TEXT REFERENCES lab_session(id),
  approved_at TEXT
);
CREATE INDEX idx_plan_artifact_program ON plan_artifact(program_id);

CREATE TABLE initiative (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES program(id),
  title TEXT NOT NULL,
  why_now TEXT,
  owner_user_id TEXT REFERENCES user(id),
  start_date TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  health TEXT NOT NULL DEFAULT 'green' CHECK (health IN ('green', 'amber', 'red')),
  created_in_session_id TEXT REFERENCES lab_session(id)
);
CREATE INDEX idx_initiative_program ON initiative(program_id);

CREATE TABLE initiative_step (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiative(id),
  description TEXT NOT NULL,
  owner_user_id TEXT REFERENCES user(id),
  due_date TEXT,
  done_at TEXT
);
CREATE INDEX idx_initiative_step_initiative ON initiative_step(initiative_id);

-- The monthly rhythm.
CREATE TABLE review_cycle (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES program(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  completed_at TEXT,
  health_snapshot_json TEXT
);
CREATE INDEX idx_review_cycle_program ON review_cycle(program_id);
