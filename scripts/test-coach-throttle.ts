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
//
// Wave 1.2 adds the write-boundary checks near the bottom: the COACH input
// caps (initiative title 200 / step description 500) must cut on a Unicode
// boundary, log the cut exactly once with the omitted count, and report it in
// the 201 without changing the existing { id } contract for within-cap text.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Env } from "../src/index.ts";
import { handleProgramRoute } from "../src/program/routes.ts";
import { COACH_NUDGE_COOLDOWN_MS, MAX_NUDGE_PROMPT_CHARS, generateNudgesForProgram } from "../src/program/coach.ts";
import { MAX_INITIATIVE_TITLE_CHARS, MAX_STEP_DESCRIPTION_CHARS, truncateChars } from "../src/program/initiatives.ts";
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
  /** Statements prepared against the throttle's table. Lets a check prove the
   * store was genuinely consulted instead of inferring it from a response. */
  readonly stats = { coachNudgeStatements: 0 };

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string): SqlitePreparedStatement {
    if (sql.includes("coach_nudge")) this.stats.coachNudgeStatements += 1;
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
  error?: string;
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
async function callNudges(
  programId: string,
  init?: { search?: string; body?: unknown; env?: Env },
): Promise<{ status: number; json: CoachNudgesBody; retryAfter: string | null }> {
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
  const response = await handleProgramRoute(request, init?.env ?? env, url);
  assert.ok(response, "the program router must handle POST /program/:id/coach/nudges");
  return {
    status: response.status,
    json: (await response.json()) as CoachNudgesBody,
    retryAfter: response.headers.get("Retry-After"),
  };
}

/** Simulates the deploy-order hazard: the Worker is live but
 * `wrangler d1 migrations apply groundwork` has not run yet, so every query
 * against the throttle's table fails the way D1 fails on a missing table.
 * Every other table still works — that is what makes this case distinct from
 * a genuinely broken database. */
class MissingCoachNudgeTableD1 {
  private readonly inner: FakeD1;

  constructor(inner: FakeD1) {
    this.inner = inner;
  }

  prepare(sql: string): unknown {
    if (sql.includes("coach_nudge")) {
      const missing = async (): Promise<never> => {
        throw new Error("D1_ERROR: no such table: coach_nudge: SQLITE_ERROR");
      };
      const statement = { bind: () => statement, first: missing, all: missing, run: missing };
      return statement;
    }
    return this.inner.prepare(sql);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }
}

/** The dashboard's step form: POST /initiative/:id/step, dev auth headers. */
async function callAddStep(
  initiativeId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { id?: string; truncated?: boolean; storedLength?: number; error?: string } }> {
  const url = new URL(`https://groundwork.test/initiative/${initiativeId}/step`);
  const request = new Request(url, {
    method: "POST",
    headers: {
      "X-Groundwork-Dev-User": LEADER_EMAIL,
      "X-Groundwork-Dev-Sub": "dev-sub-0001",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const response = await handleProgramRoute(request, env, url);
  assert.ok(response, "the program router must handle POST /initiative/:id/step");
  return {
    status: response.status,
    json: (await response.json()) as { id?: string; truncated?: boolean; storedLength?: number; error?: string },
  };
}

/** The New initiative form: POST /program/:id/initiative, dev auth headers. */
async function callCreateInitiative(
  programId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { id?: string; truncated?: boolean; storedLength?: number; error?: string } }> {
  const url = new URL(`https://groundwork.test/program/${programId}/initiative`);
  const request = new Request(url, {
    method: "POST",
    headers: {
      "X-Groundwork-Dev-User": LEADER_EMAIL,
      "X-Groundwork-Dev-Sub": "dev-sub-0001",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const response = await handleProgramRoute(request, env, url);
  assert.ok(response, "the program router must handle POST /program/:id/initiative");
  return {
    status: response.status,
    json: (await response.json()) as { id?: string; truncated?: boolean; storedLength?: number; error?: string },
  };
}

/** Pinned deliberately: the write boundary must log every cut under a
 * greppable [program-truncation] prefix, same convention as the guide loop's
 * [guide-error] lines. If the prefix is ever renamed, update this pin in the
 * same change — the grep-ability is the contract, not the word. */
const TRUNCATION_LOG_PREFIX_PINNED = "[program-truncation]";

function truncationLogLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes(TRUNCATION_LOG_PREFIX_PINNED));
}

/** Runs `fn` with console.log/warn/error captured, so a check can assert what
 * the server logged without letting those lines into the test output. */
async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

async function stepDescription(stepId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT description FROM initiative_step WHERE id = ?1`)
    .bind(stepId)
    .first<{ description: string }>();
  return row?.description ?? null;
}

async function initiativeTitle(initiativeId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT title FROM initiative WHERE id = ?1`)
    .bind(initiativeId)
    .first<{ title: string }>();
  return row?.title ?? null;
}

/** Records the exact user message of every nudge prompt that reaches a model. */
const capturedPrompts: string[] = [];
const capturingLlm = new HeuristicFakeLlmClient((params) => {
  capturedPrompts.push(params.messages[0]?.content ?? "");
  return JSON.stringify({ message: "captured nudge" });
});

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

// This check used to read "refreshing with a cache-buster and a force flag is
// still suppressed" and merely repeated the previous check — the route reads
// no client parameters, so it passed by construction and would have kept
// passing if a refactor started honouring a flag. It now asserts the real
// invariant instead: a suppressed load must (1) return no nudges even when
// the request carries arbitrary fields and params, (2) report the
// server-side suppression count, and (3) actually query the throttle store —
// so "no nudges" cannot mean "never looked".
await check("a suppressed step stays suppressed under arbitrary client fields/params, and the store is consulted", async () => {
  const queriesBefore = db.stats.coachNudgeStatements;
  const { status, json } = await callNudges("p1", {
    search: "?nocache=1&force=true&bypassThrottle=1&refresh=now&stepIds=s1,s2&nudgeAgain=1",
    body: {
      force: true,
      refresh: true,
      bypassThrottle: true,
      skipCooldown: true,
      cooldownMs: 0,
      cacheBuster: 1_700_000_000_000,
      limit: 999,
      stepIds: ["s1", "s2"],
      nudges: [],
    },
  });
  assert.equal(status, 200);
  assert.deepEqual(
    json.nudges,
    [],
    "no client-supplied parameter or body field may bypass the server-side throttle",
  );
  assert.equal(
    json.suppressedCount,
    2,
    "s1 and s2 must be reported as suppressed — a route that skipped the cooldown filter after seeing a client flag would report 0",
  );
  assert.ok(
    db.stats.coachNudgeStatements > queriesBefore,
    "the throttle store must actually be queried on a suppressed load — otherwise 'no nudges' could just mean the route never looked",
  );
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

// --- prompt ceiling: the uncapped stored field (reviewer finding 1) ---------

await seedProgram({ orgId: "org-3", programId: "p3", initiativeId: "i3", initiativeTitle: "Rebuild the volunteer pipeline" });

// ~600 KB, the scale an authenticated member can POST today. The marker lets
// any assertion prove the tail was actually cut, not merely shortened.
const OVERSIZED_DESCRIPTION = "N".repeat(600_000) + "END_OF_OVERSIZED_BODY";

await check("an oversized description cannot produce an oversized nudge prompt", async () => {
  const posted = await callAddStep("i3", { description: OVERSIZED_DESCRIPTION, dueDate: FIVE_DAYS_AGO });
  assert.equal(
    posted.status,
    201,
    "the cap must truncate, not reject — the web client's step input has no length limit of its own",
  );
  assert.ok(posted.json.id, "the step must still be created");

  const stored = await stepDescription(posted.json.id!);
  assert.ok(stored !== null, "the step row must exist");
  assert.equal(
    stored,
    OVERSIZED_DESCRIPTION.slice(0, MAX_STEP_DESCRIPTION_CHARS),
    `stored description must be the first ${MAX_STEP_DESCRIPTION_CHARS} chars of the submission`,
  );

  capturedPrompts.length = 0;
  await generateNudgesForProgram(env, "p3", { llm: capturingLlm });
  assert.equal(capturedPrompts.length, 1, "the one overdue step gets exactly one prompt");
  assert.ok(
    capturedPrompts[0].length <= MAX_NUDGE_PROMPT_CHARS,
    `nudge prompt must be capped at ${MAX_NUDGE_PROMPT_CHARS} chars, got ${capturedPrompts[0].length}`,
  );
});

await seedProgram({ orgId: "org-4", programId: "p4", initiativeId: "i4", initiativeTitle: "Rework the welcome process" });

// Inserted straight into the table — this is the row that already exists when
// the cap ships, i.e. the one the write boundary never saw.
const LEGACY_OVERSIZED = "L".repeat(200_000) + "TAIL_MARKER_NEVER_IN_PROMPT";
await addOverdueStep({ stepId: "s5", initiativeId: "i4", description: LEGACY_OVERSIZED, dueDate: FIVE_DAYS_AGO });

await check("an oversized stored row is truncated in the prompt, and the stored value is untouched", async () => {
  capturedPrompts.length = 0;
  await generateNudgesForProgram(env, "p4", { llm: capturingLlm });
  assert.equal(capturedPrompts.length, 1, "the one overdue step gets exactly one prompt");

  const prompt = capturedPrompts[0];
  assert.ok(
    prompt.length <= MAX_NUDGE_PROMPT_CHARS,
    `a legacy oversized row must not blow the prompt ceiling (got ${prompt.length} chars)`,
  );
  assert.ok(prompt.includes("L".repeat(50)), "the head of the stored description must still reach the prompt");
  assert.ok(
    !prompt.includes("TAIL_MARKER_NEVER_IN_PROMPT"),
    "text past the ceiling must never be shipped to the model",
  );
  assert.equal(
    await stepDescription("s5"),
    LEGACY_OVERSIZED,
    "building the prompt must not mutate the stored row — the cap is read-side only",
  );
});

// --- the normal path must be untouched, byte for byte ------------------------

await seedProgram({ orgId: "org-5", programId: "p5", initiativeId: "i5", initiativeTitle: "Contact the lapsed volunteers" });
const NORMAL_DESCRIPTION = "Draft the team's follow-up email and confirm the 9:00 a.m. slot";
await addOverdueStep({ stepId: "s6", initiativeId: "i5", description: NORMAL_DESCRIPTION, dueDate: THREE_DAYS_AGO });

await check("a normal description is unchanged byte-for-byte in the prompt", async () => {
  capturedPrompts.length = 0;
  await generateNudgesForProgram(env, "p5", { llm: capturingLlm });
  assert.equal(capturedPrompts.length, 1, "the one overdue step gets exactly one prompt");
  assert.ok(
    capturedPrompts[0].includes(`Overdue step: "${NORMAL_DESCRIPTION}"`),
    "a within-cap description must reach the prompt exactly as stored — no trimming, no escaping, no marker",
  );
  assert.ok(
    capturedPrompts[0].includes(`Initiative: "Contact the lapsed volunteers"`),
    "a within-cap title is likewise unchanged",
  );
});

// The template path (no LLM key configured) reads the same stored field, so
// the same oversized row must not produce an oversized dashboard message.
const OVERSIZED_FALLBACK = "F".repeat(150_000) + "FALLBACK_TAIL_MARKER";
await addOverdueStep({ stepId: "s7", initiativeId: "i5", description: OVERSIZED_FALLBACK, dueDate: THREE_DAYS_AGO });

await check("the template fallback stays bounded for an oversized stored row", async () => {
  const result = await generateNudgesForProgram(env, "p5", { llm: null });
  assert.deepEqual(result.nudges.map((n) => n.stepId), ["s7"], "s6 was nudged; only the new oversized step goes out");

  const message = result.nudges[0]?.message ?? "";
  assert.ok(
    message.length <= MAX_NUDGE_PROMPT_CHARS,
    `the fallback message must stay under the nudge ceiling too (got ${message.length} chars)`,
  );
  assert.ok(!message.includes("FALLBACK_TAIL_MARKER"), "text past the ceiling must not reach the dashboard");
  assert.equal(await stepDescription("s7"), OVERSIZED_FALLBACK, "the fallback path must not mutate the stored row either");
});

// --- write-boundary truncation: Unicode-safe, observable, honest -----------
//
// Wave 1.2. The write boundary (src/program/initiatives.ts) cuts text at the
// cap, but the cut used to be silent and could land between the two halves of
// a surrogate pair, storing ill-formed UTF-16. The checks below pin the three
// fixes: the cut is surrogate-safe (a valid Unicode prefix), it is logged once
// with the omitted character count, and the 201 tells the caller it happened.

/** Index of the first ill-formed (unpaired) surrogate code unit, or null when
 * the string is well-formed UTF-16. */
function firstLoneSurrogate(text: string): number | null {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return i;
      i += 1; // a complete pair; skip its low half
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return i; // a low surrogate with no high half before it
    }
  }
  return null;
}

await check("truncateChars never splits a surrogate pair and returns a prefix of the input", () => {
  // "ab😀cd": the emoji occupies code units 2 and 3; a cap of 3 lands inside it.
  assert.equal(
    truncateChars("ab😀cd", 3),
    "ab",
    "a cap landing between the halves of a pair must drop the orphaned high surrogate, not store half a character",
  );
  assert.equal(truncateChars("ab😀cd", 4), "ab😀", "a cap landing after the pair must keep it whole");
  assert.equal(truncateChars("ab😀cd", 6), "ab😀cd", "within-cap text is returned byte for byte");
  for (const [input, max] of [["ab😀cd", 3], ["ab😀cd", 4], ["🙂🙂🙂", 3], ["🙂🙂🙂", 1]] as const) {
    const out = truncateChars(input, max);
    assert.ok(out.length <= max, `the cap must still hold for ${JSON.stringify(input)} at ${max}`);
    assert.equal(
      firstLoneSurrogate(out),
      null,
      `truncateChars(${JSON.stringify(input)}, ${max}) must return well-formed UTF-16, got ${JSON.stringify(out)}`,
    );
    assert.ok(input.startsWith(out), "the result must be a prefix of the input");
  }
});

await seedProgram({ orgId: "org-6", programId: "p6", initiativeId: "i6", initiativeTitle: "Keep the welcome process honest" });

await check("a description with an emoji straddling the write boundary stores a valid Unicode prefix", async () => {
  // 499 ASCII chars, then the emoji's two halves land exactly across the
  // 500-char cap. The pre-fix slice kept the high half — ill-formed UTF-16.
  const straddling = "A".repeat(MAX_STEP_DESCRIPTION_CHARS - 1) + "😀" + "TAIL_AFTER_THE_CUT";
  const posted = await callAddStep("i6", { description: straddling });
  assert.equal(posted.status, 201);
  const stored = await stepDescription(posted.json.id!);
  assert.ok(stored !== null, "the step row must exist");
  assert.equal(
    stored,
    "A".repeat(MAX_STEP_DESCRIPTION_CHARS - 1),
    "the cut must back off one code unit rather than store half a surrogate pair",
  );
  assert.equal(firstLoneSurrogate(stored), null, "the stored value must be well-formed UTF-16");
  assert.ok(straddling.startsWith(stored), "the stored value must be a prefix of the submission");
});

// ~600 KB, the scale an authenticated member can POST. The tail marker lets
// any assertion prove the cut was at the cap, not somewhere arbitrary.
const OVERSIZED_STEP_BODY = "R".repeat(600_000) + "OMITTED_TAIL_MARKER";

await check("an oversized step POST reports the cut in the 201 and logs it exactly once", async () => {
  const { result: posted, lines } = await captureConsole(() =>
    callAddStep("i6", { description: OVERSIZED_STEP_BODY }),
  );
  assert.equal(posted.status, 201, "the cap must truncate, not reject");
  assert.ok(posted.json.id, "the step must still be created");
  assert.equal(
    posted.json.truncated,
    true,
    "the 201 must carry a truncation signal — a caller that only sees {id} cannot tell it lost text",
  );
  assert.equal(
    posted.json.storedLength,
    MAX_STEP_DESCRIPTION_CHARS,
    "the 201 must carry the length actually stored",
  );
  assert.equal(
    await stepDescription(posted.json.id!),
    OVERSIZED_STEP_BODY.slice(0, MAX_STEP_DESCRIPTION_CHARS),
    "the write-path cap must still hold",
  );

  const truncations = truncationLogLines(lines);
  assert.equal(
    truncations.length,
    1,
    `the cut must be logged exactly once per request — got ${truncations.length} line(s)`,
  );
  assert.ok(
    truncations[0]?.includes(`omitted=${OVERSIZED_STEP_BODY.length - MAX_STEP_DESCRIPTION_CHARS}`),
    `the log must carry the omitted character count (got: ${truncations[0] ?? "nothing logged"})`,
  );
  assert.ok(
    truncations[0]?.includes(`stored=${MAX_STEP_DESCRIPTION_CHARS}`),
    "the log must say how much was kept",
  );
});

const WITHIN_CAP_STEP_BODY = "C".repeat(MAX_STEP_DESCRIPTION_CHARS - 20);

await check("a within-cap step POST is unchanged: no signal, no log, stored byte-identical", async () => {
  const { result: posted, lines } = await captureConsole(() =>
    callAddStep("i6", { description: WITHIN_CAP_STEP_BODY }),
  );
  assert.equal(posted.status, 201);
  assert.deepEqual(
    Object.keys(posted.json),
    ["id"],
    "a within-cap POST must keep the exact existing response shape — the signal is additive and only for cuts",
  );
  assert.equal(
    await stepDescription(posted.json.id!),
    WITHIN_CAP_STEP_BODY,
    "within-cap text must be stored byte for byte",
  );
  assert.equal(
    truncationLogLines(lines).length,
    0,
    "a within-cap write must not log anything that greps like a truncation",
  );
});

const OVERSIZED_TITLE = "T".repeat(1_000) + "TITLE_TAIL_MARKER";

await check("an oversized initiative title is cut, reported and logged the same way", async () => {
  const { result: created, lines } = await captureConsole(() =>
    callCreateInitiative("p6", { title: OVERSIZED_TITLE, whyNow: "The welcome process keeps slipping." }),
  );
  assert.equal(created.status, 201, "the cap must truncate, not reject");
  assert.ok(created.json.id, "the initiative must still be created");
  assert.equal(created.json.truncated, true, "the 201 must carry the truncation signal for the title too");
  assert.equal(created.json.storedLength, MAX_INITIATIVE_TITLE_CHARS, "the 201 must carry the stored title length");
  assert.equal(
    await initiativeTitle(created.json.id!),
    "T".repeat(MAX_INITIATIVE_TITLE_CHARS),
    "the title cap must hold on the write path",
  );

  const truncations = truncationLogLines(lines);
  assert.equal(truncations.length, 1, `the title cut must be logged exactly once — got ${truncations.length} line(s)`);
  assert.ok(
    truncations[0]?.includes(`omitted=${OVERSIZED_TITLE.length - MAX_INITIATIVE_TITLE_CHARS}`),
    `the log must carry the omitted character count (got: ${truncations[0] ?? "nothing logged"})`,
  );
});

// --- deploy order: missing migration must fail soft, not 500 ----------------

await check("a missing coach_nudge table (migration not yet applied) returns 503, not an exception", async () => {
  const preMigrationEnv = { DB: new MissingCoachNudgeTableD1(db) } as unknown as Env;
  const { status, json, retryAfter } = await callNudges("p1", { env: preMigrationEnv });
  assert.equal(
    status,
    503,
    "a Worker that deployed ahead of `wrangler d1 migrations apply` must degrade to 503 — an unhandled throw 500s every dashboard load",
  );
  assert.ok(
    typeof json.error === "string" && json.error.length > 0,
    "the 503 body must carry a human-readable error",
  );
  assert.ok(
    /migration|not applied|not ready|not available/i.test(json.error),
    `the 503 body must say why (got: ${String(json.error)})`,
  );
  assert.equal(retryAfter, "60", "the 503 must tell the client when to retry");
});

console.log(`\n${checksRun} check(s) passed.`);
if (failures > 0) {
  console.error(`COACH THROTTLE TESTS FAILED (${failures} failure(s))`);
  process.exitCode = 1;
} else {
  console.log("ALL COACH THROTTLE TESTS PASSED");
}
