import type { SegmentSpec } from "./segment-schema.ts";
import type { LlmClient } from "./llm-client.ts";
import { MODELS } from "./models.ts";

// PACER — build plan §5.3. Deterministic in the common case; the ONLY LLM
// call this agent ever makes is to decide *what* to cut when a segment is
// over time and the session budget is tight. Runs every 30s in production.

export interface PacerInput {
  segment: SegmentSpec;
  elapsedSegmentMin: number;
  remainingSessionBudgetMin: number;
  submissionCount: number;
  exitCriteriaStatus: Record<string, boolean>;
}

export type PacerAction = "continue" | "warn" | "compress" | "extend" | "advance";

export interface PacerDecision {
  action: PacerAction;
  rationale: string;
  message_to_room?: string;
}

const WARN_THRESHOLD = 0.8; // fraction of planned time before PACER warns
const OVERRUN_THRESHOLD = 1.3; // fraction of planned time before force-advance

function allExitCriteriaMet(segment: SegmentSpec, status: Record<string, boolean>): boolean {
  return segment.exit_criteria.every((c) => status[c] === true);
}

/** Pure, deterministic — no LLM call. This is the common-case path. */
export function decidePacerAction(input: PacerInput): PacerDecision {
  const { segment, elapsedSegmentMin, remainingSessionBudgetMin, submissionCount } = input;
  const planned = segment.planned_minutes;
  const minSubs = segment.min_submissions ?? 0;

  if (allExitCriteriaMet(segment, input.exitCriteriaStatus)) {
    return { action: "advance", rationale: "exit criteria satisfied" };
  }

  if (elapsedSegmentMin < planned * WARN_THRESHOLD) {
    return {
      action: "continue",
      rationale: `on pace: ${elapsedSegmentMin}/${planned} min elapsed, exit criteria pending`,
    };
  }

  if (elapsedSegmentMin < planned) {
    return {
      action: "warn",
      rationale: `${Math.round((elapsedSegmentMin / planned) * 100)}% of planned time used, exit criteria not yet met`,
      message_to_room:
        submissionCount < minSubs
          ? `A few more responses needed before we move on — ${submissionCount}/${minSubs} in so far.`
          : "A couple more minutes on this before we move to the next segment.",
    };
  }

  if (elapsedSegmentMin < planned * OVERRUN_THRESHOLD) {
    if (remainingSessionBudgetMin > planned) {
      return {
        action: "extend",
        rationale: "over planned time but session has slack — extending rather than cutting",
      };
    }
    return {
      action: "compress",
      rationale: "over planned time and session budget is tight — needs judgment on what to cut",
    };
  }

  return {
    action: "advance",
    rationale: `${Math.round((elapsedSegmentMin / planned) * 100)}% overrun with session budget tight — moving on regardless of exit criteria`,
    message_to_room: "We need to move to the next segment to protect the rest of the day.",
  };
}

/**
 * Escalation path — the one place PACER calls an LLM. Only invoked after
 * decidePacerAction returns "compress"; a specific recommendation on what
 * to cut requires judgment a threshold check can't provide. Always yields
 * a room-facing message (the parser falls back to a safe default).
 */
export async function escalateCompressDecision(
  input: PacerInput,
  llm: LlmClient,
): Promise<{ action: "compress"; rationale: string; message_to_room: string }> {
  const response = await llm.complete({
    system:
      'You are PACER, a session-timing agent for a strategic planning facilitation tool. Decide what to cut from a discussion that has run over time. Respond with strict JSON only: {"message_to_room": string, "rationale": string}.',
    messages: [{ role: "user", content: buildCompressPrompt(input) }],
    maxTokens: 300,
    model: MODELS.IN_SESSION,
  });
  const parsed = parseCompressResponse(response.text);
  return { action: "compress", rationale: parsed.rationale, message_to_room: parsed.message_to_room };
}

function buildCompressPrompt(input: PacerInput): string {
  return [
    `Segment: "${input.segment.title}" (planned ${input.segment.planned_minutes} min, elapsed ${input.elapsedSegmentMin} min).`,
    `Objective: ${input.segment.objective}`,
    `Submissions so far: ${input.submissionCount} (minimum needed: ${input.segment.min_submissions ?? "none specified"}).`,
    `Remaining session budget: ${input.remainingSessionBudgetMin} minutes.`,
    "The segment is over time and the whole session is tight on budget. Recommend the single best way to compress this segment (narrow scope, skip a sub-step, move to a quick vote) so the room can move on without losing the core objective.",
  ].join("\n");
}

function parseCompressResponse(text: string): { message_to_room: string; rationale: string } {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.message_to_room === "string" && typeof parsed.rationale === "string") {
      return parsed;
    }
  } catch {
    // fall through to the safe default below
  }
  return {
    message_to_room: "Let's tighten this up — one more key point each, then we'll move on.",
    rationale: "LLM response was malformed; used the safe default compression message.",
  };
}
