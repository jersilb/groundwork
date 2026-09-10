import type { SegmentDef, GuideMessage, GuideMessageKind } from "../session-protocol.ts";
import type { SegmentSpec } from "./segment-schema.ts";
import type { DraftArtifact } from "./synthesizer.ts";
import { decidePacerAction, escalateCompressDecision, type PacerInput } from "./pacer.ts";
import { runEvaluator, type EvaluatorOutput } from "./evaluator.ts";
import { runProber } from "./prober.ts";
import { runSynthesizer } from "./synthesizer.ts";
import type { LlmClient } from "./llm-client.ts";
import { MODELS } from "./models.ts";
import { DEMO_SEGMENT_SPECS } from "../generated/demo-segment-specs.ts";

// Demo/reference specs (content/packs/_demo) — synthetic and clearly labeled
// test-lab content the guide can resolve BY KEY so a rehearsal room exercises
// segment-specific objectives and rubrics instead of the generic fallback.
// These are NOT merged into the shipped SEGMENT_SPECS bundle (the compiler
// emits underscore-prefixed packs separately). Always derived-style data; when
// a real pack supplies the key, it is consulted the same way here.
//
// Canonical keys match the spine plan (hyphenated: s2-current-reality). The
// lookup also indexes the legacy underscore form so older fixtures/clients
// still resolve demos instead of falling through to the generic rubric.
/** Canonicalize segment keys: underscores and hyphens are equivalent. */
export function normalizeSegmentKey(key: string): string {
  return key.replace(/_/g, "-");
}

/**
 * Stem renames that underscore↔hyphen normalization cannot recover.
 * Historical demo fixtures used `s9_commitments_close`; the spine key is
 * `s9-closeout`. Lookups resolve either form to the closeout demo spec.
 */
export const LEGACY_SEGMENT_KEY_ALIASES: Readonly<Record<string, string>> = {
  "s9_commitments_close": "s9-closeout",
  "s9-commitments-close": "s9-closeout",
};

/** Resolve a caller key through stem aliases, then underscore↔hyphen. */
export function resolveSegmentKeyAlias(key: string): string {
  return LEGACY_SEGMENT_KEY_ALIASES[key] ?? LEGACY_SEGMENT_KEY_ALIASES[normalizeSegmentKey(key)] ?? key;
}

const DEMO_BY_KEY = new Map<string, (typeof DEMO_SEGMENT_SPECS)[number]>();
for (const spec of DEMO_SEGMENT_SPECS) {
  DEMO_BY_KEY.set(spec.key, spec);
  DEMO_BY_KEY.set(normalizeSegmentKey(spec.key), spec);
  DEMO_BY_KEY.set(spec.key.replace(/-/g, "_"), spec);
}
// Index legacy stems onto the canonical demo specs they renamed into.
for (const [legacy, canonical] of Object.entries(LEGACY_SEGMENT_KEY_ALIASES)) {
  const target = DEMO_BY_KEY.get(canonical) ?? DEMO_BY_KEY.get(normalizeSegmentKey(canonical));
  if (target) {
    DEMO_BY_KEY.set(legacy, target);
    DEMO_BY_KEY.set(normalizeSegmentKey(legacy), target);
  }
}

// Session Guide runtime — the wiring that turns the Guide Engine agents
// (build plan §5.3) into a live facilitator inside a session Durable Object.
//
// Design constraints that shaped this module:
//  - §5.5 "Leader override is absolute": the guide NEVER mutates session
//    state and NEVER advances segments. Every output is a recommendation
//    or a question addressed to the room; the human decides.
//  - Cost discipline (docs/economics.md soft cap): PACER is deterministic
//    except the rare compress escalation; EVALUATOR runs at most once per
//    minEvaluateIntervalMs and only when new submissions exist; PROBER runs
//    only on non-on_track verdicts; SYNTHESIZER runs at segment boundaries.
//  - Graceful absence: every entry point takes a nullable LlmClient and
//    returns null when the guide cannot run (no key, disabled), so the
//    session degrades to the pre-guide manual lab rather than erroring.

/** How long the guide waits before re-evaluating the same segment. Matches
 * the 30s checkpoint/PACER cadence — one LLM call per tick at most. */
export const MIN_EVALUATE_INTERVAL_MS = 30_000;
/** Minimum submissions before an evaluation is worth an LLM call — one
 * answer cannot show a room's trend, and single-answer verdicts were the
 * main source of EVALUATOR false alarms in the Phase 2 measurements. */
export const MIN_SUBMISSIONS_TO_EVALUATE = 2;

/**
 * The fake-lab segments (FAKE_LAB_SEGMENTS) carry only presentation data,
 * and real curriculum packs (Phase 8) are IP-firewalled until Jeremy
 * populates docs/source-principles.md. So the guide runs against this
 * GENERIC facilitation rubric — our own methodology language, no source
 * material — parameterized by each segment's title. It grades what a
 * professional facilitator would grade on any planning question: is the
 * input specific, candid, and on-topic. When a real pack lands with its
 * own per-segment specs, parseSegmentSpec'd specs replace this default.
 */
/**
 * Resolve a segment's spec by key, preferring demo/reference content when it
 * exists and falling back to the generic facilitation rubric. This is the one
 * seam real curriculum packs will plug into: populate a pack compiled into
 * SEGMENT_SPECS (or extend this lookup with a live-pack registry) and the
 * guide immediately uses that pack's objectives and rubrics for its keys.
 */
export function specFor(segment: SegmentDef, liveFallbackSpecs?: SegmentSpec[]): SegmentSpec {
  const liveSpec =
    liveFallbackSpecs?.find((s) => s.key === segment.key) ??
    liveFallbackSpecs?.find((s) => normalizeSegmentKey(s.key) === normalizeSegmentKey(segment.key));
  if (liveSpec) return liveSpec;
  const aliased = resolveSegmentKeyAlias(segment.key);
  const demoSpec =
    DEMO_BY_KEY.get(segment.key) ??
    DEMO_BY_KEY.get(normalizeSegmentKey(segment.key)) ??
    DEMO_BY_KEY.get(segment.key.replace(/-/g, "_")) ??
    DEMO_BY_KEY.get(aliased) ??
    DEMO_BY_KEY.get(normalizeSegmentKey(aliased));
  if (demoSpec) {
    // Return a copy keyed to the caller's segment key so downstream consumers
    // (DO submission maps, PACER) stay consistent with the live session key.
    if (demoSpec.key === segment.key) return demoSpec;
    return { ...demoSpec, key: segment.key, title: segment.title || demoSpec.title, planned_minutes: segment.plannedMinutes || demoSpec.planned_minutes };
  }
  return defaultSpecFor(segment);
}

export function defaultSpecFor(segment: SegmentDef): SegmentSpec {
  return {
    key: segment.key,
    lab: 1,
    title: segment.title,
    planned_minutes: segment.plannedMinutes,
    input_mode: "phone_submit_then_discuss",
    min_submissions: 2,
    objective: `Conduct the "${segment.title}" segment: gather each participant's genuine, specific input on this planning question and leave with input the team can actually use in the plan.`,
    rubric: [
      {
        id: "specific",
        check:
          "Responses name concrete people, dates, numbers, programs, or mechanisms rather than generic sentiments or abstract goals.",
        fail_example_shape: '"We need to communicate better" with no concrete mechanism named.',
      },
      {
        id: "honest",
        check:
          'Responses engage candidly with real difficulties, tradeoffs, or disagreements rather than defaulting to "everything is fine" or listing only safe positives.',
        fail_example_shape: "Only praise or only neutral observations where a real constraint clearly exists.",
      },
      {
        id: "relevant",
        check: "Responses address the segment's stated objective rather than drifting to unrelated topics.",
        fail_example_shape: "A thoughtful answer to a different question than the one asked.",
      },
    ],
    exit_criteria: ["min_submissions_met"],
    produces: [{ artifact: "discussion_summary" }],
    fallback_if_stuck: ["narrow_the_frame", "leader_seeds_example"],
  };
}

export function computeExitCriteria(spec: SegmentSpec, submissionCount: number): Record<string, boolean> {
  // The only exit criterion the guide can observe on its own is the
  // submission floor. candor_check_passed / leader_confirmed /
  // vote_completed are human judgments the leader makes by advancing —
  // deliberately not automatable under §5.5.
  const minSubs = spec.min_submissions ?? 0;
  return { min_submissions_met: submissionCount >= minSubs };
}

export interface GuideContext {
  segment: SegmentDef;
  /** Minutes elapsed in the current segment (PACER input). */
  elapsedSegmentMin: number;
  /** Minutes left in the whole session budget (PACER input). */
  remainingSessionBudgetMin: number;
  submissionCount: number;
  /** Newest-first? No — insertion order, oldest first (state map order). */
  submissions: string[];
  transcriptWindow?: string;
  priorSegment?: SegmentDef;
  sessionId: string;
}

function makeGuideMessage(kind: GuideMessageKind, text: string, segmentKey: string, detail?: string): GuideMessage {
  return { id: crypto.randomUUID(), kind, text, segmentKey, detail, createdAt: new Date().toISOString() };
}

/** Cap the guide log so state broadcasts stay small over long sessions. */
export function appendGuideMessage(log: GuideMessage[] | undefined, message: GuideMessage, cap = 25): GuideMessage[] {
  const next = [...(log ?? []), message];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * PACER's 30s tick. Deterministic thresholds first (the common path);
 * the one LLM escalation — "what exactly should we cut?" — fires only on
 * a compress decision. Returns null when there is nothing new to say
 * (PACER should not nag: same action as last tick => silence).
 *
 * `escalationError` is set when the compress escalation failed: the
 * deterministic fallback text still composes into `message` (the room must
 * not lose its pacing guidance), but the caller is told the failure so it
 * can record it — the pre-wave version swallowed the error and the DO
 * booked the degraded tick as a SUCCESS, so the pacer's skip gate could
 * never trip and lastSuccessAt lied.
 */
export interface PacerTickResult {
  message: GuideMessage | null;
  action: string;
  escalationError?: unknown;
}

export async function runPacerTick(
  ctx: GuideContext,
  spec: SegmentSpec,
  llm: LlmClient | null,
  lastAction?: string,
): Promise<PacerTickResult> {
  const input: PacerInput = {
    segment: spec,
    elapsedSegmentMin: ctx.elapsedSegmentMin,
    remainingSessionBudgetMin: ctx.remainingSessionBudgetMin,
    submissionCount: ctx.submissionCount,
    exitCriteriaStatus: computeExitCriteria(spec, ctx.submissionCount),
  };
  const decision = decidePacerAction(input);

  // Recommendations the leader can't act on differently from the last one
  // are noise on a shared screen — say it once per state change.
  if (decision.action === lastAction) return { message: null, action: decision.action };
  if (decision.action === "continue") return { message: null, action: decision.action };
  if (decision.action === "advance" && decision.message_to_room === undefined) {
    // Exit criteria satisfied on their own is not worth a broadcast — the
    // leader sees the counts and advances. Only the OVERRUN advance (forced
    // move-on) is worth telling the room about.
    return { message: null, action: decision.action };
  }

  let text = decision.message_to_room ?? decision.rationale;
  let escalationError: unknown;
  if (decision.action === "compress" && llm) {
    try {
      const escalated = await escalateCompressDecision(input, llm);
      text = escalated.message_to_room;
    } catch (err) {
      // Malformed/failed escalation — decidePacerAction's rationale stands
      // for the room, but the failure must not vanish: hand it to the caller.
      escalationError = err;
    }
  }

  const detail =
    decision.action === "advance"
      ? `${Math.round((ctx.elapsedSegmentMin / spec.planned_minutes) * 100)}% of planned time used`
      : decision.rationale;
  const message = makeGuideMessage("pacer", text, ctx.segment.key, detail);
  message.minutesRemaining = Math.max(0, Math.round(ctx.remainingSessionBudgetMin));
  return {
    message,
    action: decision.action,
    escalationError,
  };
}

export interface EvaluateResult {
  message: GuideMessage | null;
  output: EvaluatorOutput | null;
  /** Set when PROBER's follow-up failed AFTER a paid EVALUATOR verdict.
   * The fallback message (built from the evaluator's own output, no new
   * LLM spend) is published; the caller logs this degradation without
   * counting the evaluator itself as failed — its verdict was valid. */
  proberError?: unknown;
}

/**
 * EVALUATOR on the room's current input; PROBER follow-up when the input
 * runs thin/off-track/stuck. Deterministic guardrails live in the DO (new
 * submissions + interval), the quality bar lives in the prompts.
 *
 * A PROBER failure must not discard the evaluator verdict the room already
 * paid for (pre-wave it threw, and the DO's catch published ZERO guide
 * messages): the follow-up falls back to a deterministic probe composed
 * from the evaluator's own output — same shape as the conflict/stuck
 * branches — and the error rides out on `proberError` for telemetry.
 */
export async function evaluateAndMaybeProbe(ctx: GuideContext, spec: SegmentSpec, llm: LlmClient): Promise<EvaluateResult> {
  const output = await runEvaluator(
    { segment: spec, submissions: ctx.submissions, transcriptWindow: ctx.transcriptWindow },
    llm,
  );

  if (output.verdict === "on_track") return { message: null, output };

  let message: GuideMessage | null = null;
  let proberError: unknown;
  if (output.verdict === "conflict") {
    // Conflict detection surfaces to the LEADER, worded so it de-escalates
    // rather than adjudicates (build plan §5.3; doctrinal neutrality).
    message = makeGuideMessage(
      "evaluator",
      "There's unresolved disagreement in the room on this question. It may be worth naming the competing views out loud before deciding — the call on how to handle it is yours.",
      ctx.segment.key,
      output.evidence,
    );
  } else if (output.verdict === "stuck") {
    const fallback = spec.fallback_if_stuck.includes("leader_seeds_example")
      ? "Consider seeding one concrete example yourself to show the level of specificity you're looking for."
      : "Consider narrowing the question to make it easier to answer.";
    message = makeGuideMessage(
      "evaluator",
      `The room appears stuck on this segment. ${fallback}`,
      ctx.segment.key,
      output.evidence,
    );
  } else {
    // thin | off_track — this is PROBER's whole job: a specific follow-up.
    // The room-visible detail on the SUCCESS path is the verdict (pre-wave
    // behavior — wave 1.1 had smuggled evidence in here on both paths).
    let text: string;
    let detail: string;
    try {
      const probe = await runProber(
        { segment: spec, evaluatorOutput: output, submissions: ctx.submissions },
        llm,
      );
      text = probe.probe;
      detail = output.verdict;
    } catch (err) {
      // The paid EVALUATOR verdict survives; publish a deterministic probe
      // from the evaluator's own output instead (no new LLM spend). This
      // fallback is new behavior by design, and its detail carries the
      // evaluator's evidence — the diagnostic that explains the probe.
      proberError = err;
      detail = output.evidence;
      const area = output.weakest_criterion ? ` (weakest area: ${output.weakest_criterion})` : "";
      text =
        output.verdict === "off_track"
          ? `The room's input has drifted from this segment's question${area}. Consider restating the question and asking for one concrete answer.`
          : `The room's input is still general${area}. Consider asking for one specific example — a name, a date, or a number.`;
    }
    message = makeGuideMessage("probe", text, ctx.segment.key, detail);
  }

  return { message, output, proberError };
}

export interface SynthesisResult {
  message: GuideMessage;
  artifactCount: number;
}

/**
 * SYNTHESIZER at a segment boundary — server-side, from the DO's stored
 * submissions (never client-supplied input). `persistArtifacts` receives
 * verified, provenance-checked artifacts and writes them to D1; a persist
 * failure must not lose the broadcast, so the caller wraps it.
 */
export async function synthesizeSegment(
  ctx: GuideContext,
  spec: SegmentSpec,
  llm: LlmClient,
  persistArtifacts: (artifacts: DraftArtifact[]) => Promise<void>,
): Promise<SynthesisResult> {
  const result = await runSynthesizer(
    { segment: spec, submissions: ctx.submissions, transcriptWindow: ctx.transcriptWindow },
    llm,
  );
  await persistArtifacts(result.artifacts);
  return {
    message: makeGuideMessage(
      "synthesis",
      `Draft plan notes from "${ctx.segment.title}" are saved to the working plan (${result.artifacts.length} item${result.artifacts.length === 1 ? "" : "s"}, each with its source in the room's input). Review and edit them before the next segment.`,
      ctx.segment.key,
      result.artifacts.map((a) => a.kind).join(", "),
    ),
    artifactCount: result.artifacts.length,
  };
}

/** The guide's model for in-session work is deliberately the fast one —
 * quality matters at synthesis, latency matters live (models.ts). Exposed
 * here so tests and callers share one routing decision. */
export function inSessionModel(): string {
  return MODELS.IN_SESSION;
}