import { z } from "zod";
import {
  InputModeSchema,
  ExitCriterionSchema,
  RubricCriterionSchema,
} from "./guide-engine/segment-schema.ts";

// ---------------------------------------------------------------------------
// SessionPlan — build plan §5.1. Curriculum is declarative data, versioned,
// schema-validated before anything ships. This file defines STRUCTURE plus the
// one sanctioned technical fixture (the six-hour reference itinerary from
// build plan §7, composed on the demo pack's keys). No live curriculum lives
// here — that stays behind the IP firewall in content/packs/ (Tier 2/3).
// ---------------------------------------------------------------------------

export const OutputKindSchema = z.enum(["statement", "ranking", "owners", "actions", "cadence"]);

export const OutputRequirementSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  kind: OutputKindSchema,
  /** Which segment produces this output — the audit links it back. */
  segmentKey: z.string().min(1),
  required: z.boolean().default(true),
});

export const RecoveryStrategySchema = z.enum([
  "narrow_the_frame",
  "anonymous_only_round",
  "leader_seeds_example",
  "silent_write_extension",
  "human_handoff",
]);

export const SegmentPlanSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  plannedMinutes: z.number().int().positive(),
  inputMode: InputModeSchema,
  requiredOutputs: z.array(OutputRequirementSchema).min(1),
  rubric: z.array(RubricCriterionSchema).min(1),
  exitCriteria: z.array(ExitCriterionSchema).min(1),
  /** Bounds within which the Guide may adapt (never beyond, per §5.2). */
  allowedAdaptations: z.array(z.string().min(1)).default([]),
  fallbackIfStuck: z.array(RecoveryStrategySchema).min(1),
});

export const BreakSpecSchema = z.object({
  id: z.string().min(1),
  /** The break happens after this segment completes. */
  afterSegmentKey: z.string().min(1),
  plannedMinutes: z.number().int().positive(),
  /** The room is owed at least this much — `end_break` before it is an
   * explicit forced override (D7), recorded in the event log. */
  minimumMinutes: z.number().int().positive(),
  reentryPrompt: z.string().min(1),
});

export const GroupStrategySchema = z.enum(["random", "mixed", "role", "manual"]);

export const BreakoutSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  /** The segment this breakout is the small-group delivery mode FOR. The
   * breakout runs inside that segment's planned window (D6). */
  appliesToSegmentKey: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  groupStrategy: GroupStrategySchema,
  roles: z.array(z.string().min(1)),
  instructions: z.array(z.string().min(1)).min(1),
  requiredFields: z.array(OutputRequirementSchema).min(1),
  reportBackMinutes: z.number().int().positive(),
  stuckProtocol: z.array(RecoveryStrategySchema).min(1),
});

export const ClosingSpecSchema = z.object({
  /** Minutes reserved at the end of the plan — PACER/SPINE protect this. */
  bufferMinutes: z.number().int().positive(),
  requiredOutputs: z.array(OutputRequirementSchema).min(1),
  commitmentsRequired: z.boolean(),
});

export const SessionPlanSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  plannedMinutes: z.number().int().positive(),
  segments: z.array(SegmentPlanSchema).min(1),
  breaks: z.array(BreakSpecSchema).default([]),
  breakouts: z.array(BreakoutSpecSchema).default([]),
  closing: ClosingSpecSchema,
});

export type OutputRequirement = z.infer<typeof OutputRequirementSchema>;
export type RecoveryStrategy = z.infer<typeof RecoveryStrategySchema>;
export type SegmentPlan = z.infer<typeof SegmentPlanSchema>;
export type BreakSpec = z.infer<typeof BreakSpecSchema>;
export type BreakoutSpec = z.infer<typeof BreakoutSpecSchema>;
export type ClosingSpec = z.infer<typeof ClosingSpecSchema>;
export type SessionPlan = z.infer<typeof SessionPlanSchema>;

export class SessionPlanValidationError extends Error {}

/**
 * Parse + structural validation. Beyond the zod schema this enforces the
 * cross-references a compiler can get wrong: unique segment keys, break and
 * breakout anchors that exist, no two breaks anchored to the same segment,
 * no breakout pointing at a segment twice, total minutes matching the
 * announced plan total, and the closing buffer not exceeding the last
 * segment's planned time.
 */
export function parseSessionPlan(raw: unknown): SessionPlan {
  let plan: SessionPlan;
  try {
    plan = SessionPlanSchema.parse(raw);
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
    throw new SessionPlanValidationError(`session plan failed schema validation: ${detail}`);
  }

  const keys = plan.segments.map((s) => s.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) {
    throw new SessionPlanValidationError(`duplicate segment keys: ${[...new Set(dupes)].join(", ")}`);
  }

  const keySet = new Set(keys);
  for (const b of plan.breaks) {
    if (!keySet.has(b.afterSegmentKey)) {
      throw new SessionPlanValidationError(`break "${b.id}" anchors to unknown segment "${b.afterSegmentKey}"`);
    }
    if (b.minimumMinutes > b.plannedMinutes) {
      throw new SessionPlanValidationError(
        `break "${b.id}" minimum (${b.minimumMinutes}) exceeds planned minutes (${b.plannedMinutes})`,
      );
    }
  }
  const breakAnchors = plan.breaks.map((b) => b.afterSegmentKey);
  const dupeBreaks = breakAnchors.filter((k, i) => breakAnchors.indexOf(k) !== i);
  if (dupeBreaks.length > 0) {
    throw new SessionPlanValidationError(`more than one break anchored to segment(s): ${[...new Set(dupeBreaks)].join(", ")}`);
  }

  for (const bo of plan.breakouts) {
    if (!keySet.has(bo.appliesToSegmentKey)) {
      throw new SessionPlanValidationError(`breakout "${bo.id}" applies to unknown segment "${bo.appliesToSegmentKey}"`);
    }
    if (bo.durationMinutes > plan.segments.find((s) => s.key === bo.appliesToSegmentKey)!.plannedMinutes) {
      throw new SessionPlanValidationError(
        `breakout "${bo.id}" duration (${bo.durationMinutes}m) exceeds its segment's planned window`,
      );
    }
  }
  const breakoutAnchors = plan.breakouts.map((b) => b.appliesToSegmentKey);
  const dupeBreakouts = breakoutAnchors.filter((k, i) => breakoutAnchors.indexOf(k) !== i);
  if (dupeBreakouts.length > 0) {
    throw new SessionPlanValidationError(`more than one breakout applies to segment(s): ${[...new Set(dupeBreakouts)].join(", ")}`);
  }

  const sum = plan.segments.reduce((acc, s) => acc + s.plannedMinutes, 0) + plan.breaks.reduce((acc, b) => acc + b.plannedMinutes, 0);
  if (sum !== plan.plannedMinutes) {
    throw new SessionPlanValidationError(
      `plannedMinutes (${plan.plannedMinutes}) does not match segments+breaks total (${sum})`,
    );
  }

  const lastSegment = plan.segments[plan.segments.length - 1];
  if (plan.closing.bufferMinutes > lastSegment.plannedMinutes) {
    throw new SessionPlanValidationError(
      `closing buffer (${plan.closing.bufferMinutes}m) exceeds the final segment's planned time (${lastSegment.plannedMinutes}m)`,
    );
  }

  for (const o of plan.closing.requiredOutputs) {
    if (!keySet.has(o.segmentKey)) {
      throw new SessionPlanValidationError(`closing required output "${o.key}" references unknown segment "${o.segmentKey}"`);
    }
  }
  const produced = new Set(plan.segments.flatMap((s) => s.requiredOutputs.map((o) => o.key)));
  for (const o of plan.closing.requiredOutputs) {
    if (!produced.has(o.key)) {
      throw new SessionPlanValidationError(`closing required output "${o.key}" is not produced by any segment`);
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// The six-hour reference itinerary (build plan §7) — a technical test fixture,
// composed from the demo reference pack's keys so the guide resolves real
// segment specs for every segment. Segments sum to 315 minutes; three
// 15-minute breaks bring the plan to exactly 360.
// ---------------------------------------------------------------------------

function output(key: string, title: string, kind: OutputRequirement["kind"], segmentKey: string): OutputRequirement {
  return { key, title, kind, segmentKey, required: true };
}

function criterion(id: string, check: string): SegmentPlan["rubric"][number] {
  return { id, check };
}

/** Objective + rubric for a segment, in the same safe planning-room voice the
 * demo pack uses (generic vocabulary only — see docs/vocabulary.md). */
function segment(
  key: string,
  title: string,
  objective: string,
  plannedMinutes: number,
  inputMode: SegmentPlan["inputMode"],
  requiredOutputs: OutputRequirement[],
  exitCriteria: SegmentPlan["exitCriteria"],
  fallbackIfStuck: SegmentPlan["fallbackIfStuck"],
): SegmentPlan {
  return {
    key,
    title,
    objective,
    plannedMinutes,
    inputMode,
    requiredOutputs,
    rubric: [
      criterion("specific", "Inputs name concrete people, dates, numbers, programs, or mechanisms rather than general sentiments."),
      criterion("honest", "Inputs engage candidly with real difficulties, tradeoffs, or disagreements rather than safe positives only."),
      criterion("relevant", "Inputs address the segment's stated objective rather than drifting to unrelated topics."),
    ],
    exitCriteria,
    allowedAdaptations: [],
    fallbackIfStuck,
  };
}

export const SPINE_REFERENCE_PLAN: SessionPlan = {
  id: "groundwork.reference.six-hour",
  version: "1.0.0",
  title: "Six-hour strategic planning session",
  plannedMinutes: 360,
  segments: [
    segment(
      "s1-welcome",
      "Welcome & orientation",
      "Orient the room: who the AI Guide is, what it does and does not do, how input is used, and the shape of the next six hours.",
      20,
      "discussion_only",
      [output("out.orientation_ack", "Orientation acknowledged", "statement", "s1-welcome")],
      ["leader_confirmed"],
      ["leader_seeds_example"],
    ),
    segment(
      "s2-current-reality",
      "Individual reflection & sharing",
      "Each participant records the honest current reality of the organization — what is working, what is not, and what is hardest right now.",
      45,
      "silent_write",
      [output("out.current_reality", "Current reality entries", "statement", "s2-current-reality")],
      ["min_submissions_met", "candor_check_passed"],
      ["silent_write_extension", "leader_seeds_example"],
    ),
    segment(
      "s3-purpose-clarity",
      "Whole-group mapping",
      "Bring the individual reflections into one shared map of the organization's current reality, naming tensions without resolving them by force.",
      45,
      "phone_submit_then_discuss",
      [output("out.shared_map", "Shared reality map", "statement", "s3-purpose-clarity")],
      ["min_submissions_met", "leader_confirmed"],
      ["narrow_the_frame", "leader_seeds_example"],
    ),
    segment(
      "s4-themes-tensions",
      "Themes & tensions in small groups",
      "Small groups identify the recurring themes and the live tensions between them, keeping disagreement visible rather than forced into agreement.",
      45,
      "phone_submit_then_discuss",
      [output("out.themes", "Named themes", "statement", "s4-themes-tensions")],
      ["min_submissions_met", "leader_confirmed"],
      ["anonymous_only_round", "narrow_the_frame"],
    ),
    segment(
      "s5-report-back-synthesis",
      "Report-back & synthesis",
      "Each group reports back; the room hears every theme and tension side by side before anything is merged or prioritized.",
      30,
      "discussion_only",
      [output("out.report_back", "Report-back record", "statement", "s5-report-back-synthesis")],
      ["leader_confirmed"],
      ["leader_seeds_example"],
    ),
    segment(
      "s6-prioritization",
      "Prioritization & tradeoffs",
      "The room ranks the priorities it would defend, and names the tradeoffs each ranking accepts.",
      45,
      "vote_then_discuss",
      [output("out.priority_ranking", "Priority ranking", "ranking", "s6-prioritization")],
      ["vote_completed", "leader_confirmed"],
      ["narrow_the_frame"],
    ),
    segment(
      "s7-initiatives",
      "Initiatives in small groups",
      "Small groups turn the top priorities into concrete initiatives with named owners and first steps.",
      40,
      "phone_submit_then_discuss",
      [output("out.initiatives", "Initiatives with owners", "owners", "s7-initiatives")],
      ["min_submissions_met", "leader_confirmed"],
      ["leader_seeds_example"],
    ),
    segment(
      "s8-consolidation",
      "Consolidation & challenge review",
      "Consolidate the working plan; challenge weak links; park what the room cannot settle today instead of forcing it.",
      30,
      "discussion_only",
      [output("out.consolidated_plan", "Consolidated plan review", "statement", "s8-consolidation")],
      ["leader_confirmed"],
      ["narrow_the_frame"],
    ),
    segment(
      "s9-closeout",
      "Commitments & close",
      "Confirm the commitments, owners, first actions, and the review rhythm that keeps the plan honest after today.",
      15,
      "discussion_only",
      [
        output("out.commitments", "Commitments & owners", "actions", "s9-closeout"),
        output("out.review_cadence", "Review cadence", "cadence", "s9-closeout"),
      ],
      ["leader_confirmed"],
      ["leader_seeds_example"],
    ),
  ],
  breaks: [
    { id: "brk-1", afterSegmentKey: "s3-purpose-clarity", plannedMinutes: 15, minimumMinutes: 10, reentryPrompt: "Welcome back — here is where we are and what comes next." },
    { id: "brk-2", afterSegmentKey: "s5-report-back-synthesis", plannedMinutes: 15, minimumMinutes: 10, reentryPrompt: "Welcome back — we move to prioritization now." },
    { id: "brk-3", afterSegmentKey: "s7-initiatives", plannedMinutes: 15, minimumMinutes: 10, reentryPrompt: "Welcome back — final consolidation and commitments ahead." },
  ],
  breakouts: [
    {
      id: "bo-themes",
      title: "Themes & tensions small groups",
      purpose: "Surface recurring themes and keep live tensions visible before any merging.",
      appliesToSegmentKey: "s4-themes-tensions",
      durationMinutes: 45,
      groupStrategy: "mixed",
      roles: ["scribe", "speaker", "timekeeper"],
      instructions: [
        "List the themes your group keeps hearing across the reflections.",
        "Name the tensions between themes honestly — do not resolve them in the group.",
        "Scribe captures each theme and each tension as its own line.",
      ],
      requiredFields: [output("out.themes", "Named themes", "statement", "s4-themes-tensions")],
      reportBackMinutes: 10,
      stuckProtocol: ["anonymous_only_round", "leader_seeds_example"],
    },
    {
      id: "bo-initiatives",
      title: "Initiatives small groups",
      purpose: "Turn the agreed priorities into concrete initiatives with owners and first steps.",
      appliesToSegmentKey: "s7-initiatives",
      durationMinutes: 40,
      groupStrategy: "role",
      roles: ["owner", "scribe", "speaker"],
      instructions: [
        "For each assigned priority, name one concrete initiative.",
        "Give it an owner by name and a first step with a date.",
        "Flag anything your group cannot settle — parked, not forced.",
      ],
      requiredFields: [output("out.initiatives", "Initiatives with owners", "owners", "s7-initiatives")],
      reportBackMinutes: 10,
      stuckProtocol: ["leader_seeds_example"],
    },
  ],
  closing: {
    bufferMinutes: 15,
    requiredOutputs: [
      output("out.current_reality", "Current reality entries", "statement", "s2-current-reality"),
      output("out.priority_ranking", "Priority ranking", "ranking", "s6-prioritization"),
      output("out.initiatives", "Initiatives with owners", "owners", "s7-initiatives"),
      output("out.commitments", "Commitments & owners", "actions", "s9-closeout"),
      output("out.review_cadence", "Review cadence", "cadence", "s9-closeout"),
    ],
    commitmentsRequired: true,
  },
};

/** The SessionPlan flattened to the SegmentDef list the SessionDO's existing
 * machinery (advance, submissions, votes, PACER) already consumes — the spine
 * and the legacy pipeline share one segment list. */
export function planToSegmentDefs(plan: SessionPlan): { key: string; title: string; plannedMinutes: number }[] {
  return plan.segments.map((s) => ({ key: s.key, title: s.title, plannedMinutes: s.plannedMinutes }));
}
