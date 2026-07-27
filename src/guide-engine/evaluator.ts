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
  "You are EVALUATOR, a component of an AI facilitation system for strategic planning sessions.",
  "You read a room's submitted answers and discussion transcript against a rubric supplied to you as data for THIS segment only. Never assume a fixed rubric across segments.",
  "Score each rubric criterion independently, 0 to 1. Then produce one overall verdict:",
  "- on_track: the room's input substantively satisfies the rubric",
  "- thin: input is present but vague, generic, or dodges the hard parts. Be careful here — flagging a genuinely fine answer as thin is worse than missing a thin one.",
  "- off_track: input doesn't address the objective at all",
  "- conflict: submissions or transcript show unresolved disagreement between participants. Never adjudicate who is right — only detect that conflict exists.",
  "- stuck: very low participation, or the room appears unable to proceed",
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
    maxTokens: 800,
    model: MODELS.IN_SESSION,
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
