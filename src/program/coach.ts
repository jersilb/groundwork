import { z } from "zod";
import type { Env } from "../index.ts";
import { AnthropicLlmClient, type LlmClient } from "../guide-engine/llm-client.ts";
import { MODELS } from "../guide-engine/models.ts";
import { getOverdueSteps, MAX_INITIATIVE_TITLE_CHARS, MAX_STEP_DESCRIPTION_CHARS, truncateChars, type OverdueStepRow } from "./initiatives.ts";

// COACH — build plan §5.3: "the between-session agent... nudges on overdue
// initiative steps." Runs on schedule, not in-session — decoupled from
// PACER/EVALUATOR/PROBER's live-session runtime entirely.
//
// "Routine content generation within approved templates" is Tier 1
// (AI_CEO_INSTRUCTIONS.md §4) — autonomous. The design here matches that:
// a fixed template structure, personalized only with the specific overdue
// facts given, never free-form generation. A new template shape would be
// Tier 2.

export const NudgeSchema = z.object({
  message: z.string().min(1),
});

export type Nudge = z.infer<typeof NudgeSchema>;

export class NudgeParseError extends Error {}

const NUDGE_SYSTEM_PROMPT = [
  "You are COACH, the between-session component of a strategic planning facilitation system. Your only job here: personalize a nudge about an overdue initiative step.",
  "Use ONLY the facts given below. Do not invent context, do not speculate about why it's late, do not add generic encouragement beyond one brief, direct sentence.",
  "Tone: direct, respectful, brief. Not scolding, not effusive.",
  'Respond with strict JSON only, no prose: {"message": string}.',
].join("\n");

function buildNudgePrompt(step: OverdueStepRow, daysOverdue: number): string {
  // Read-side caps, not validation: a row stored before the write boundary
  // (initiatives.ts) gained its limits can be arbitrarily long, and the
  // prompt is the one path in the repo with no applyPromptBudget. The fields
  // are cut individually so the model still sees all four facts; the final
  // slice is the hard ceiling that holds even if a field or a cap changes.
  const prompt = [
    `Initiative: "${truncateChars(step.initiative_title, MAX_INITIATIVE_TITLE_CHARS)}"`,
    `Overdue step: "${truncateChars(step.description, MAX_STEP_DESCRIPTION_CHARS)}"`,
    `Due date: ${step.due_date}`,
    `Days overdue: ${daysOverdue}`,
  ].join("\n");
  return truncateChars(prompt, MAX_NUDGE_PROMPT_CHARS);
}

/** Template fallback used when no LLM client is available — Tier 1
 * autonomous operation must not go silent just because personalization
 * is unavailable. Reads the same stored fields as the prompt, so it carries
 * the same read-side caps: a legacy oversized row must not produce an
 * oversized dashboard message either. */
export function fallbackNudge(step: OverdueStepRow, daysOverdue: number): Nudge {
  const description = truncateChars(step.description, MAX_STEP_DESCRIPTION_CHARS);
  const title = truncateChars(step.initiative_title, MAX_INITIATIVE_TITLE_CHARS);
  return {
    message: `"${description}" (part of "${title}") was due ${step.due_date} — ${daysOverdue} day(s) overdue.`,
  };
}

export async function generateNudge(step: OverdueStepRow, llm: LlmClient, asOf: Date = new Date()): Promise<Nudge> {
  const daysOverdue = Math.max(0, Math.floor((asOf.getTime() - new Date(step.due_date).getTime()) / 86_400_000));
  const response = await llm.complete({
    system: NUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildNudgePrompt(step, daysOverdue) }],
    maxTokens: 200,
    model: MODELS.IN_SESSION,
  });
  return parseNudgeResponse(response.text);
}

export function parseNudgeResponse(text: string): Nudge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new NudgeParseError(`COACH returned non-JSON output: ${text.slice(0, 200)}` + String(err ?? ""));
  }
  const result = NudgeSchema.safeParse(parsed);
  if (!result.success) {
    throw new NudgeParseError(`COACH output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Throttle and dedupe — bug #9.
//
// The dashboard calls POST /program/:id/coach/nudges on every load (and on
// its Refresh button). With no persisted state, each load re-personalized
// every overdue step: the same reminder, paid for again, on every refresh.
//
// The window lives in D1, not in the dashboard, so no client can bypass it.
// One nudge per step per cooldown; a step that has never been nudged is not
// affected by the cooldown on any other step.
// ---------------------------------------------------------------------------

/** Recommended default: nudge the same overdue step at most once per day. */
export const COACH_NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Hard character ceiling on the COACH nudge prompt — the one prompt path in
 * the repo that has no other budget (the guide agents go through
 * applyPromptBudget; this one must not). The fields are capped individually so
 * the model still sees all four facts; this ceiling is the backstop that holds
 * even if a field is added or a cap is raised later. Rows stored before the
 * write-boundary caps (initiatives.ts) existed cannot blow past it. */
export const MAX_NUDGE_PROMPT_CHARS = 1000;

/** Persisted nudge history. Small on purpose — the SQL lives in one place and
 * tests can drive the real store instead of standing in for it. */
export interface CoachNudgeStore {
  /** Step ids nudged within the cooldown window that ends at `now`. */
  recentlyNudgedStepIds(programId: string, now: Date): Promise<Set<string>>;
  /** Record a nudge for each step, replacing any earlier row for that step. */
  recordNudges(programId: string, stepIds: readonly string[], at: Date): Promise<void>;
}

/** D1-backed store (migrations/0006_coach_nudge_throttle.sql). Rows are kept
 * rather than deleted: the window comparison is what expires a nudge, so the
 * timestamp of the last nudge is the only state the throttle needs. */
export function createD1CoachNudgeStore(env: Env): CoachNudgeStore {
  return {
    async recentlyNudgedStepIds(programId, now) {
      const cutoff = new Date(now.getTime() - COACH_NUDGE_COOLDOWN_MS).toISOString();
      const { results } = await env.DB.prepare(
        `SELECT step_id FROM coach_nudge WHERE program_id = ?1 AND nudged_at > ?2`,
      )
        .bind(programId, cutoff)
        .all<{ step_id: string }>();
      return new Set(results.map((row) => row.step_id));
    },

    async recordNudges(programId, stepIds, at) {
      const nudgedAt = at.toISOString();
      for (const stepId of stepIds) {
        await env.DB.prepare(
          `INSERT INTO coach_nudge (step_id, program_id, nudged_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(step_id) DO UPDATE SET nudged_at = excluded.nudged_at`,
        )
          .bind(stepId, programId, nudgedAt)
          .run();
      }
    },
  };
}

/** Deploy-order hazard: the Worker can go out before
 * `wrangler d1 migrations apply groundwork` creates coach_nudge. SQLite and
 * D1 both report that as "no such table: coach_nudge". The caller maps this
 * one case to a 503 so a migration lag degrades the endpoint instead of
 * 500-ing every dashboard load. The migration itself stays required. */
export function isMissingCoachNudgeTableError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? ((err as { message: string }).message)
          : "";
  return /no such table:\s*(?:\w+\.)?coach_nudge\b/i.test(message);
}

export interface CoachNudgeItem {
  stepId: string;
  message: string;
}

export interface CoachNudgeResult {
  nudges: CoachNudgeItem[];
  personalized: boolean;
  /** Steps this call suppressed because their last nudge is inside the
   * cooldown. Additive field — the dashboard's existing fields are intact. */
  suppressedCount: number;
}

export interface GenerateNudgesOptions {
  /** Test seam. Production callers omit it and get the Anthropic client when
   * a key is configured, the template otherwise. */
  llm?: LlmClient | null;
  /** Test seam for the store. Production uses the D1 store. */
  store?: CoachNudgeStore;
}

/** The route's COACH call in one place: find the overdue steps, drop the ones
 * still inside the cooldown, nudge the rest, record what went out.
 *
 * Every step that produced a message is recorded — including one that fell
 * back to the template because the LLM call failed. The record is what stops
 * the next dashboard load from paying for the same attempt again. */
export async function generateNudgesForProgram(
  env: Env,
  programId: string,
  options: GenerateNudgesOptions = {},
): Promise<CoachNudgeResult> {
  const steps = await getOverdueSteps(env, programId);
  const store = options.store ?? createD1CoachNudgeStore(env);
  const llm =
    options.llm !== undefined
      ? options.llm
      : env.ANTHROPIC_API_KEY
        ? new AnthropicLlmClient(env.ANTHROPIC_API_KEY)
        : null;

  const now = new Date();
  const recentlyNudged = await store.recentlyNudgedStepIds(programId, now);
  const dueForNudge = steps.filter((step) => !recentlyNudged.has(step.step_id));

  const nudges: CoachNudgeItem[] = [];
  for (const step of dueForNudge) {
    const daysOverdue = Math.max(0, Math.floor((now.getTime() - new Date(step.due_date).getTime()) / 86_400_000));
    // One malformed LLM response must not 500 the whole endpoint —
    // per-step isolation, with the deterministic template as the floor.
    let nudge: Nudge;
    try {
      nudge = llm ? await generateNudge(step, llm, now) : fallbackNudge(step, daysOverdue);
    } catch {
      nudge = fallbackNudge(step, daysOverdue);
    }
    nudges.push({ stepId: step.step_id, message: nudge.message });
  }

  if (nudges.length > 0) {
    await store.recordNudges(
      programId,
      nudges.map((nudge) => nudge.stepId),
      now,
    );
  }

  return {
    nudges,
    personalized: Boolean(llm),
    suppressedCount: steps.length - dueForNudge.length,
  };
}
