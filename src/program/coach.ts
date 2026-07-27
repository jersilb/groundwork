import { z } from "zod";
import type { LlmClient } from "../guide-engine/llm-client.ts";
import { MODELS } from "../guide-engine/models.ts";
import type { OverdueStepRow } from "./initiatives.ts";

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
  return [
    `Initiative: "${step.initiative_title}"`,
    `Overdue step: "${step.description}"`,
    `Due date: ${step.due_date}`,
    `Days overdue: ${daysOverdue}`,
  ].join("\n");
}

/** Template fallback used when no LLM client is available — Tier 1
 * autonomous operation must not go silent just because personalization
 * is unavailable. */
export function fallbackNudge(step: OverdueStepRow, daysOverdue: number): Nudge {
  return {
    message: `"${step.description}" (part of "${step.initiative_title}") was due ${step.due_date} — ${daysOverdue} day(s) overdue.`,
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
