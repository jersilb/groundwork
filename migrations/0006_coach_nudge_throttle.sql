-- COACH nudge throttle — bug #9. The dashboard POSTs
-- /program/:id/coach/nudges on every load, so without persisted state the
-- same overdue step was re-personalized (a real API call) on every refresh.
--
-- One row per step records the last time COACH nudged it. The throttle reads
-- the rows inside the cooldown window (COACH_NUDGE_COOLDOWN_MS in
-- src/program/coach.ts) and suppresses them. Rows are kept, not deleted: the
-- window comparison is what expires a nudge, so the only state needed is the
-- timestamp. Timestamps are ISO8601 text, as everywhere else in this schema.
CREATE TABLE coach_nudge (
  step_id TEXT PRIMARY KEY REFERENCES initiative_step(id),
  program_id TEXT NOT NULL,
  nudged_at TEXT NOT NULL
);
CREATE INDEX idx_coach_nudge_program ON coach_nudge(program_id, nudged_at);
