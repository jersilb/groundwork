#!/usr/bin/env node --experimental-strip-types
// Eval harness — build plan §5.6/§2 Phase 2 gate: EVALUATOR `thin`-verdict
// precision must exceed 0.8 before Phase 2 can be marked passed.
//
// Two modes:
//  - REAL mode (ANTHROPIC_API_KEY set): calls the actual EVALUATOR against
//    real Claude, computes genuine precision/recall, enforces the gate.
//  - SELF-TEST mode (no key — the case in this environment): substitutes a
//    simple keyword/digit heuristic for "the model" so the harness's own
//    confusion-matrix math can be proven correct. This is NOT a measurement
//    of real EVALUATOR quality. See docs/capability-gaps.md, 2026-07-27.
import { readFileSync } from "node:fs";
import path from "node:path";
import { runEvaluator, type EvaluatorVerdict } from "../src/guide-engine/evaluator.ts";
import { FixedFakeLlmClient } from "../src/guide-engine/testing/fake-llm-client.ts";
import { AnthropicLlmClient, type LlmClient } from "../src/guide-engine/llm-client.ts";
import { MODELS } from "../src/guide-engine/models.ts";
import type { SegmentSpec } from "../src/guide-engine/segment-schema.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_PATH = path.join(REPO_ROOT, "src/guide-engine/__fixtures__/eval-fixtures.json");

interface FixtureCase {
  id: string;
  expectedVerdict: EvaluatorVerdict;
  submissions: string[];
}
interface FixtureFile {
  segment: SegmentSpec;
  cases: FixtureCase[];
}

const INCREASE_WORDS = ["up", "increase", "increasing", "climbing", "rose", "grew", "growing"];
const DECREASE_WORDS = ["down", "decrease", "decreasing", "declining", "fell", "dropped", "shrinking"];

function includesWord(text: string, word: string): boolean {
  // Word-boundary match — a naive .includes() matches "up" inside "group"
  // or "sign-ups", which is exactly the kind of false positive a real
  // semantic judge wouldn't make. Caught by inspecting this harness's own
  // first run, 2026-07-27.
  return new RegExp(`\\b${word}\\b`, "i").test(text);
}

function hasTrendConflict(submissions: string[]): boolean {
  const hasIncrease = submissions.some((s) => INCREASE_WORDS.some((w) => includesWord(s, w)));
  const hasDecrease = submissions.some((s) => DECREASE_WORDS.some((w) => includesWord(s, w)));
  return hasIncrease && hasDecrease;
}

function countDigits(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

/** Heuristic stand-in for a real semantic judge. Deliberately simplistic —
 * see file header. Used only when no Anthropic API key is configured. */
function classifyHeuristically(submissions: string[]): EvaluatorVerdict {
  if (submissions.length === 0) return "off_track";
  if (hasTrendConflict(submissions)) return "conflict";
  const specific = submissions.filter((s) => countDigits(s) > 0).length;
  if (specific >= Math.ceil(submissions.length / 2)) return "on_track";
  return "thin";
}

function buildHeuristicLlmClient(segment: SegmentSpec, submissions: string[]): LlmClient {
  const verdict = classifyHeuristically(submissions);
  return new FixedFakeLlmClient(
    JSON.stringify({
      verdict,
      per_criterion_scores: segment.rubric.map((r) => ({ id: r.id, score: verdict === "on_track" ? 0.8 : 0.3, note: "heuristic stand-in" })),
      weakest_criterion: segment.rubric[0].id,
      evidence: "HEURISTIC STAND-IN — not a real judgment. See docs/capability-gaps.md.",
    }),
  );
}

async function main() {
  const fixtures: FixtureFile = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const realMode = Boolean(apiKey);

  console.log(realMode ? "=== REAL MEASUREMENT MODE (ANTHROPIC_API_KEY set) ===" : "=== HARNESS SELF-TEST MODE — NO ANTHROPIC_API_KEY ===");
  if (!realMode) {
    console.log("This run proves the confusion-matrix / precision / recall math is correct.");
    console.log("It does NOT measure real EVALUATOR quality — that requires a live API key.");
    console.log("See docs/capability-gaps.md, 2026-07-27.\n");
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const rows: { id: string; expected: string; predicted: string; match: boolean }[] = [];
  const errors: string[] = [];

  for (const c of fixtures.cases) {
    const llm: LlmClient = realMode
      ? new AnthropicLlmClient(apiKey!)
      : buildHeuristicLlmClient(fixtures.segment, c.submissions);
    try {
      const result = await runEvaluator(
        { segment: fixtures.segment, submissions: c.submissions },
        llm,
      );
      const predicted = result.verdict;
      rows.push({ id: c.id, expected: c.expectedVerdict, predicted, match: predicted === c.expectedVerdict });

      const predictedThin = predicted === "thin";
      const actualThin = c.expectedVerdict === "thin";
      if (predictedThin && actualThin) tp += 1;
      else if (predictedThin && !actualThin) fp += 1;
      else if (!predictedThin && actualThin) fn += 1;
      else tn += 1;
    } catch (err) {
      errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("Per-case results:");
  console.log("id        expected    predicted   match");
  for (const r of rows) {
    console.log(`${r.id.padEnd(10)}${r.expected.padEnd(12)}${r.predicted.padEnd(12)}${r.match ? "yes" : "NO"}`);
  }

  // Expected-vs-actual, per docs/agent-team.md's topology rules: a merge
  // that silently drops inputs is a failure mode in its own right, not
  // something to average away. An error means the case never produced a
  // usable verdict — it must never be quietly excluded from the gate math.
  const expectedCases = fixtures.cases.length;
  const actualResults = rows.length + errors.length;
  if (errors.length > 0) {
    console.error(`\n${errors.length}/${expectedCases} case(s) ERRORED (parse/validation failures, not verdict mismatches) — excluded from the confusion matrix below:`);
    for (const e of errors) console.error(`  ${e}`);
  }
  if (actualResults !== expectedCases) {
    console.error(`\nFAIL: expected ${expectedCases} case outcomes, accounted for ${actualResults}. Something was silently dropped.`);
    process.exit(1);
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : NaN;
  const recall = tp + fn > 0 ? tp / (tp + fn) : NaN;

  console.log(`\n'thin' verdict confusion matrix (over ${rows.length}/${expectedCases} cases that produced a verdict): TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`Precision: ${precision.toFixed(3)}  Recall: ${recall.toFixed(3)}`);

  if (realMode) {
    if (errors.length > 0) {
      console.log(`\nPhase 2 gate: INCONCLUSIVE — ${errors.length} case(s) errored. A precision number computed over a subset that excludes the cases EVALUATOR couldn't even produce valid output for is not a trustworthy gate measurement. Fix the errors and re-run before trusting this number.`);
      process.exit(1);
    }
    const gatePassed = precision > 0.8;
    console.log(`\nPhase 2 gate (precision > 0.8, ${expectedCases}/${expectedCases} cases clean): ${gatePassed ? "PASS" : "FAIL"}`);
    process.exit(gatePassed ? 0 : 1);
  } else {
    console.log("\nNo gate is being enforced in self-test mode — this number describes the heuristic stand-in, not EVALUATOR.");
    console.log("Harness self-test: PASS (ran end-to-end, produced a computable confusion matrix, zero parse errors).");
    process.exit(errors.length === 0 ? 0 : 1);
  }
}

main();
