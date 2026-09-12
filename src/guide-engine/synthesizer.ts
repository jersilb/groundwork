import { z } from "zod";
import type { SegmentSpec } from "./segment-schema.ts";
import type { LlmClient } from "./llm-client.ts";
import { MODELS } from "./models.ts";
import { applyPromptBudget, renderPromptSubmissions, stripPromptTruncationMarker } from "../session-protocol.ts";

// SYNTHESIZER — build plan §5.3. Runs at segment boundaries and end of
// session. Uses Opus, not Sonnet — this output goes in front of a board.
// "Provenance is a feature, not debug tooling": every artifact line must
// link back to a real submission or transcript moment, and this module
// VERIFIES that link is real (the quote actually appears in the claimed
// source) rather than trusting the model's citation. A fabricated
// provenance quote is treated as a hard failure, not a warning — an
// artifact that lies about its own sourcing is worse than one with none.

export const ArtifactKindSchema = z.enum([
  "purpose",
  "vision",
  "value",
  "strategy",
  "assumption",
  "risk",
  "driver",
]);

export const SourceRefSchema = z.object({
  type: z.enum(["submission", "transcript"]),
  index: z.number().int().nonnegative(),
  quote: z.string().min(1),
});

export const DraftArtifactSchema = z.object({
  kind: ArtifactKindSchema,
  content: z.string().min(1),
  provenance: z.array(SourceRefSchema).min(1),
});

export const SynthesizerOutputSchema = z.object({
  artifacts: z.array(DraftArtifactSchema),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type DraftArtifact = z.infer<typeof DraftArtifactSchema>;
export type SynthesizerOutput = z.infer<typeof SynthesizerOutputSchema>;

export interface SynthesizerInput {
  segment: SegmentSpec;
  submissions: string[];
  transcriptWindow?: string;
}

export class SynthesizerParseError extends Error {}
export class ProvenanceVerificationError extends Error {}

const SYNTHESIZER_SYSTEM_PROMPT = [
  "You are SYNTHESIZER, part of an AI facilitation system for strategic planning sessions. You turn a room's raw input into draft plan artifacts a board will read.",
  "Every artifact has a `kind`, which MUST be exactly one of: purpose, vision, value, strategy, assumption, risk, driver. This is a fixed structural category, NOT the segment's own curriculum-specific artifact name (which is provided separately, for context only, and must never be used as `kind`).",
  "Every artifact must cite the specific submissions or transcript text it draws from. A provenance quote MUST be an exact, verbatim substring of the submission or transcript text you are citing — not a paraphrase, not a summary. If you cannot quote something verbatim to support a line, do not include that line.",
  "Submissions are indexed starting at 0, in the order given. Transcript citations use index 0 and quote a verbatim substring of the transcript window.",
  "Drafting standard: write for a board member who missed the meeting. Every line must be concrete enough to act on or decide from — no corporate filler (\"leverage\", \"synergy\", \"streamline\"), no hedging, no unfalsifiable aspirations. A reader should be able to tell from the sentence alone what was actually said in the room.",
  "Do not invent content that isn't grounded in the actual input. Fewer, well-sourced, CONCISE artifacts beat more, thinly-sourced or verbose ones — keep each artifact's content to 1-2 sentences. You have a limited output budget; truncated JSON is treated as a failure.",
  "If the input is theological or doctrinal in nature, report what was said without endorsement or critique — draft artifacts describe the room's input, they never take a theological position.",
  'Respond with strict JSON only, no prose: {"artifacts": [{"kind": "purpose"|"vision"|"value"|"strategy"|"assumption"|"risk"|"driver", "content": string, "provenance": [{"type": "submission"|"transcript", "index": number, "quote": string}]}]}.',
].join("\n");

export function buildUserContent(input: SynthesizerInput): string {
  return applyPromptBudget({
    submissions: input.submissions,
    transcript: input.transcriptWindow,
    render: ({ submissions, transcript, submissionsElided }) => {
      const heading =
        submissionsElided > 0
          ? `Submissions (index: text; newest ${submissions.length} of ${submissions.length + submissionsElided} shown, original indices preserved):`
          : "Submissions (index: text):";
      return [
        `Segment objective: ${input.segment.objective}`,
        `This segment's curriculum-specific output concept (context only, NOT a valid "kind" value): ${input.segment.produces.map((p) => p.artifact).join(", ")}`,
        renderPromptSubmissions(heading, submissions, submissionsElided, (entry) => `[${entry.index}] ${entry.text}`),
        transcript ? `Transcript window (index 0):\n[0] ${transcript}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  }).content;
}

export async function runSynthesizer(input: SynthesizerInput, llm: LlmClient): Promise<SynthesizerOutput> {
  const response = await llm.complete({
    system: SYNTHESIZER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent(input) }],
    maxTokens: 2048,
    model: MODELS.SYNTHESIS,
  });
  const parsed = parseSynthesizerResponse(response.text);
  const issues = verifyProvenance(parsed, input);
  if (issues.length > 0) {
    throw new ProvenanceVerificationError(`Fabricated or invalid provenance:\n${issues.join("\n")}`);
  }
  return parsed;
}

export function parseSynthesizerResponse(text: string): SynthesizerOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SynthesizerParseError(`SYNTHESIZER returned non-JSON output: ${text.slice(0, 200)}` + String(err ?? ""));
  }
  const result = SynthesizerOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new SynthesizerParseError(`SYNTHESIZER output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/** Returns a list of human-readable issues; empty means every provenance
 * quote genuinely appears in its claimed source. This is the check that
 * makes provenance a real feature instead of a field the model can fill
 * with anything plausible-sounding.
 *
 * The transcript source is verified marker-free: the prompt-budget layer's
 * truncation marker is system boilerplate and must never satisfy a citation
 * (guide-hardening wave 1.1 — the reviewer verified an artifact quoting
 * nothing but the marker). Stripping rather than rejecting marker wording
 * keeps genuine quotes valid and makes the alarm path's capped window and
 * the manual route's raw window verify identically. */
export function verifyProvenance(output: SynthesizerOutput, input: SynthesizerInput): string[] {
  const issues: string[] = [];
  const transcriptSource = input.transcriptWindow ? stripPromptTruncationMarker(input.transcriptWindow) : undefined;
  for (const artifact of output.artifacts) {
    for (const ref of artifact.provenance) {
      if (ref.type === "submission") {
        const source = input.submissions[ref.index];
        if (source === undefined) {
          issues.push(`artifact "${artifact.kind}": submission index ${ref.index} out of range (0-${input.submissions.length - 1})`);
        } else if (!source.includes(ref.quote)) {
          issues.push(`artifact "${artifact.kind}": quote "${ref.quote}" not found verbatim in submission[${ref.index}]`);
        }
      } else {
        if (!transcriptSource || !transcriptSource.includes(ref.quote)) {
          issues.push(`artifact "${artifact.kind}": quote "${ref.quote}" not found verbatim in the transcript window`);
        }
      }
    }
  }
  return issues;
}
