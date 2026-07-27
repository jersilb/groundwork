import type { Env } from "../index.ts";

// Initiative tracking — build plan §4/§7 Phase 6.

export interface CreateInitiativeBody {
  title: string;
  whyNow?: string;
  ownerUserId?: string;
  startDate?: string;
  dueDate?: string;
  createdInSessionId?: string;
}

export async function createInitiative(env: Env, programId: string, body: CreateInitiativeBody): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO initiative (id, program_id, title, why_now, owner_user_id, start_date, due_date, status, health, created_in_session_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'not_started', 'green', ?8)`,
  )
    .bind(id, programId, body.title, body.whyNow ?? null, body.ownerUserId ?? null, body.startDate ?? null, body.dueDate ?? null, body.createdInSessionId ?? null)
    .run();
  return id;
}

export async function addInitiativeStep(
  env: Env,
  initiativeId: string,
  description: string,
  ownerUserId?: string,
  dueDate?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO initiative_step (id, initiative_id, description, owner_user_id, due_date) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, initiativeId, description, ownerUserId ?? null, dueDate ?? null)
    .run();
  return id;
}

export interface OverdueStepRow {
  step_id: string;
  description: string;
  due_date: string;
  initiative_id: string;
  initiative_title: string;
  owner_user_id: string | null;
}

/** COACH's deterministic input — build plan §5.3: "Owns nudges on overdue
 * initiative steps." No LLM needed to find what's overdue; only the
 * message wording is where personalization (and a real API call) comes in. */
export async function getOverdueSteps(env: Env, programId: string, asOf: string = new Date().toISOString()): Promise<OverdueStepRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       s.id AS step_id, s.description, s.due_date,
       i.id AS initiative_id, i.title AS initiative_title, s.owner_user_id
     FROM initiative_step s
     JOIN initiative i ON i.id = s.initiative_id
     WHERE i.program_id = ?1 AND s.done_at IS NULL AND s.due_date IS NOT NULL AND s.due_date < ?2
     ORDER BY s.due_date ASC`,
  )
    .bind(programId, asOf)
    .all<OverdueStepRow>();
  return results;
}
