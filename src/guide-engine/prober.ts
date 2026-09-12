import { z } from "zod";
import type { SegmentSpec } from "./segment-schema.ts";
import type { EvaluatorOutput } from "./evaluator.ts";
import type { LlmClient } from "./llm-client.ts";
import { MODELS } from "./models.ts";
import { applyPromptBudget, renderPromptSubmissions } from "../session-protocol.ts";

// PROBER — build plan §5.3. Generates the re-prompt when EVALUATOR returns
// `thin` or `off_track`. Constraint: the probe must be specific to what the
// room actually said. "Can you be more specific?" is a failure by design.

export interface ProberInput {
  segment: SegmentSpec;
  evaluatorOutput: EvaluatorOutput;
  submissions: string[];
}

export const ProberOutputSchema = z.object({
  probe: z.string().min(1),
  reason: z.string().min(1),
});

export type ProberOutput = z.infer<typeof ProberOutputSchema>;

export class ProberParseError extends Error {}

const PROBER_SYSTEM_PROMPT = [
  "You are PROBER, the follow-up question writer inside a professional AI facilitation system for strategic planning sessions run by mission-driven organizations (churches, schools, nonprofits). Your only job: write ONE follow-up question that pushes a room past a vague or thin answer.",
  "Rules for the probe:",
  '1. It MUST reference something specific the room actually said — quote a phrase or concretely paraphrase one submission. A generic question like "Can you be more specific?" is a failure by design.',
  "2. It must be answerable in one or two sentences from the room — aim it at the missing specificity, not at new topics.",
  "3. Two sentences maximum, warm but direct, no jargon, no filler openers (\"That's a great point, but...\" is a failure).",
  "4. Doctrinal neutrality: never frame the probe around theology or scripture; ask about concrete people, decisions, dates, or mechanisms.",
  'Respond with strict JSON only, no prose: {"probe": string, "reason": string}.',
].join("\n");

export function buildProberUserContent(input: ProberInput): string {
  const weakest = input.segment.rubric.find((r) => r.id === input.evaluatorOutput.weakest_criterion);
  return applyPromptBudget({
    submissions: input.submissions,
    render: ({ submissions, submissionsElided }) => {
      const heading =
        submissionsElided > 0
          ? `What the room actually said (${submissions.length} of ${submissions.length + submissionsElided} submissions, newest kept):`
          : `What the room actually said (${submissions.length} submissions):`;
      return [
        `Segment objective: ${input.segment.objective}`,
        `Weakest rubric criterion: ${weakest?.id ?? input.evaluatorOutput.weakest_criterion} — ${weakest?.check ?? ""}`,
        `Evaluator's evidence: ${input.evaluatorOutput.evidence}`,
        renderPromptSubmissions(heading, submissions, submissionsElided, (entry, position) => `${position + 1}. ${entry.text}`),
        "Write one probe question that names something specific from the submissions above.",
      ].join("\n\n");
    },
  }).content;
}

export async function runProber(input: ProberInput, llm: LlmClient): Promise<ProberOutput> {
  const response = await llm.complete({
    system: PROBER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildProberUserContent(input) }],
    maxTokens: 300,
    model: MODELS.IN_SESSION,
  });
  return parseProberResponse(response.text);
}

export function parseProberResponse(text: string): ProberOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProberParseError(`PROBER returned non-JSON output: ${text.slice(0, 200)}` + String(err ?? ""));
  }
  const result = ProberOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProberParseError(`PROBER output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}
