import { z } from "zod";

/**
 * Segment spec schema — build plan §5.2. Curriculum is data, not prompt
 * text: this is the schema `curriculum-author` writes YAML against, and
 * `ip-firewall-guardian` reviews every instance of before it ships.
 *
 * This file defines STRUCTURE only. It contains no curriculum content.
 */

export const RubricCriterionSchema = z.object({
  id: z.string(),
  check: z.string(),
  fail_example_shape: z.string().optional(),
});

export const InputModeSchema = z.enum([
  "phone_submit_then_discuss",
  "discussion_only",
  "vote_then_discuss",
  "silent_write",
]);

export const ExitCriterionSchema = z.enum([
  "min_submissions_met",
  "candor_check_passed",
  "leader_confirmed",
  "vote_completed",
]);

export const FallbackStrategySchema = z.enum([
  "narrow_the_frame",
  "anonymous_only_round",
  "leader_seeds_example",
]);

export const SegmentSpecSchema = z.object({
  key: z.string().min(1),
  lab: z.number().int().min(1).max(4),
  title: z.string().min(1),
  planned_minutes: z.number().int().positive(),
  input_mode: InputModeSchema,
  min_submissions: z.number().int().nonnegative().optional(),
  objective: z.string().min(1),
  rubric: z.array(RubricCriterionSchema).min(1),
  exit_criteria: z.array(ExitCriterionSchema).min(1),
  produces: z.array(z.object({ artifact: z.string() })).min(1),
  fallback_if_stuck: z.array(FallbackStrategySchema).default([]),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type SegmentSpec = z.infer<typeof SegmentSpecSchema>;

export function parseSegmentSpec(raw: unknown): SegmentSpec {
  return SegmentSpecSchema.parse(raw);
}
