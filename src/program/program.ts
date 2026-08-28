import type { Env } from "../index.ts";
import { FAKE_LAB_SEGMENTS } from "../session-protocol.ts";

// Program and lab sequencing — build plan §6/§7 Phase 6. Phase-gated:
// completing one lab unlocks the next, matching "Phase-gated workflow
// where completing one stage unlocks the next" from the BuildTrack
// reference pattern (§1).

export class LabSequenceError extends Error {}

export async function createProgram(env: Env, orgId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO program (id, org_id, status, current_lab) VALUES (?1, ?2, 'not_started', 0)`,
  )
    .bind(id, orgId)
    .run();
  return id;
}

interface ProgramRow {
  id: string;
  current_lab: number;
  status: string;
}

async function getProgram(env: Env, programId: string): Promise<ProgramRow | null> {
  const row = await env.DB.prepare(`SELECT id, current_lab, status FROM program WHERE id = ?1`)
    .bind(programId)
    .first<ProgramRow>();
  return row ?? null;
}

/** Only the next lab in sequence can be scheduled — this is the phase gate. */
export async function scheduleLabSession(
  env: Env,
  programId: string,
  labNumber: number,
  scheduledFor: string,
): Promise<string> {
  const program = await getProgram(env, programId);
  if (!program) throw new LabSequenceError(`program ${programId} not found`);
  if (labNumber !== program.current_lab + 1) {
    throw new LabSequenceError(
      `cannot schedule lab ${labNumber} — program is at lab ${program.current_lab}; only lab ${program.current_lab + 1} can be scheduled next`,
    );
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO lab_session (id, program_id, lab_number, scheduled_for, status) VALUES (?1, ?2, ?3, ?4, 'scheduled')`,
  )
    .bind(id, programId, labNumber, scheduledFor)
    .run();

  if (program.status === "not_started") {
    await env.DB.prepare(`UPDATE program SET status = 'in_progress', started_at = ?1 WHERE id = ?2`)
      .bind(new Date().toISOString(), programId)
      .run();
  }

  return id;
}

interface LabSessionRow {
  id: string;
  program_id: string;
  lab_number: number;
  status: string;
}

/** Completing a lab session advances the program's current_lab — the
 * unlock step. Real program status flips to 'completed' after lab 4. */
export async function completeLabSession(env: Env, labSessionId: string): Promise<void> {
  const session = await env.DB.prepare(`SELECT id, program_id, lab_number, status FROM lab_session WHERE id = ?1`)
    .bind(labSessionId)
    .first<LabSessionRow>();
  if (!session) throw new LabSequenceError(`lab_session ${labSessionId} not found`);

  await env.DB.prepare(
    `UPDATE lab_session SET status = 'completed', ended_at = ?1 WHERE id = ?2`,
  )
    .bind(new Date().toISOString(), labSessionId)
    .run();

  const program = await getProgram(env, session.program_id);
  if (program && session.lab_number === program.current_lab + 1) {
    const newStatus = session.lab_number === 4 ? "completed" : "in_progress";
    await env.DB.prepare(`UPDATE program SET current_lab = ?1, status = ?2 WHERE id = ?3`)
      .bind(session.lab_number, newStatus, session.program_id)
      .run();
  }
}

export interface OpenLabSessionResult {
  sessionKey: string;
  connectPath: string;
  /** Leader-only secret presented by the shared screen on the WebSocket
   * upgrade (SessionDO validates it for screen-role connections). Minted
   * on first open and returned on every authorized open — the caller
   * already proved org leadership, so re-delivering the current token is
   * what lets a leader refresh (or replace) their screen mid-lab. */
  screenToken: string;
}

/**
 * Open a real lab_session as a live room. The session key is derived
 * deterministically from the lab_session id ("lab-<id>") so reopening is
 * idempotent and the key→session mapping needs no extra storage. Records
 * the open on the lab_session row (status → 'started', started_at) and
 * creates the opening segment_run row so live session activity has a real
 * FK target (submission/vote rows). Returns null when the lab_session
 * doesn't exist; throws LabSequenceError when it's already completed (a
 * finished lab cannot be reopened — same phase-gate spirit as scheduling).
 */
export async function openLabSession(env: Env, labSessionId: string): Promise<OpenLabSessionResult | null> {
  const session = await env.DB.prepare(`SELECT id, status, screen_token FROM lab_session WHERE id = ?1`)
    .bind(labSessionId)
    .first<{ id: string; status: string; screen_token: string | null }>();
  if (!session) return null;
  if (session.status === "completed") {
    throw new LabSequenceError(`lab_session ${labSessionId} is completed and cannot be reopened`);
  }

  const sessionKey = `lab-${session.id}`;
  let screenToken = session.screen_token;
  if (session.status !== "started") {
    const now = new Date().toISOString();
    // A fresh token per open: only the leader's screen (which made this
    // authenticated POST) can hold the screen role for this room.
    screenToken = crypto.randomUUID();
    await env.DB.prepare(
      `UPDATE lab_session SET status = 'started', started_at = ?1, screen_token = ?2 WHERE id = ?3`,
    )
      .bind(now, screenToken, labSessionId)
      .run();
    const firstSegment = FAKE_LAB_SEGMENTS[0];
    await env.DB.prepare(
      `INSERT INTO segment_run (id, session_id, segment_key, started_at, planned_duration_min) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(crypto.randomUUID(), labSessionId, firstSegment.key, now, firstSegment.plannedMinutes)
      .run();
  }
  if (!screenToken) {
    // Room started before this token existed (migration gap) — mint one now
    // so the room is reachable by its leader at all.
    screenToken = crypto.randomUUID();
    await env.DB.prepare(`UPDATE lab_session SET screen_token = ?1 WHERE id = ?2`)
      .bind(screenToken, labSessionId)
      .run();
  }
  return { sessionKey, connectPath: `/session/${sessionKey}/connect`, screenToken };
}

export async function recordConsent(env: Env, labSessionId: string, consentedBy: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE lab_session SET consent_recorded_at = ?1, consent_recorded_by = ?2 WHERE id = ?3`,
  )
    .bind(new Date().toISOString(), consentedBy, labSessionId)
    .run();
}

export async function getProgramState(env: Env, programId: string) {
  return getProgram(env, programId);
}
