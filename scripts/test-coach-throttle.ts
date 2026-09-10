#!/usr/bin/env node --experimental-strip-types
// COACH nudge throttle — bug #9. The dashboard POSTs
// /program/:id/coach/nudges on every load, and the route re-personalized
// every overdue step on every call: refreshing the dashboard burned API
// budget with no server-side throttle, cache or dedupe.
//
// These checks drive the REAL route handler against a REAL SQLite engine
// (node:sqlite) wearing the D1 interface, with the repo's migrations applied
// in order — so the throttle's persistence, its cooldown window and its
// per-step key are the production SQL, not a stub standing in for it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Env } from "../src/index.ts";
import { handleProgramRoute } from "../src/program/routes.ts";
import { COACH_NUDGE_COOLDOWN_MS, generateNudgesForProgram } from "../src/program/coach.ts";
import { HeuristicFakeLlmClient } from "../src/guide-engine/testing/fake-llm-client.ts";

// node:sqlite still flag-warns as experimental on Node 22. The suite has
// already decided to use it; the warning is noise, not information.
(process as unknown as { emitWarning: () => void }).emitWarning = () => {};
const { DatabaseSync: SqliteDatabase } = await import("node:sqlite");

/** Minimal D1 surface over node:sqlite. D1 and node:sqlite both speak the
 * same SQLite parameter syntax (?1, ?2), so binds pass straight through. */
class SqlitePreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: readonly unknown[];

  constructor(db: DatabaseSync, sql: string, params: readonly unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.db, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as SQLInputValue[]));
    return (row ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.params as SQLInputValue[])) as T[] };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.prepare(this.sql).run(...(this.params as SQLInputValue[]));
    return { success: true };
  }
}

class FakeD1 {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.db, sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

// One in-memory database, every migration in migrations/ applied in order.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "migrations");
const sqlite = new SqliteDatabase(":memory:");
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}
const db = new FakeD1(sqlite);
const env = { DB: db } as unknown as Env;

const LEADER_EMAIL = "leader@example.org";
const FIVE_DAYS_AGO = new Date(Date.now() - 5 * 86_400_000).toISOString();
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 86_400_000).toISOString();

interface CoachNudgesBody {
  nudges: { stepId: string; message: string }[];
  personalized: boolean;
  suppressedCount?: number;
}

/** Create the org / user / program / initiative scaffolding a nudge run needs. */
async function seedProgram(input: { orgId: string; programId: string; initiativeId: string; initiativeTitle: string }): Promise<void> {
  await db
    .prepare(`INSERT INTO organization (id, name, type, created_at) VALUES (?1, ?2, 'church', ?3)`)
    .bind(input.orgId, `Org ${input.orgId}`, FIVE_DAYS_AGO)
    .run();
  await db
    .prepare(`INSERT INTO user (id, org_id, email, name, role) VALUES (?1, ?2, ?3, 'Test Leader', 'leader')`)
    .bind(`user-${input.orgId}`, input.orgId, LEADER_EMAIL)
    .run();
  await db
    .prepare(`INSERT INTO program (id, org_id, status, current_lab) VALUES (?1, ?2, 'in_progress', 1)`)
    .bind(input.programId, input.orgId)
    .run();
  await db
    .prepare(`INSERT INTO initiative (id, program_id, title, status, health) VALUES (?1, ?2, ?3, 'not_started', 'green')`)
    .bind(input.initiativeId, input.programId, input.initiativeTitle)
    .run();
}

async function addOverdueStep(input: { stepId: string; initiativeId: string; description: string; dueDate: string }): Promise<void> {
  await db
    .prepare(`INSERT INTO initiative_step (id, initiative_id, description, due_date) VALUES (?1, ?2, ?3, ?4)`)
    .bind(input.stepId, input.initiativeId, input.description, input.dueDate)
    .run();
}

/** The dashboard's call: POST /program/:id/coach/nudges, dev auth headers. */
async function callNudges(programId: string, init?: { search?: string; body?: unknown }): Promise<{ status: number; json: CoachNudgesBody }> {
  const search = init?.search ?? "";
  const url = new URL(`https://groundwork.test/program/${programId}/coach/nudges${search}`);
  const request = new Request(url, {
    method: "POST",
    headers: {
      "X-Groundwork-Dev-User": LEADER_EMAIL,
      "X-Groundwork-Dev-Sub": "dev-sub-0001",
      "content-type": "application/json",
    },
    body: JSON.stringify(init?.body ?? {}),
  });
  const response = await handleProgramRoute(request, env, url);
  assert.ok(response, "the program router must handle POST /program/:id/coach/nudges");
  return { status: response.status, json: (await response.json()) as CoachNudgesBody };
}

async function nudgedAt(stepId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT nudged_at FROM coach_nudge WHERE step_id = ?1`).bind(stepId).first<{ nudged_at: string }>();
  return row?.nudged_at ?? null;
}

/** Time travel at the storage layer: rewrite a step's last-nudge timestamp to
 * sit outside the cooldown window. That timestamp is the only thing the
 * throttle reads, so this is the same state a real 24h gap produces. */
async function ageNudgePastCooldown(stepId: string): Promise<void> {
  const aged = new Date(Date.now() - COACH_NUDGE_COOLDOWN_MS - 60 * 60 * 1000).toISOString();
  await db.prepare(`UPDATE coach_nudge SET nudged_at = ?1 WHERE step_id = ?2`).bind(aged, stepId).run();
}

let checksRun = 0;
let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    checksRun += 1;
    console.log(`  ok ${checksRun} — ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL — ${name}`);
    console.error(err);
  }
}

console.log("=== COACH nudge throttle (bug #9) ===");

await seedProgram({ orgId: "org-1", programId: "p1", initiativeId: "i1", initiativeTitle: "Rebuild the volunteer pipeline" });
await addOverdueStep({ stepId: "s1", initiativeId: "i1", description: "Call the lapsed volunteers", dueDate: FIVE_DAYS_AGO });
await addOverdueStep({ stepId: "s2", initiativeId: "i1", description: "Draft the follow-up plan", dueDate: THREE_DAYS_AGO });

await check("first load nudges both overdue steps; response shape unchanged", async () => {
  const { status, json } = await callNudges("p1");
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.nudges), "nudges must still be an array");
  assert.equal(typeof json.personalized, "boolean", "personalized must still be a boolean");
  assert.deepEqual(
    json.nudges.map((n) => n.stepId).sort(),
    ["s1", "s2"],
    "both overdue steps get a nudge on the first load",
  );
  for (const nudge of json.nudges) {
    assert.equal(typeof nudge.message, "string");
    assert.ok(nudge.message.length > 0, "each nudge carries a message");
  }
});

await check("a second dashboard load inside the cooldown adds no duplicate nudge", async () => {
  const { status, json } = await callNudges("p1");
  assert.equal(status, 200);
  assert.deepEqual(json.nudges, [], "the same overdue steps must not be nudged twice inside the cooldown");
});

await check("refreshing with a cache-buster and a force flag is still suppressed", async () => {
  const { json } = await callNudges("p1", { search: "?nocache=1", body: { force: true, refresh: true } });
  assert.deepEqual(json.nudges, [], "no client-supplied parameter may bypass the server-side throttle");
});

await check("suppressed loads do not reset the cooldown clock", async () => {
  const before = await nudgedAt("s1");
  await callNudges("p1");
  await callNudges("p1");
  assert.equal(
    await nudgedAt("s1"),
    before,
    "a suppressed load must not re-record the nudge — otherwise a user who refreshes every day never sees the reminder again",
  );
});

await check("a step that has never been nudged goes out while the others stay suppressed", async () => {
  await addOverdueStep({ stepId: "s3", initiativeId: "i1", description: "Book the follow-up meeting", dueDate: THREE_DAYS_AGO });
  const { json } = await callNudges("p1");
  assert.deepEqual(
    json.nudges.map((n) => n.stepId),
    ["s3"],
    "one step's cooldown must not suppress another step's first nudge",
  );
  assert.equal(json.suppressedCount, 2, "s1 and s2 are still inside their own windows");
});

await check("once the cooldown window passes, the same step is nudged again", async () => {
  await ageNudgePastCooldown("s1");
  const { json } = await callNudges("p1");
  assert.deepEqual(
    json.nudges.map((n) => n.stepId),
    ["s1"],
    "s1 is past its window; s2 and s3 are not",
  );
  const refreshed = await nudgedAt("s1");
  assert.ok(refreshed !== null && Date.now() - new Date(refreshed).getTime() < 60_000, "the new nudge refreshes s1's timestamp");
});

// --- budget: the second load must not pay the LLM again ---------------------

let llmCalls = 0;
const countingLlm = new HeuristicFakeLlmClient(() => {
  llmCalls += 1;
  return JSON.stringify({ message: "personalized nudge from the test double" });
});

await seedProgram({ orgId: "org-2", programId: "p2", initiativeId: "i2", initiativeTitle: "Rework the welcome process" });
await addOverdueStep({ stepId: "s4", initiativeId: "i2", description: "Rewrite the welcome email", dueDate: FIVE_DAYS_AGO });

await check("a personalized nudge reaches the dashboard once, and the next load spends nothing", async () => {
  const first = await generateNudgesForProgram(env, "p2", { llm: countingLlm });
  assert.equal(first.personalized, true);
  assert.deepEqual(
    first.nudges.map((n) => n.stepId),
    ["s4"],
  );
  assert.equal(first.nudges[0]?.message, "personalized nudge from the test double");
  assert.equal(llmCalls, 1, "the first load makes exactly one LLM call");

  const second = await generateNudgesForProgram(env, "p2", { llm: countingLlm });
  assert.deepEqual(second.nudges, [], "the second load is suppressed");
  assert.equal(llmCalls, 1, "the second load must not re-spend on the LLM");

  await ageNudgePastCooldown("s4");
  const third = await generateNudgesForProgram(env, "p2", { llm: countingLlm });
  assert.deepEqual(
    third.nudges.map((n) => n.stepId),
    ["s4"],
    "after the window, the step is nudged again",
  );
  assert.equal(llmCalls, 2, "re-nudging after the window costs exactly one more call");
});

console.log(`\n${checksRun} check(s) passed.`);
if (failures > 0) {
  console.error(`COACH THROTTLE TESTS FAILED (${failures} failure(s))`);
  process.exitCode = 1;
} else {
  console.log("ALL COACH THROTTLE TESTS PASSED");
}
