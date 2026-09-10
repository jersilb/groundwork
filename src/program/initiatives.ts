import type { Env } from "../index.ts";
import {
  MAX_INITIATIVE_TITLE_CHARS,
  MAX_STEP_DESCRIPTION_CHARS,
  truncateCharsWithInfo,
  type CappedWrite,
  type TextTruncation,
} from "./text-limits.ts";

// Initiative tracking — build plan §4/§7 Phase 6.

// The write-boundary caps for the text that feeds the COACH nudge prompt
// (src/program/coach.ts) live in ./text-limits.ts together with the
// truncation rule — one source of truth, shared with the web panel
// (web/src/features/org/InitiativesPanel.tsx), which enforces the same cap as
// maxLength and cuts the text it shows optimistically with the same rule.
//   - description 500 chars: one solid paragraph — long enough for a real
//     step, short enough that a prompt built from it is bounded by
//     construction.
//   - title 200 chars: headline length.
// The boundary still caps by truncation rather than rejection — an older
// client or a direct API caller posting a long-but-legitimate step must not
// get an error banner. Every cut is logged once (logTruncation) and reported
// to the caller (addInitiativeStep / createInitiative). Rows from before
// these caps existed are handled separately, on read, by coach.ts.
export { MAX_INITIATIVE_TITLE_CHARS, MAX_STEP_DESCRIPTION_CHARS, truncateChars } from "./text-limits.ts";

/** Greppable prefix for the truncation log, same convention as the guide
 * loop's "[guide-error]" lines: `wrangler tail | grep program-truncation`
 * shows every write the boundary had to cut. */
const TRUNCATION_LOG_PREFIX = "[program-truncation]";

/** One structured line per cut — never more. */
function logTruncation(what: string, cut: TextTruncation, submittedLength: number, ref: string): void {
  console.warn(
    `${TRUNCATION_LOG_PREFIX} ${what} truncated: omitted=${cut.omittedChars} chars, stored=${cut.text.length} of ${submittedLength} (${ref})`,
  );
}

export interface CreateInitiativeBody {
  title: string;
  whyNow?: string;
  ownerUserId?: string;
  startDate?: string;
  dueDate?: string;
  createdInSessionId?: string;
}

export async function createInitiative(env: Env, programId: string, body: CreateInitiativeBody): Promise<CappedWrite> {
  const id = crypto.randomUUID();
  const title = truncateCharsWithInfo(body.title, MAX_INITIATIVE_TITLE_CHARS);
  if (title.truncated) logTruncation("initiative title", title, body.title.length, `initiativeId=${id}`);
  await env.DB.prepare(
    `INSERT INTO initiative (id, program_id, title, why_now, owner_user_id, start_date, due_date, status, health, created_in_session_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'not_started', 'green', ?8)`,
  )
    .bind(id, programId, title.text, body.whyNow ?? null, body.ownerUserId ?? null, body.startDate ?? null, body.dueDate ?? null, body.createdInSessionId ?? null)
    .run();
  return { id, truncated: title.truncated, storedLength: title.text.length, omittedChars: title.omittedChars };
}

export async function addInitiativeStep(
  env: Env,
  initiativeId: string,
  submittedDescription: string,
  ownerUserId?: string,
  dueDate?: string,
): Promise<CappedWrite> {
  const id = crypto.randomUUID();
  const description = truncateCharsWithInfo(submittedDescription, MAX_STEP_DESCRIPTION_CHARS);
  if (description.truncated) {
    logTruncation("initiative step description", description, submittedDescription.length, `initiativeId=${initiativeId}`);
  }
  await env.DB.prepare(
    `INSERT INTO initiative_step (id, initiative_id, description, owner_user_id, due_date) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, initiativeId, description.text, ownerUserId ?? null, dueDate ?? null)
    .run();
  return { id, truncated: description.truncated, storedLength: description.text.length, omittedChars: description.omittedChars };
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
