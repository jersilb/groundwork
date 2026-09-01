#!/usr/bin/env node --experimental-strip-types
// SessionPlan schema gate — build plan §6 R0. The reference six-hour plan must
// compile with zero validation errors, and every malformed fixture class the
// compiler could realistically produce must be REJECTED with a specific reason.
// Pure, deterministic, no network, no API key.
import assert from "node:assert/strict";
import { SPINE_REFERENCE_PLAN, parseSessionPlan, SessionPlanValidationError } from "../src/session-plan.ts";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${checks} — ${name}`);
}
function expectRejected(name: string, raw: unknown, fragment: string): void {
  assert.throws(() => parseSessionPlan(raw), (err: unknown) => {
    assert.ok(err instanceof SessionPlanValidationError, `expected SessionPlanValidationError for ${name}`);
    assert.ok(
      (err as Error).message.includes(fragment),
      `${name}: expected message to include "${fragment}", got "${(err as Error).message}"`,
    );
    return true;
  });
}

function clone(plan: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
}

console.log("=== SessionPlan schema gate ===");

check("reference six-hour plan compiles", () => {
  const plan = parseSessionPlan(SPINE_REFERENCE_PLAN);
  assert.equal(plan.segments.length, 9);
  assert.equal(plan.breaks.length, 3);
  assert.equal(plan.breakouts.length, 2);
  assert.equal(plan.plannedMinutes, 360);
  const segmentSum = plan.segments.reduce((a, s) => a + s.plannedMinutes, 0);
  const breakSum = plan.breaks.reduce((a, b) => a + b.plannedMinutes, 0);
  assert.equal(segmentSum + breakSum, 360, "segments + breaks must equal the announced 6:00");
  // Every segment key resolves in the demo reference pack (specFor seam).
  for (const seg of plan.segments) {
    assert.match(seg.key, /^s\d-/, "reference plan keys follow the demo pack convention");
  }
  // Closing buffer fits inside the final segment.
  assert.ok(plan.closing.bufferMinutes <= plan.segments[plan.segments.length - 1].plannedMinutes);
  // Every break anchor and breakout anchor exists.
  const keys = new Set(plan.segments.map((s) => s.key));
  for (const b of plan.breaks) assert.ok(keys.has(b.afterSegmentKey));
  for (const bo of plan.breakouts) assert.ok(keys.has(bo.appliesToSegmentKey));
});

check("reject: segment with no required output", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.segments as any[])[2].requiredOutputs = [];
  expectRejected("missing output", bad, "requiredOutputs");
});

check("reject: impossible break timing (minimum exceeds planned)", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.breaks as any[])[0].minimumMinutes = 99;
  expectRejected("impossible timing", bad, "minimum");
});

check("reject: breakout without a report-back window", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.breakouts as any[])[0].reportBackMinutes = 0;
  expectRejected("no report-back", bad, "reportBackMinutes");
});

check("reject: two breaks anchored to the same segment", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.breaks as any[])[1].afterSegmentKey = (bad.breaks as any[])[0].afterSegmentKey;
  expectRejected("overlapping break", bad, "more than one break");
});

check("reject: unknown input mode", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.segments as any[])[1].inputMode = "telepathy";
  expectRejected("unknown input mode", bad, "inputMode");
});

check("reject: negative minutes", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.segments as any[])[4].plannedMinutes = -30;
  (bad as any).plannedMinutes = 360 + 30; // keep the total check from firing first
  expectRejected("negative minutes", bad, "plannedMinutes");
});

check("reject: duplicate segment keys", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.segments as any[])[8].key = (bad.segments as any[])[0].key;
  expectRejected("duplicate keys", bad, "duplicate segment keys");
});

check("reject: plan total does not match its parts (unclosed plan)", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  bad.plannedMinutes = 300;
  expectRejected("unclosed plan", bad, "does not match");
});

check("reject: closing buffer larger than the final segment", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.closing as any).bufferMinutes = 60;
  expectRejected("closing buffer", bad, "closing buffer");
});

check("reject: closing output referencing an unknown segment", () => {
  const bad = clone(SPINE_REFERENCE_PLAN) as Record<string, any>;
  (bad.closing as any).requiredOutputs[0].segmentKey = "s99-ghost";
  expectRejected("closing output anchor", bad, "unknown segment");
});

check("reject: not a plan at all", () => {
  expectRejected("garbage", { hello: "world" }, "schema validation");
});

console.log(`\nPASS — ${checks} schema checks green.`);
