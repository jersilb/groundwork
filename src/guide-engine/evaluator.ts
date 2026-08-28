import { z } from "zod";
import type { SegmentSpec } from "./segment-schema.ts";
import type { LlmClient } from "./llm-client.ts";
import { MODELS } from "./models.ts";

// EVALUATOR — build plan §5.3. Reads submissions + transcript against the
// segment's rubric. THE RUBRIC IS PASSED IN AS DATA, never baked into the
// system prompt — that is what makes this discriminating instead of generic.

export type EvaluatorVerdict = "on_track" | "thin" | "off_track" | "conflict" | "stuck";

export interface EvaluatorInput {
  segment: SegmentSpec;
  submissions: string[];
  transcriptWindow?: string;
}

export const EvaluatorOutputSchema = z.object({
  verdict: z.enum(["on_track", "thin", "off_track", "conflict", "stuck"]),
  per_criterion_scores: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(1),
      note: z.string(),
    }),
  ),
  weakest_criterion: z.string(),
  evidence: z.string(),
});

export type EvaluatorOutput = z.infer<typeof EvaluatorOutputSchema>;

export class EvaluatorParseError extends Error {}

const EVALUATOR_SYSTEM_PROMPT = [
  "You are EVALUATOR, the room-reading component of an AI facilitation system for strategic planning sessions run by mission-driven organizations (churches, schools, nonprofits). You act as a professional facilitator's instrument: you judge the QUALITY of a room's input against a rubric, never the people.",
  "You read a room's submitted answers and discussion transcript against a rubric supplied to you as data for THIS segment only. Never assume a fixed rubric across segments.",
  "Score each rubric criterion independently, 0 to 1, and produce one overall verdict:",
  "- on_track: the room's input substantively satisfies the rubric. Specificity is your bar: strong answers name real people, dates, numbers, programs, or mechanisms — not sentiments.",
  "- thin: input clearly attempts to engage with the segment's objective, but stays vague, generic, or avoids the hard parts. Corporate-speak, feel-good platitudes, hedges like \"we could improve communication\" with no concrete mechanism, and 'things are fine' answers that are still topically about the right subject are THIN, not off_track. Be careful in both directions: flagging a genuinely fine, specific answer as thin is worse than missing a thin one.",
  "- off_track: input does not engage with the segment's objective/topic at all — it's about something unrelated, even if the unrelated thing is stated specifically. Reserve this for answers that ignore the question, not answers that address it poorly.",
  "- conflict: submissions or transcript show unresolved disagreement between participants — competing priorities, contradicted facts, or visibly opposed positions. Never adjudicate who is right; only detect that conflict exists.",
  "- stuck: very low participation, answers that repeatedly restate the prompt without engaging it, or a room that appears unable to proceed.",
  "Doctrinal neutrality is absolute: if submissions engage theology, doctrine, or scripture, evaluate only whether they are specific and relevant to the objective — and if the segment itself hinges on a contested theological question, say so in `evidence` and recommend the leader take it, rather than ruling on it yourself.",
  "`weakest_criterion` MUST always be one of the rubric ids provided, even when the verdict is on_track — pick whichever criterion scored lowest, never the string \"none\" or anything outside the provided rubric ids.",
  "Keep `evidence` and each `note` to one short, concrete sentence quoting or paraphrasing the actual input — you have a limited output budget and truncated JSON is treated as a failure.",
  'Respond with strict JSON only, no prose: {"verdict": string, "per_criterion_scores": [{"id": string, "score": number, "note": string}], "weakest_criterion": string, "evidence": string}.',
].join("\n");

function buildEvaluatorUserContent(input: EvaluatorInput): string {
  return [
    `Segment objective: ${input.segment.objective}`,
    "Rubric (JSON, authoritative for this segment only):",
    JSON.stringify(input.segment.rubric, null, 2),
    `Submissions (${input.submissions.length}):`,
    input.submissions.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)",
    input.transcriptWindow ? `Discussion transcript (current + prior segment):\n${input.transcriptWindow}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runEvaluator(input: EvaluatorInput, llm: LlmClient): Promise<EvaluatorOutput> {
  const response = await llm.complete({
    system: EVALUATOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildEvaluatorUserContent(input) }],
    maxTokens: 1024,
    model: MODELS.IN_SESSION,
    // NOT setting temperature: claude-sonnet-5 rejects the parameter
    // outright ("temperature is deprecated for this model", HTTP 400).
    // Jeremy approved a temperature: 0 fix on 2026-07-31 for the
    // non-determinism found in docs/decisions.md, 2026-07-28; tried it,
    // found this model doesn't support it, reverted the same day. See
    // docs/decisions.md, 2026-07-31 for the real finding and the
    // alternative mitigation (repeated-run measurement) in place of it.
  });
  return parseEvaluatorResponse(response.text, input.segment);
}

export function parseEvaluatorResponse(text: string, segment: SegmentSpec): EvaluatorOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new EvaluatorParseError(`EVALUATOR returned non-JSON output: ${text.slice(0, 200)}` + String(err ?? ""));
  }
  const result = EvaluatorOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvaluatorParseError(`EVALUATOR output failed schema validation: ${result.error.message}`);
  }
  const validIds = new Set(segment.rubric.map((r) => r.id));
  if (!validIds.has(result.data.weakest_criterion)) {
    throw new EvaluatorParseError(
      `weakest_criterion "${result.data.weakest_criterion}" is not a rubric id in this segment`,
    );
  }
  return result.data;
}

// Severity ranking used by repeated-run measurement: a higher number is
// a "worse" verdict. The ranking is intentionally conservative — a single
// off_track or stuck across runs pulls the aggregate toward that outcome.
const VERDICT_SEVERITY: Record<EvaluatorVerdict, number> = {
  on_track: 1,
  thin: 2,
  conflict: 3,
  stuck: 4,
  off_track: 5,
};

/**
 * Run EVALUATOR multiple times against the same input and return the
 * worst verdict observed. This is the alternative mitigation for the
 * claude-sonnet-5 non-determinism documented in docs/decisions.md: the
 * model rejects temperature=0, so we measure variance honestly rather than
 * hide it behind a single run.
 *
 * The full per-run outputs are returned so callers can log or inspect
 * them; the aggregate is the verdict with the highest severity rank. Ties
 * are broken by frequency.
 */
export async function runEvaluatorRepeated(
  input: EvaluatorInput,
  llm: LlmClient,
  runs: number = 5,
): Promise<{ aggregate: EvaluatorOutput; runs: EvaluatorOutput[] }> {
  if (runs < 1) runs = 1;
  const runOutputs: EvaluatorOutput[] = [];
  for (let i = 0; i < runs; i++) {
    runOutputs.push(await runEvaluator(input, llm));
  }

  // Pick worst verdict by severity.
  let worst = runOutputs[0];
  for (const output of runOutputs) {
    if (VERDICT_SEVERITY[output.verdict] > VERDICT_SEVERITY[worst.verdict]) {
      worst = output;
    }
  }

  return { aggregate: worst, runs: runOutputs };
}
