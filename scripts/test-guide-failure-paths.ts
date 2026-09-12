#!/usr/bin/env node --experimental-strip-types
// Guide failure-path tests — the silent-failure cluster in the SessionDO's
// guide loop (Build Staff findings, 2026-09-06, items 1/2/4/6; CRITIC
// wave-1.1 findings on the same cluster):
//
//   * failures must be OBSERVABLE: structured `[guide-error]` lines and
//     per-agent consecutive-failure counters persisted in DO storage (so
//     an eviction cannot silently reset a backing-off agent),
//   * a boundary synthesis blocked by the in-flight mutex must not vanish:
//     it is stashed (durably) and run from the in-flight work's finally()
//     or the next alarm tick — and never twice,
//   * a persistently failing agent must back off (2x, 4x, ... capped 5 min)
//     instead of re-spending on the 30s cadence,
//   * PACER's compress escalation is its ONLY paid call — a transport
//     failure there is recorded as a failure (it used to be swallowed and
//     booked as a success, so the skip gate could never trip and
//     lastSuccessAt lied) while the deterministic fallback still ships,
//   * a boundary pass consumed before its attempt is RE-STASHED when the
//     attempt fails — a transient provider failure used to silently cost
//     the segment its notes — and a persistent failure stays bounded by
//     the backoff (no livelock),
//   * a re-advance out of the same segment while its synthesis is already
//     in flight must not stash-and-double-run (duplicate spend, duplicate
//     room message, duplicate artifacts),
//   * stash discards (list bound, guide inactive) are logged, and the
//     stash survives a DO instance swap,
//   * a PROBER failure must not discard the already-paid EVALUATOR verdict
//     (the room still gets a deterministic probe built from it),
//   * guideClient() must reuse one client per DO instance — and the REAL
//     guide call path (not a shadowed accessor) must use that instance.
//
// CRITIC wave-1.2 findings closed here (money pump / dropped material /
// double fault / artifact duplication / smuggled detail change):
//
//   * a provenance verification failure is a designed HARD STOP: no re-stash,
//     no re-spend, exactly one honest notice (deduped by segment key),
//   * a same-segment boundary that carries submissions the in-flight pass
//     never snapshotted is still synthesized; a no-new-material boundary is
//     still skipped (the round-1 invariant),
//   * a fault in the health recorder cannot strand the re-stashed pass,
//   * a retried pass does not re-insert artifacts it already wrote
//     (idempotent per session/kind/content),
//   * the success-path probe detail is the evaluator's VERDICT again; only
//     the PROBER-fallback probe (new behavior by design) carries evidence.
//
// CRITIC wave-1.3 findings closed here (leader-edit fingerprint / episode
// marker durability / episode-clear coverage):
//
//   * a mid-flight leader EDIT of an already-stored submission (same count,
//     changed content) must re-stash a same-segment boundary — the in-flight
//     snapshot is compared by content fingerprint, not by a bare count,
//   * a successful pass clears the segment's failure episode, so a LATER
//     failure re-notices (the episode-clear had no covering check at all),
//   * the failure-notice episode marker is persisted in DO storage (one key,
//     no D1 table, no migration), so an eviction cannot re-open an episode the
//     room already saw.
//
// Runs the REAL SessionDO class under plain Node: "cloudflare:workers" is
// stubbed with an inline loader, the fake DurableObjectState drains
// ctx.waitUntil work deterministically, and the clock is injected so the
// 30s alarms / eval interval are simulated exactly.
import assert from "node:assert/strict";
import { register } from "node:module";

// ---- cloudflare:workers stub -------------------------------------------------
// session-do.ts imports the DurableObject base class from the Workers-only
// "cloudflare:workers" scheme. A resolve-only loader swaps in a Node stub so
// the real DO class (guide plumbing included) can run in this test.
const LOADER_SOURCE = [
  "export async function resolve(specifier, context, next) {",
  '  if (specifier === "cloudflare:workers") {',
  '    return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };',
  "  }",
  "  return next(specifier, context);",
  "}",
].join("\n");
register("data:text/javascript," + encodeURIComponent(LOADER_SOURCE));

const { SessionDO } = await import("../src/session-do.ts");
const { FAKE_LAB_SEGMENTS } = await import("../src/session-protocol.ts");
const { EvaluatorParseError } = await import("../src/guide-engine/evaluator.ts");
const { ProberParseError } = await import("../src/guide-engine/prober.ts");
const { LlmTimeoutError } = await import("../src/guide-engine/llm-client.ts");
const { specFor } = await import("../src/guide-engine/session-guide.ts");

const SEGMENT = FAKE_LAB_SEGMENTS[0].key; // "welcome" — 2 min, generic spec

// ---- injected clock ----------------------------------------------------------
const REAL_NOW = Date.now;
let fakeNow = REAL_NOW();
Date.now = () => fakeNow;
function resetClock(): void {
  fakeNow = REAL_NOW();
}
function advanceClock(ms: number): void {
  fakeNow += ms;
}

// ---- fakes -------------------------------------------------------------------
interface FakeSocket {
  role: string;
  clientId: string;
  sent: string[];
  deserializeAttachment(): { role: string; clientId: string };
  send(data: string): void;
}

function makeSocket(role: string, clientId: string): FakeSocket {
  return {
    role,
    clientId,
    sent: [],
    deserializeAttachment: () => ({ role, clientId }),
    send(data: string) {
      this.sent.push(data);
    },
  };
}

type StoredMap = Map<string, unknown>;

function makeFakeCtx(sessionKey: string, storage: StoredMap = new Map(), putFault?: (key: string) => boolean) {
  const waitUntilTasks: Promise<unknown>[] = [];
  const sockets: FakeSocket[] = [];
  return {
    id: { name: sessionKey, toString: () => sessionKey },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        if (putFault?.(key)) throw new Error(`injected storage.put fault for '${key}'`);
        storage.set(key, value);
      },
      delete: async (key: string) => storage.delete(key),
      getAlarm: async () => null,
      setAlarm: async (_time: number) => {},
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
    acceptWebSocket: (ws: FakeSocket) => {
      sockets.push(ws);
    },
    getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.role === tag) : sockets),
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilTasks.push(promise);
    },
    __storage: storage,
    __sockets: sockets,
    /** Settle every ctx.waitUntil promise, including ones registered while
     * draining (deferred synthesis runs start nested work). */
    __drain: async () => {
      while (waitUntilTasks.length > 0) {
        const batch = waitUntilTasks.splice(0);
        await Promise.allSettled(batch);
      }
    },
  };
}

interface FakeArtifactRow {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  version: number;
  superseded_by: string | null;
  provenance_json: string;
  created_at: string;
}

/** D1 stand-in that also emulates the session_plan_artifact TABLE, so the
 * partial-save-retry check can assert on ROWS instead of statement counts.
 * Only the statements plan-artifact-store.ts actually issues are interpreted
 * (SELECT id/version, SELECT id, INSERT, UPDATE superseded_by); everything
 * else behaves like the bare stub did. */
function makeFakeDb() {
  const statements: { sql: string; args: unknown[] }[] = [];
  const artifactRows: FakeArtifactRow[] = [];
  let artifactInsertCount = 0;
  let failArtifactInsertNumber: number | null = null;
  function statement(sql: string, args: unknown[] = []): unknown {
    return {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => {
        if (sql.includes("FROM session_plan_artifact")) {
          if (sql.includes("SELECT id, version")) {
            const [sessionId, kind] = args as [string, string];
            const live = artifactRows.filter((r) => r.session_id === sessionId && r.kind === kind && r.superseded_by === null);
            return live.length ? live.reduce((a, b) => (a.version >= b.version ? a : b)) : null;
          }
          if (sql.includes("SELECT id FROM")) {
            const [sessionId, kind, content] = args as [string, string, string];
            return (
              artifactRows.find((r) => r.session_id === sessionId && r.kind === kind && r.content === content && r.superseded_by === null) ?? null
            );
          }
        }
        return null;
      },
      all: async () => ({ results: [] as unknown[] }),
      run: async () => {
        statements.push({ sql, args });
        if (sql.includes("INSERT INTO session_plan_artifact")) {
          artifactInsertCount += 1;
          if (failArtifactInsertNumber !== null && artifactInsertCount === failArtifactInsertNumber) {
            failArtifactInsertNumber = null; // one-shot partial-save fault; the retry must succeed
            throw new Error("D1_ERROR: injected artifact-insert fault (partial save)");
          }
          const [id, sessionId, kind, content, version, provenanceJson, createdAt] = args as [
            string,
            string,
            string,
            string,
            number,
            string,
            string,
          ];
          artifactRows.push({ id, session_id: sessionId, kind, content, version, superseded_by: null, provenance_json: provenanceJson, created_at: createdAt });
        } else if (sql.includes("UPDATE session_plan_artifact SET superseded_by")) {
          const [newId, existingId] = args as [string, string];
          const row = artifactRows.find((r) => r.id === existingId);
          if (row) row.superseded_by = newId;
        }
        return { success: true };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql),
    __statements: statements,
    __artifactRows: artifactRows,
    __failArtifactInsertOnce: (n: number) => {
      failArtifactInsertNumber = n;
    },
  };
}

type HarnessOptions = { sessionKey?: string; storage?: StoredMap; putFault?: (key: string) => boolean };

function makeHarness(options: HarnessOptions = {}) {
  const ctx = makeFakeCtx(options.sessionKey ?? "guide-failure-test", options.storage, options.putFault);
  const db = makeFakeDb();
  const env = {
    ANTHROPIC_API_KEY: "test-key-not-a-real-secret",
    GUIDE_ENABLED: "true",
    DB: db,
  };
  const inst = new SessionDO(ctx as never, env as never);
  const waitReady = () => Reflect.get(inst, "ready") as Promise<void>;
  return { inst, ctx, env, db, waitReady };
}

interface LlmCallRecord {
  system: string;
  content: string;
}

/** Duck-typed LlmClient with per-agent scripted responses. */
class ScriptedLlmClient {
  readonly calls: LlmCallRecord[] = [];
  private readonly handler: (system: string, content: string) => string | Promise<string>;

  constructor(handler: (system: string, content: string) => string | Promise<string>) {
    this.handler = handler;
  }

  async complete(params: { system: string; messages: { role: string; content: string }[] }): Promise<{ text: string }> {
    const content = params.messages[0]?.content ?? "";
    this.calls.push({ system: params.system, content });
    return { text: await this.handler(params.system, content) };
  }

  countFor(agentMarker: string): number {
    return this.calls.filter((call) => call.system.includes(agentMarker)).length;
  }
}

/** Shadow the DO's client accessor so the whole guide path runs on the fake
 * transport. (guideClient() itself — the caching seam — is checked directly.) */
function injectLlm(inst: unknown, llm: ScriptedLlmClient): void {
  Reflect.set(inst, "guideClient", () => llm);
}

function readState(inst: unknown): {
  guideLog?: { kind: string; text: string; segmentKey: string; detail?: string }[];
  currentSegmentIndex: number;
  segmentStartedAt: string;
} {
  return Reflect.get(inst, "state");
}

/** The durable boundary-pass stash (oldest first). */
function readPending(inst: unknown): string[] {
  return Reflect.get(inst, "pendingSynthesisKeys") ?? [];
}

interface AgentHealth {
  consecutiveFailures: number;
  skipUntilMs: number;
  totalFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

function readHealth(inst: unknown): Partial<Record<string, AgentHealth>> {
  return Reflect.get(inst, "guideHealth") ?? {};
}

/** Let queued microtasks run (the guide work awaits a few resolved fake
 * promises before it reaches the LLM call). A macrotask flushes them all. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  return {
    logs,
    errors,
    restore: () => {
      console.log = realLog;
      console.error = realError;
    },
  };
}

function evaluatorVerdictJson(content: string, verdict: string): string {
  // The rubric arrives inside the user content; echo a rubric id so
  // weakest_criterion passes the cross-check regardless of which spec resolved.
  const match = content.match(/Rubric \(JSON, authoritative for this segment only\):\n([\s\S]*?)\n\n/);
  const rubric = match ? (JSON.parse(match[1]) as { id: string }[]) : [];
  const weakest = rubric[0]?.id ?? "specific";
  return JSON.stringify({
    verdict,
    per_criterion_scores: rubric.map((r) => ({ id: r.id, score: 0.4, note: "scripted" })),
    weakest_criterion: weakest,
    evidence: "scripted evidence",
  });
}

const SUBMISSION_ONE = "The roof repair is due in March and costs $14k.";
const SUBMISSION_TWO = "We could communicate better about maintenance.";

function validSynthesisJson(): string {
  return JSON.stringify({
    artifacts: [
      {
        kind: "risk",
        content: "The roof repair is due in March and carries a $14k cost.",
        provenance: [{ type: "submission", index: 0, quote: "roof repair is due in March" }],
      },
    ],
  });
}

function fabricatedSynthesisJson(): string {
  return JSON.stringify({
    artifacts: [
      {
        kind: "vision",
        content: "Something the room never said.",
        provenance: [{ type: "submission", index: 0, quote: "quote that appears nowhere in the input" }],
      },
    ],
  });
}

// ---- check runner ------------------------------------------------------------
let passed = 0;
let total = 0;
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  total += 1;
  try {
    await fn();
    console.log(`PASS: ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ==============================================================================
// 1) EVALUATOR money pump: persistent parse failure must be bounded by backoff
//    and every failure must be logged + counted.
// ==============================================================================
await check("evaluator: persistent parse failure re-spends are bounded by backoff (logged + counted)", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "eval-money-pump" });
  const llm = new ScriptedLlmClient(() => {
    throw new EvaluatorParseError("EVALUATOR returned non-JSON output: {not json");
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "phone-1");
  const cap = captureConsole();
  try {
    // One submission every 30s for 50 minutes — the exact cadence at which the
    // old code re-spent a paid call on every new submission, forever.
    for (let i = 0; i < 100; i++) {
      advanceClock(i === 0 ? 0 : 30_000);
      await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: `uuid-${i}`, content: `Submission number ${i}` }));
      await ctx.__drain();
    }
  } finally {
    cap.restore();
  }
  const errorLines = cap.errors.filter((line) => line.includes("[guide-error] agent=evaluator"));
  const health = readHealth(inst).evaluator;
  console.log(`  [measured] submissions=100 over 50 min simulated; evaluator LLM calls=${llm.calls.length}; errorLogs=${errorLines.length}; consecutive=${health?.consecutiveFailures}`);
  assert.ok(llm.calls.length <= 20, `expected backoff to bound paid attempts (<=20), got ${llm.calls.length}`);
  assert.ok(llm.calls.length >= 2, "the agent must still retry after the backoff, just not hot-loop");
  assert.ok(errorLines.length >= 3, `every failure must be observable, got ${errorLines.length} [guide-error] lines`);
  assert.ok(errorLines[0].includes("retryInMs=60000"), `first failure should skip one doubled tick: ${errorLines[0]}`);
  assert.ok(errorLines[0].includes("EVALUATOR returned non-JSON output"), "the log must carry the parse-error detail");
  assert.ok(health && health.consecutiveFailures >= 3, "consecutive-failure counter must be tracked");
  assert.ok(health && health.totalFailures >= 3, "total-failure counter must be tracked");
  assert.ok(health && health.skipUntilMs > fakeNow, "the agent must be inside its backoff window");
});

// ==============================================================================
// 2) Counters survive a DO instance swap (storage-backed, not instance memory).
// ==============================================================================
await check("evaluator: failure counters survive a DO instance swap (eviction-safe)", async () => {
  resetClock();
  const storage: StoredMap = new Map();
  const first = makeHarness({ sessionKey: "eval-eviction", storage });
  const llm = new ScriptedLlmClient(() => {
    throw new EvaluatorParseError("EVALUATOR returned non-JSON output: {still not json");
  });
  injectLlm(first.inst, llm);
  const phone = makeSocket("phone", "phone-2");
  for (const i of [0, 1]) {
    await first.inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: `e-${i}`, content: `Submission ${i}` }));
    await first.ctx.__drain();
    advanceClock(30_000);
  }
  const before = readHealth(first.inst).evaluator;
  assert.ok(before && before.consecutiveFailures >= 1, "precondition: one failure recorded");
  // Eviction: a NEW instance over the SAME durable storage.
  const second = makeHarness({ sessionKey: "eval-eviction", storage });
  await second.waitReady();
  const after = readHealth(second.inst).evaluator;
  console.log(`  [measured] consecutiveFailures before=${before?.consecutiveFailures} after instance swap=${after?.consecutiveFailures}`);
  assert.ok(after, "guide health must be restored from DO storage");
  assert.equal(after.consecutiveFailures, before.consecutiveFailures, "an evicted-and-revived agent keeps its failure streak");
  assert.ok(after.skipUntilMs > fakeNow, "and stays inside its backoff window");
});

// ==============================================================================
// 3) Backoff skip window blocks retries; success resets and logs the verdict.
// ==============================================================================
await check("evaluator: skip window blocks retries, resets on success, verdict logged", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "eval-backoff-window" });
  let mode: "fail" | "ok" = "fail";
  const llm = new ScriptedLlmClient((system, content) => {
    if (system.includes("EVALUATOR")) {
      if (mode === "fail") throw new EvaluatorParseError("EVALUATOR returned non-JSON output: {bad");
      return evaluatorVerdictJson(content, "on_track");
    }
    throw new Error("unexpected agent prompt in this check");
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "phone-3");
  const submit = async (index: number) => {
    await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: `w-${index}`, content: `Window submission ${index}` }));
    await ctx.__drain();
  };
  const cap = captureConsole();
  let retryValues: (string | undefined)[] = [];
  try {
    advanceClock(0);
    await submit(0);
    advanceClock(30_000);
    await submit(1); // attempt 1 — fails; skip window opens (60s)
    assert.equal(llm.calls.length, 1, "first eligible tick spends once");
    advanceClock(30_000);
    await submit(2); // inside the 60s window — must NOT spend
    assert.equal(llm.calls.length, 1, "no paid retry inside the backoff window");
    advanceClock(35_000);
    await submit(3); // window expired — attempt 2
    assert.equal(llm.calls.length, 2, "the retry resumes after the window");
    retryValues = cap.errors
      .filter((line) => line.includes("[guide-error] agent=evaluator"))
      .map((line) => /retryInMs=(\d+)/.exec(line)?.[1]);
    mode = "ok";
    advanceClock(130_000);
    await submit(4); // attempt 3 — succeeds
  } finally {
    cap.restore();
  }
  const health = readHealth(inst).evaluator;
  const verdictLines = cap.logs.filter((line) => line.includes("[guide-verdict]") && line.includes("verdict=on_track"));
  console.log(`  [measured] retryInMs sequence=${JSON.stringify(retryValues)}; verdictLogs=${verdictLines.length}`);
  assert.deepEqual(retryValues, ["60000", "120000"], "skip must double on consecutive failures (2x, 4x)");
  assert.equal(llm.calls.length, 3, "three attempts: fail, fail, success");
  assert.ok(verdictLines.length >= 1, "a successful pass must leave a verdict record");
  assert.ok(health && health.consecutiveFailures === 0, "success resets the consecutive-failure streak");
  assert.ok(health && health.skipUntilMs === 0, "success clears the skip window");
});

// ==============================================================================
// 4) Boundary synthesis blocked by the in-flight mutex: stashed, run once.
// ==============================================================================
await check("boundary synthesis: stashed while busy, runs after, never double-runs", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "boundary-synthesis" });
  let resolveEvaluator: ((text: string) => void) | undefined;
  const evaluatorPending = new Promise<string>((resolve) => {
    resolveEvaluator = resolve;
  });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("EVALUATOR")) return evaluatorPending; // held open → mutex busy
    if (system.includes("SYNTHESIZER")) return validSynthesisJson();
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "phone-4");
  const screen = makeSocket("screen", "screen-1");

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "b-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "b-1", content: SUBMISSION_TWO }));
  await flush(); // the eval work reaches its (held-open) LLM call
  assert.equal(llm.calls.length, 1, "evaluation is in flight (mutex held)");

  // Boundary arrives while the evaluation owns the mutex.
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.equal(llm.countFor("SYNTHESIZER"), 0, "synthesis cannot start while the mutex is held");

  // In-flight work settles → the stashed boundary synthesis must run.
  resolveEvaluator!(evaluatorVerdictJson("", "on_track"));
  await ctx.__drain();
  const state = readState(inst);
  const synthesisMessages = (state.guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  console.log(`  [measured] synthesizer calls=${llm.countFor("SYNTHESIZER")}; synthesis messages=${synthesisMessages.length}`);
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "the stashed boundary synthesis must run exactly once");
  assert.equal(synthesisMessages.length, 1, "and its message must reach the room");
  assert.ok(synthesisMessages[0].text.includes("Draft plan notes"), "with the real synthesis copy");

  // A later alarm must not re-run the same boundary synthesis.
  await inst.alarm();
  await ctx.__drain();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "an already-completed synthesis must never double-run");
});

// ==============================================================================
// 5) Interleaved triggers (in-flight finally + alarm) — one pass per boundary.
// ==============================================================================
await check("boundary synthesis: interleaved triggers never double-run a stashed pass", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "boundary-race" });
  let resolveEvaluator: ((text: string) => void) | undefined;
  const evaluatorPending = new Promise<string>((resolve) => {
    resolveEvaluator = resolve;
  });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("EVALUATOR")) return evaluatorPending; // held open → mutex busy
    if (system.includes("SYNTHESIZER")) return validSynthesisJson();
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "phone-race");
  const screen = makeSocket("screen", "screen-race");
  const secondSegment = FAKE_LAB_SEGMENTS[1].key;

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "r-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "r-1", content: SUBMISSION_TWO }));
  await flush();
  // Two boundaries arrive while the evaluation owns the mutex → two stashed passes.
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: secondSegment, clientUuid: "r-2", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: secondSegment, clientUuid: "r-3", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));

  // Fire both retry triggers into the same microtask window.
  resolveEvaluator!(evaluatorVerdictJson("", "on_track"));
  const alarmPromise = inst.alarm();
  await alarmPromise;
  await ctx.__drain();
  // A third trigger after everything settled must be a no-op.
  await inst.alarm();
  await ctx.__drain();

  const log = readState(inst).guideLog ?? [];
  const perKey = (key: string) => log.filter((m) => m.kind === "synthesis" && m.segmentKey === key).length;
  console.log(`  [measured] synthesizer calls=${llm.countFor("SYNTHESIZER")}; synthesis messages: ${SEGMENT}=${perKey(SEGMENT)} ${secondSegment}=${perKey(secondSegment)}`);
  assert.equal(llm.countFor("SYNTHESIZER"), 2, "each stashed boundary pass runs exactly once");
  assert.equal(perKey(SEGMENT), 1, "first boundary's synthesis reaches the room once");
  assert.equal(perKey(secondSegment), 1, "second boundary's synthesis reaches the room once");
});

// ==============================================================================
// 6) guideClient(): one cached client per DO instance — and the REAL guide
//    call path must actually use that cached instance.
//
//    The identity assertion alone was decorative: every other check shadows
//    the accessor via injectLlm, so nothing proved the guide plumbing
//    exercised the cache. This check patches ONLY the transport method on
//    the cached instance (no accessor shadowing) and drives a real
//    evaluation through the real orchestration — if the DO built a fresh
//    client per action, the stub would never see the EVALUATOR call.
// ==============================================================================
await check("guideClient: the real guide call path uses the cached client instance", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "client-cache" });
  await (Reflect.get(inst, "ready") as Promise<void>);
  const cached = (inst as unknown as { guideClient(): unknown }).guideClient();
  assert.ok(cached, "client exists when the key is present and the guide is enabled");

  const calls: string[] = [];
  (cached as { complete: (params: { system: string; messages: { content: string }[] }) => Promise<{ text: string }> }).complete =
    async (params) => {
      calls.push(params.system);
      return { text: evaluatorVerdictJson(params.messages[0]?.content ?? "", "on_track") };
    };

  const phone = makeSocket("phone", "cache-phone");
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "c-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "c-1", content: SUBMISSION_TWO }));
  await ctx.__drain();

  const again = (inst as unknown as { guideClient(): unknown }).guideClient();
  console.log(`  [measured] guide LLM calls through the cached instance=${calls.length}; agent=${calls[0]?.includes("EVALUATOR") ? "EVALUATOR" : "other"}`);
  assert.ok(again === cached, "guideClient() must reuse the cached instance");
  assert.equal(calls.length, 1, "the real guide path must call complete() on the CACHED instance (not a fresh client)");
  assert.ok(calls[0].includes("EVALUATOR"), "and that call was the EVALUATOR pass");
});

// ==============================================================================
// 6b) PACER's compress-escalation failure (the REAL transport, not a synthetic
//     fault outside the LLM call): logged, counted, gated — and the fallback
//     text still reaches the room.
//
//     The pre-wave check injected its fault by shadowing buildGuideContext,
//     which proved only that a catch clause exists; the real escalation error
//     was swallowed inside runPacerTick and the tick was recorded as a
//     SUCCESS (consecutiveFailures stayed 0, the skip gate could never trip,
//     lastSuccessAt lied). This check drives PACER to its only LLM-requiring
//     decision (compress) with a throwing LlmClient.
// ==============================================================================
await check("pacer: a real compress-escalation failure is logged, counted, gated — fallback still ships", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "pacer-real-failure" });
  await (Reflect.get(inst, "ready") as Promise<void>);
  const llm = new ScriptedLlmClient(() => {
    throw new LlmTimeoutError(20_000, "claude-sonnet-5");
  });
  injectLlm(inst, llm);
  // Instrument (not fault-inject) the tick body: counts how often PACER
  // actually enters its tick. Delegates to the real implementation, so the
  // measured value is the real path's.
  let tickEntries = 0;
  const realBuildContext = Reflect.get(inst, "buildGuideContext") as (...args: unknown[]) => unknown;
  Reflect.set(inst, "buildGuideContext", (...args: unknown[]) => {
    tickEntries += 1;
    return realBuildContext.apply(inst, args);
  });
  // Drive to 'compress': warmup (planned 3 min) at 1.05x planned time with a
  // forward budget smaller than the segment, exit criteria unmet. All clock
  // state is the DO's real input, set through its real state object.
  const warmupSpec = specFor(FAKE_LAB_SEGMENTS[1]);
  const state = readState(inst);
  state.currentSegmentIndex = 1;
  state.segmentStartedAt = new Date(fakeNow - Math.round(warmupSpec.planned_minutes * 1.05 * 60_000)).toISOString();

  const cap = captureConsole();
  try {
    await inst.alarm(); // t+0 — compress → escalation attempted → transport fails
    await ctx.__drain();
    assert.equal(llm.countFor("PACER"), 1, "the compress escalation must actually be attempted (real transport)");

    const pacerErrors = cap.errors.filter((line) => line.includes("[guide-error] agent=pacer"));
    assert.equal(pacerErrors.length, 1, `the swallowed failure must now be logged: ${JSON.stringify(cap.errors)}`);
    assert.ok(pacerErrors[0].includes("consecutive=1"), "first failure records a consecutive count of 1");
    assert.ok(pacerErrors[0].includes("retryInMs=60000"), "and opens the doubled skip window");

    const health = readHealth(inst).pacer;
    assert.ok(health && health.consecutiveFailures === 1, `the failure counter must increment (was booked as success): ${JSON.stringify(health)}`);
    assert.ok(health && health.totalFailures === 1, "total-failure counter tracks it too");
    assert.ok(health && health.skipUntilMs > fakeNow, "the skip gate must trip on the failure it was built for");
    assert.equal(health?.lastSuccessAt, null, "lastSuccessAt must not lie about a failed tick");

    const pacerMessages = (readState(inst).guideLog ?? []).filter((m) => m.kind === "pacer");
    assert.equal(pacerMessages.length, 1, "the deterministic fallback must still reach the room");
    assert.ok(
      pacerMessages[0].text.includes("needs judgment on what to cut"),
      `fallback text must be unchanged: ${pacerMessages[0].text}`,
    );

    advanceClock(31_000);
    await inst.alarm(); // inside the 60s window — no tick, no spend
    await ctx.__drain();
    assert.equal(tickEntries, 1, "the skip gate must hold PACER out of its own tick loop");
    assert.equal(llm.calls.length, 1, "no paid retry inside the backoff window");

    advanceClock(30_000);
    await inst.alarm(); // past the window — the pacer resumes its work
    await ctx.__drain();
    assert.equal(tickEntries, 2, "the pacer resumes after the skip window closes");
  } finally {
    cap.restore();
  }
  console.log(`  [measured] pacer escalation attempts=${llm.calls.length}; errorLogs=${cap.errors.filter((l) => l.includes("[guide-error] agent=pacer")).length}; tickEntries=${tickEntries}`);
});

// ==============================================================================
// 7) No-regression: a live thin verdict still produces a probe message.
// ==============================================================================
await check("no-regression: thin verdict still publishes a probe message", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "thin-probe" });
  const llm = new ScriptedLlmClient((system, content) => {
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson(content, "thin");
    if (system.includes("PROBER")) return JSON.stringify({ probe: "You mentioned the March roof repair — who owns the funding decision?", reason: "names the specific item" });
    throw new Error("unexpected agent prompt");
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "phone-7");
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "p-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "p-1", content: SUBMISSION_TWO }));
  await ctx.__drain();
  const log = readState(inst).guideLog ?? [];
  assert.equal(log.length, 1, "one guide message published");
  assert.equal(log[0].kind, "probe", "thin verdict → PROBER probe");
  assert.ok(log[0].text.includes("roof repair"), "probe names the room's specifics");
  assert.equal(log[0].detail, "thin", "success-path probe detail is the evaluator's VERDICT (pre-wave behavior — wave 1.1 had smuggled evidence in here)");
});

// ==============================================================================
// 8) No-regression: fabricated provenance stays a hard failure — honest
//    message, nothing saved — and is now visible in the logs.
// ==============================================================================
await check("no-regression: fabricated provenance publishes the honest message, saves nothing, and is logged", async () => {
  resetClock();
  const { inst, ctx, db } = makeHarness({ sessionKey: "provenance-hard-fail" });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) return fabricatedSynthesisJson();
    throw new Error("unexpected agent prompt");
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "phone-8");
  const screen = makeSocket("screen", "screen-8");
  const cap = captureConsole();
  try {
    await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "f-0", content: SUBMISSION_ONE }));
    await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
    await ctx.__drain();
  } finally {
    cap.restore();
  }
  const log = readState(inst).guideLog ?? [];
  const honest = log.filter((m) => m.kind === "synthesis" && m.text.includes("failed source verification"));
  const artifactWrites = db.__statements.filter((s) => s.sql.includes("session_plan_artifact"));
  const synthesisErrors = cap.errors.filter((line) => line.includes("[guide-error] agent=synthesis"));
  console.log(`  [measured] honest messages=${honest.length}; artifact writes=${artifactWrites.length}; synthesis errorLogs=${synthesisErrors.length}`);
  assert.equal(honest.length, 1, "the room is told the draft failed verification");
  assert.equal(artifactWrites.length, 0, "no unverified artifact may be persisted");
  assert.ok(synthesisErrors.length >= 1, "the failure must be observable (was silent)");
});

// ==============================================================================
// 9) CRITIC wave 1.1 HIGH: a re-advance out of the SAME segment while its
//    synthesis is still in flight must not stash-and-double-run.
//
//    The reviewer's probe: hold the welcome synthesis open, backtrack, and
//    re-advance out of welcome (a normal mis-advance correction). The
//    in-flight work's finally() consumed the freshly stashed key and ran the
//    boundary again: 2 SYNTHESIZER calls, 2 room messages, 2 identical
//    artifact rows.
// ==============================================================================
await check("boundary synthesis: re-advancing the same segment mid-flight must not double-run", async () => {
  resetClock();
  const { inst, ctx, db } = makeHarness({ sessionKey: "same-segment-dup" });
  let resolveSynthesis: ((text: string) => void) | undefined;
  const synthesisPending = new Promise<string>((resolve) => {
    resolveSynthesis = resolve;
  });
  let holdSynthesis = true;
  const llm = new ScriptedLlmClient((system, content) => {
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson(content, "on_track");
    if (system.includes("SYNTHESIZER")) return holdSynthesis ? synthesisPending : validSynthesisJson();
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "dup-phone");
  const screen = makeSocket("screen", "dup-screen");

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "d-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "d-1", content: SUBMISSION_TWO }));
  await ctx.__drain(); // the evaluation settles; the mutex is free
  assert.equal(llm.countFor("SYNTHESIZER"), 0, "precondition: no synthesis yet");

  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await flush();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "precondition: the welcome synthesis is in flight (held open)");

  // The leader backtracks into welcome and comes back out — while pass #1
  // for welcome is still in flight.
  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));

  holdSynthesis = false; // any later synthesis call resolves immediately
  resolveSynthesis!(validSynthesisJson());
  await ctx.__drain();
  await inst.alarm(); // a later trigger must not resurrect the duplicate either
  await ctx.__drain();

  const synthMessages = (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  const artifactWrites = db.__statements.filter((s) => s.sql.includes("session_plan_artifact"));
  console.log(`  [measured] synthesizer calls=${llm.countFor("SYNTHESIZER")}; room messages=${synthMessages.length}; artifact rows=${artifactWrites.length}`);
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "one boundary, one paid synthesis (no duplicate Opus spend)");
  assert.equal(synthMessages.length, 1, "exactly one synthesis message reaches the room");
  assert.equal(artifactWrites.length, 1, "exactly one artifact row is written");
});

// ==============================================================================
// 10) CRITIC wave 1.1 MED: a stashed pass consumed BEFORE its attempt must be
//     re-stashed when the attempt fails (transient provider failure), and a
//     persistent failure must stay bounded by the backoff (no livelock).
//
//     Reviewer's probe: stash=['welcome'] -> attempt #1 -> stash=[] -> 12
//     alarms over an hour -> synthesizer calls stays 1. The segment's notes
//     were permanently lost by a transient error; only a [guide-error] line
//     remained.
// ==============================================================================
await check("boundary synthesis: transient failure re-stashes and recovers; persistent failure stays bounded", async () => {
  resetClock();
  const { inst, ctx, db } = makeHarness({ sessionKey: "synthesis-retry" });
  let resolveEvaluator: ((text: string) => void) | undefined;
  const evaluatorPending = new Promise<string>((resolve) => {
    resolveEvaluator = resolve;
  });
  let evaluatorContent = "";
  let synthMode: "fail" | "ok" = "fail";
  const llm = new ScriptedLlmClient((system, content) => {
    if (system.includes("EVALUATOR")) {
      evaluatorContent = content;
      return evaluatorPending; // held open → the boundary must stash
    }
    if (system.includes("SYNTHESIZER")) {
      if (synthMode === "fail") throw new LlmTimeoutError(20_000, "claude-opus-4-6");
      return validSynthesisJson();
    }
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep the discussion tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "retry-phone");
  const screen = makeSocket("screen", "retry-screen");

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "t-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "t-1", content: SUBMISSION_TWO }));
  await flush();
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(inst), [SEGMENT], "precondition: the boundary pass is stashed while the evaluator holds the mutex");

  resolveEvaluator!(evaluatorVerdictJson(evaluatorContent, "on_track"));
  await ctx.__drain(); // stash consumed → attempt #1 → transient failure
  const attemptsAfterFailure = llm.countFor("SYNTHESIZER");
  console.log(
    `  [measured] after transient failure: attempts=${attemptsAfterFailure}; pending=${JSON.stringify(readPending(inst))}; skipUntil>now=${(readHealth(inst).synthesis?.skipUntilMs ?? 0) > fakeNow}`,
  );
  assert.equal(attemptsAfterFailure, 1, "the stashed pass ran once and failed");
  assert.deepEqual(readPending(inst), [SEGMENT], "the failed pass must be re-stashed, not lost");

  // An hour of alarms: retries must be retried but bounded by the backoff,
  // never hot-looped on the 30s cadence.
  const cap = captureConsole();
  let attemptsThroughHour = 0;
  let synthErrorLines = 0;
  try {
    for (let i = 0; i < 120; i++) {
      advanceClock(30_000);
      await inst.alarm();
      await ctx.__drain();
    }
    attemptsThroughHour = llm.countFor("SYNTHESIZER");
    synthErrorLines = cap.errors.filter((line) => line.includes("[guide-error] agent=synthesis")).length;
  } finally {
    cap.restore();
  }
  console.log(`  [measured] after 60 min of alarms: attempts=${attemptsThroughHour}; synthesis errorLogs=${synthErrorLines}; pending=${JSON.stringify(readPending(inst))}`);
  // Bounded by the BACKOFF, not the alarm cadence: skips double 60s→120s→
  // 240s→ capped at 5 min, so an hour admits at most ~15 attempts (ramp +
  // 12 at the cap). The alarm cadence alone would allow 120 — the point is
  // that a persistent failure never hot-loops.
  assert.ok(attemptsThroughHour <= 16, `a persistent failure must stay bounded by the backoff cap (<=16 attempts/hour), got ${attemptsThroughHour}`);
  assert.ok(attemptsThroughHour >= 3, `the stashed pass must actually be retried after the backoff, got ${attemptsThroughHour}`);
  assert.ok(synthErrorLines >= 3, "every retry failure must remain observable");
  assert.deepEqual(readPending(inst), [SEGMENT], "the pass is still pending while it keeps failing");

  // A later success recovers the segment's notes — they were never lost.
  synthMode = "ok";
  advanceClock(330_000); // past any skip window (each is capped at 5 min; the last failure was at t<=3600s)
  assert.ok((readHealth(inst).synthesis?.skipUntilMs ?? 0) <= fakeNow, "precondition: the backoff window has fully closed");
  await inst.alarm();
  await ctx.__drain();
  const synthMessages = (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  const artifactWrites = db.__statements.filter((s) => s.sql.includes("session_plan_artifact"));
  assert.equal(synthMessages.length, 1, `the recovered pass reaches the room with the saved-notes message (got ${synthMessages.length})`);
  assert.equal(artifactWrites.length, 1, "and its verified artifacts are persisted");
  assert.deepEqual(readPending(inst), [], "with nothing left pending");
});

// ==============================================================================
// 11) CRITIC wave 1.1 LOW: the stash is durable state — it must survive a DO
//     instance swap (the suite proved guideHealth does, never the stash), and
//     the revived instance must be able to drain it.
// ==============================================================================
await check("stash: pending synthesis keys survive a DO instance swap and still run", async () => {
  resetClock();
  const storage: StoredMap = new Map();
  const first = makeHarness({ sessionKey: "stash-eviction", storage });
  let resolveEvaluator: ((text: string) => void) | undefined;
  const evaluatorPending = new Promise<string>((resolve) => {
    resolveEvaluator = resolve;
  });
  const llm1 = new ScriptedLlmClient((system) => {
    if (system.includes("EVALUATOR")) return evaluatorPending; // held → boundary stashes
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(first.inst, llm1);
  const phone = makeSocket("phone", "swap-phone");
  const screen = makeSocket("screen", "swap-screen");
  await first.inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "s-0", content: SUBMISSION_ONE }));
  await first.inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "s-1", content: SUBMISSION_TWO }));
  await flush();
  await first.inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(first.inst), [SEGMENT], "precondition: the boundary is stashed while the evaluator holds the mutex");

  // Eviction: a NEW instance over the SAME durable storage.
  const second = makeHarness({ sessionKey: "stash-eviction", storage });
  await second.waitReady();
  assert.deepEqual(readPending(second.inst), [SEGMENT], "the stashed boundary pass must survive a DO instance swap");

  const llm2 = new ScriptedLlmClient((system, content) => {
    if (system.includes("SYNTHESIZER")) return validSynthesisJson();
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson(content, "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "x", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(second.inst, llm2);
  await second.inst.alarm();
  await second.ctx.__drain();

  const synthMessages = (readState(second.inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  console.log(`  [measured] revived instance synthesizer calls=${llm2.countFor("SYNTHESIZER")}; room messages=${synthMessages.length}; pending after=${JSON.stringify(readPending(second.inst))}`);
  assert.equal(llm2.countFor("SYNTHESIZER"), 1, "the revived instance runs the stashed pass");
  assert.equal(synthMessages.length, 1, "and the room sees the saved-notes message");
  assert.deepEqual(readPending(second.inst), [], "nothing left pending after the drain");
});

// ==============================================================================
// 12) CRITIC wave 1.1 LOW: stash discards must not be silent — the list-bound
//     eviction and the guide-inactive drop both emit a diagnostic, so absence
//     of a log is distinguishable from "nothing pending".
// ==============================================================================
await check("stash diagnostics: bound drop is logged with the dropped key", async () => {
  resetClock();
  const storage: StoredMap = new Map();
  // Pre-seed a full stash — one more boundary pushes the oldest out.
  storage.set("pendingSynthesis", ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
  const { inst, ctx } = makeHarness({ sessionKey: "stash-bound", storage });
  let resolveEvaluator: ((text: string) => void) | undefined;
  const evaluatorPending = new Promise<string>((resolve) => {
    resolveEvaluator = resolve;
  });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("EVALUATOR")) return evaluatorPending;
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "bound-phone");
  const screen = makeSocket("screen", "bound-screen");
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "k-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "k-1", content: SUBMISSION_TWO }));
  await flush();

  const cap = captureConsole();
  try {
    await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" })); // stash → bound exceeded
  } finally {
    cap.restore();
  }
  const dropLines = cap.errors.filter((line) => line.includes("op=pending-synthesis-drop") && line.includes("reason=bound"));
  assert.equal(dropLines.length, 1, `the bound drop must be logged: ${JSON.stringify(cap.errors)}`);
  assert.ok(dropLines[0].includes("key=k0"), "the dropped key must be named");
  assert.deepEqual(
    readPending(inst),
    ["k1", "k2", "k3", "k4", "k5", "k6", "k7", SEGMENT],
    "oldest gives way; the newest boundary pass is kept",
  );
});

await check("stash diagnostics: a stash stranded by an inactive guide is dropped with a diagnostic", async () => {
  resetClock();
  const storage: StoredMap = new Map();
  storage.set("pendingSynthesis", [SEGMENT]);
  const { inst, ctx, env } = makeHarness({ sessionKey: "stash-inactive", storage });
  env.GUIDE_ENABLED = "false"; // the guide can never run on this instance

  const cap = captureConsole();
  try {
    await inst.alarm(); // finds the stranded pass → drops it WITH a diagnostic
    await ctx.__drain();
    await inst.alarm(); // nothing pending now — must not re-log
    await ctx.__drain();
  } finally {
    cap.restore();
  }
  const dropLines = cap.errors.filter((line) => line.includes("op=pending-synthesis-drop") && line.includes("reason=guide-inactive"));
  console.log(`  [measured] guide-inactive drop logs=${dropLines.length}; pending after=${JSON.stringify(readPending(inst))}`);
  assert.equal(dropLines.length, 1, `one diagnostic per discard, not silent (and not per-alarm spam): ${JSON.stringify(cap.errors)}`);
  assert.ok(dropLines[0].includes(SEGMENT), "the dropped key must be named");
  assert.deepEqual(readPending(inst), [], "the stranded stash is dropped");
  assert.deepEqual(ctx.__storage.get("pendingSynthesis"), [], "and the drop is persisted");
});

// ==============================================================================
// 13) CRITIC wave 1.1 ALSO (pre-existing): a PROBER failure must not discard
//     the already-paid EVALUATOR verdict. Pre-fix the throw propagated to the
//     DO's catch and the room got ZERO guide messages for a paid evaluation.
// ==============================================================================
await check("evaluator: a PROBER failure still publishes a fallback probe built from the paid verdict", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "prober-fallback" });
  const llm = new ScriptedLlmClient((system, content) => {
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson(content, "thin");
    if (system.includes("PROBER")) throw new ProberParseError("PROBER returned non-JSON output: {oops");
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "pf-phone");
  const cap = captureConsole();
  try {
    await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "pf-0", content: SUBMISSION_ONE }));
    await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "pf-1", content: SUBMISSION_TWO }));
    await ctx.__drain();
  } finally {
    cap.restore();
  }
  const log = readState(inst).guideLog ?? [];
  const probes = log.filter((m) => m.kind === "probe");
  const fallbackLines = cap.errors.filter((line) => line.includes("op=prober-fallback"));
  console.log(`  [measured] guide messages=${log.length}; probe messages=${probes.length}; prober-fallback logs=${fallbackLines.length}; prober calls=${llm.countFor("PROBER")}`);
  assert.equal(log.length, 1, "the paid evaluator verdict must not be discarded (pre-fix: zero messages)");
  assert.equal(probes.length, 1, "a deterministic probe fallback is published");
  assert.ok(probes[0].text.includes("(weakest area: specific)"), `the fallback is built from the evaluator's own output: ${probes[0].text}`);
  assert.equal(probes[0].detail, "scripted evidence", "the PROBER-fallback probe keeps the evaluator's evidence (new behavior by design)");
  assert.equal(fallbackLines.length, 1, "the PROBER degradation is observable in the logs");
  assert.equal(llm.countFor("EVALUATOR"), 1, "exactly one paid evaluator call — the fallback spends nothing new");
});

// ==============================================================================
// 14) CRITIC wave 1.2 (A) MED: a provenance verification failure is a designed
//     HARD STOP — it must NOT be re-stashed. Pre-fix every alarm re-spent a
//     SYNTHESIZER call and re-published the notice (measured: ~14 attempts and
//     ~14 room-visible notices over one simulated hour; the log's 25-message
//     cap meant those notices evicted the room's real guide history).
// ==============================================================================
await check("synthesis: a provenance hard stop never re-stashes or re-notices (one notice, no re-spend)", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "provenance-hard-stop" });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) return fabricatedSynthesisJson();
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "hs-phone");
  const screen = makeSocket("screen", "hs-screen");
  const notices = () =>
    (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.text.includes("failed source verification")).length;

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "hs-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "hs-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await ctx.__drain();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "the boundary pass ran once and hit the hard stop");
  assert.equal(notices(), 1, "the room is told honestly, exactly once");
  assert.deepEqual(readPending(inst), [], "a hard stop must not be re-stashed (pre-fix: money pump)");

  // An hour of alarms: a provenance failure can never pass on retry, so no
  // attempt may re-spend — and no duplicate notice may evict guide history.
  const cap = captureConsole();
  try {
    for (let i = 0; i < 120; i++) {
      advanceClock(30_000);
      await inst.alarm();
      await ctx.__drain();
    }
  } finally {
    cap.restore();
  }
  console.log(
    `  [measured] after 60 min: synthesizer attempts=${llm.countFor("SYNTHESIZER")}; notices=${notices()}; pending=${JSON.stringify(readPending(inst))}`,
  );
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "a provenance failure can never pass on retry — every re-spend was pure waste");
  assert.equal(notices(), 1, "exactly one honest notice across the hour (retries must not re-publish it)");
  assert.deepEqual(readPending(inst), [], "and nothing is pending an hour later");
});

// ==============================================================================
// 15) CRITIC wave 1.2 (A, second half): the failure notice is deduped by
//     segment key across retries — a same-segment boundary re-run must not
//     re-publish it.
// ==============================================================================
await check("synthesis: a same-segment boundary re-run never re-publishes the failure notice", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "provenance-notice-dedupe" });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) return fabricatedSynthesisJson();
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "nd-phone");
  const screen = makeSocket("screen", "nd-screen");
  const notices = () =>
    (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.text.includes("failed source verification")).length;

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "nd-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "nd-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await ctx.__drain();
  assert.equal(notices(), 1, "precondition: the first boundary published its honest notice");

  // The leader re-enters and leaves the same segment again (a normal
  // mis-advance correction). The boundary pass runs once more after the
  // backoff, but the room must not see a second copy of the notice.
  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(inst), [SEGMENT], "precondition: the re-run is stashed while the synthesis backoff is open");
  advanceClock(61_000);
  await inst.alarm();
  await ctx.__drain();
  console.log(
    `  [measured] synthesizer attempts=${llm.countFor("SYNTHESIZER")}; notices=${notices()}; pending=${JSON.stringify(readPending(inst))}`,
  );
  assert.equal(llm.countFor("SYNTHESIZER"), 2, "the boundary genuinely re-ran (the dedupe check would be vacuous otherwise)");
  assert.equal(notices(), 1, "the same segment's failure notice is published at most once per boundary episode");
  assert.deepEqual(readPending(inst), [], "the re-run's hard stop does not re-stash either");
});

// ==============================================================================
// 16) CRITIC wave 1.2 (B) LOW-MED: the in-flight skip must only cover the
//     material the in-flight pass actually snapshotted. Probe B pre-fix: hold
//     welcome's synthesis, backtrack to welcome, add a NEW submission,
//     re-advance → the boundary was skipped, the new text reached no synthesis
//     prompt at all, and pending ended empty.
// ==============================================================================
await check("boundary synthesis: a same-segment boundary with NEW submissions is still synthesized", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "boundary-new-material" });
  const newSubmission = "The boiler replacement quote came in at $9k.";
  let resolveFirst: ((text: string) => void) | undefined;
  const firstPending = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  let synthesisCalls = 0;
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) {
      synthesisCalls += 1;
      if (synthesisCalls === 1) return firstPending; // pass #1: held open → in flight
      return JSON.stringify({
        artifacts: [
          {
            kind: "risk",
            content: "A boiler replacement quote of $9k is now on the table.",
            provenance: [{ type: "submission", index: 2, quote: "boiler replacement quote came in at $9k" }],
          },
        ],
      });
    }
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "nm-phone");
  const screen = makeSocket("screen", "nm-screen");

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "nm-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "nm-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await flush();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "precondition: welcome's synthesis is in flight (held open)");

  // Backtrack into welcome, add genuinely NEW material, leave again.
  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "nm-2", content: newSubmission }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(inst), [SEGMENT], "material the in-flight pass never snapshotted must stash the boundary, not vanish");

  resolveFirst!(validSynthesisJson()); // pass #1 (old snapshot) settles…
  await ctx.__drain(); // …and its finally() runs the stashed pass with the new material
  await inst.alarm();
  await ctx.__drain();

  const promptsWithNewMaterial = llm.calls.filter(
    (call) => call.system.includes("SYNTHESIZER") && call.content.includes("boiler replacement"),
  ).length;
  console.log(
    `  [measured] synthesizer attempts=${llm.countFor("SYNTHESIZER")}; prompts carrying the new submission=${promptsWithNewMaterial}; pending=${JSON.stringify(readPending(inst))}`,
  );
  assert.equal(llm.countFor("SYNTHESIZER"), 2, "the new boundary is synthesized (exactly one additional pass)");
  assert.equal(promptsWithNewMaterial, 1, "the new submission reaches a synthesis prompt exactly once");
  assert.deepEqual(readPending(inst), [], "nothing left pending after the stashed pass runs");
});

// ==============================================================================
// 17) Round-1 invariant (mutation x) MUST stay pinned: a same-segment boundary
//     with NO new material since the in-flight pass began is still skipped —
//     no second paid pass.
// ==============================================================================
await check("boundary synthesis: a same-segment re-advance with no new material is still skipped", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "boundary-covered-no-new" });
  let resolveFirst: ((text: string) => void) | undefined;
  const firstPending = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  let synthesisCalls = 0;
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) {
      synthesisCalls += 1;
      return synthesisCalls === 1 ? firstPending : validSynthesisJson();
    }
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "cn-phone");
  const screen = makeSocket("screen", "cn-screen");

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "cn-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "cn-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await flush();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "precondition: welcome's synthesis is in flight (held open)");

  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(inst), [], "no new material since the snapshot → the in-flight pass covers this boundary → nothing stashed");

  resolveFirst!(validSynthesisJson());
  await ctx.__drain();
  await inst.alarm();
  await ctx.__drain();
  const synthMessages = (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  console.log(
    `  [measured] synthesizer attempts=${llm.countFor("SYNTHESIZER")}; room messages=${synthMessages.length}; pending=${JSON.stringify(readPending(inst))}`,
  );
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "no second paid pass for a boundary the running pass already covers");
  assert.equal(synthMessages.length, 1, "and exactly one synthesis message reaches the room");
  assert.deepEqual(readPending(inst), [], "nothing stashed");
});

// ==============================================================================
// 18) CRITIC wave 1.2 (C) LOW: a double fault — the synthesis attempt fails
//     AND the failure-recording storage.put faults — must not strand the pass.
//     Pre-fix recordGuideFailure threw before the re-stash (measured
//     pending=[] after drain: the boundary was lost).
// ==============================================================================
await check("synthesis: a health-recorder fault cannot strand the re-stashed pass (failure still logged)", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "synthesis-health-fault", putFault: (key) => key === "guideHealth" });
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) throw new LlmTimeoutError(20_000, "claude-opus-4-6");
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "hf-phone");
  const screen = makeSocket("screen", "hf-screen");
  const cap = captureConsole();
  try {
    await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "hf-0", content: SUBMISSION_ONE }));
    await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "hf-1", content: SUBMISSION_TWO }));
    await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
    await ctx.__drain();
  } finally {
    cap.restore();
  }
  const synthErrors = cap.errors.filter((line) => line.includes("[guide-error] agent=synthesis"));
  console.log(
    `  [measured] pending=${JSON.stringify(readPending(inst))}; synthesis errorLogs=${synthErrors.length}; consecutive=${readHealth(inst).synthesis?.consecutiveFailures}`,
  );
  assert.deepEqual(readPending(inst), [SEGMENT], "the re-stash must happen BEFORE the faulting failure-recording put");
  assert.ok(synthErrors.length >= 1, "the failure is still logged despite the recorder fault");
  assert.ok(synthErrors[0].includes("consecutive=1"), "and counted (in-memory health updates before the persist fault)");
  assert.equal(Reflect.get(inst, "guideWorkInFlight"), false, "the guide loop is not wedged by the fault");
  assert.equal(Reflect.get(inst, "synthesisInFlightKey"), null, "and the in-flight marker is cleared");
});

// ==============================================================================
// 19) CRITIC wave 1.2 (D) LOW: artifacts must not duplicate on a partial-save
//     retry. Pass #1 saves artifact A, faults on B, is re-stashed; the retry
//     re-inserted A (this is how the round-1 duplicate rows appeared). The
//     write must be idempotent per (session, kind, content).
// ==============================================================================
await check("synthesis: a retry after a partial artifact save writes no duplicate rows", async () => {
  resetClock();
  const { inst, ctx, db } = makeHarness({ sessionKey: "artifact-partial-retry" });
  const artifactA = "The roof repair is due in March and carries a $14k cost.";
  const artifactB = "Maintenance communication is a named driver in the room's input.";
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) {
      return JSON.stringify({
        artifacts: [
          { kind: "risk", content: artifactA, provenance: [{ type: "submission", index: 0, quote: "roof repair is due in March" }] },
          { kind: "driver", content: artifactB, provenance: [{ type: "submission", index: 1, quote: "communicate better about maintenance" }] },
        ],
      });
    }
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "pr-phone");
  const screen = makeSocket("screen", "pr-screen");

  db.__failArtifactInsertOnce(2); // pass #1: A saves, B's INSERT faults (a partial save)

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "pr-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "pr-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await ctx.__drain();

  const rowsAfterPartial = db.__artifactRows.filter((r) => r.session_id === "artifact-partial-retry");
  assert.equal(rowsAfterPartial.length, 1, "precondition: the first artifact was saved before the fault");
  assert.deepEqual(readPending(inst), [SEGMENT], "precondition: the failed pass was re-stashed for retry");

  advanceClock(61_000); // past the failure backoff
  await inst.alarm();
  await ctx.__drain();

  const rows = db.__artifactRows.filter((r) => r.session_id === "artifact-partial-retry");
  const countFor = (content: string) => rows.filter((r) => r.content === content).length;
  console.log(
    `  [measured] artifact rows before retry=${rowsAfterPartial.length}, after retry=${rows.length}; A=${countFor(artifactA)} B=${countFor(artifactB)}`,
  );
  assert.equal(rows.length, 2, "one row per artifact — the retry must not re-insert what pass #1 already wrote");
  assert.equal(countFor(artifactA), 1, "no duplicate for the already-saved artifact");
  assert.equal(countFor(artifactB), 1, "and the faulted artifact is written exactly once");
  const synthMessages = (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  assert.equal(synthMessages.length, 1, "the recovered pass reaches the room once");
});

// ==============================================================================
// 20) CRITIC wave 1.3 (item 1) MED: the in-flight dedupe was COUNT-only. The
//     leader can edit an already-stored submission in place (leader_override):
//     same count, changed content. A same-segment boundary arriving mid-flight
//     compared 2 <= 2 and skipped, so the edited text reached NO synthesis
//     prompt (measured pre-fix: stashed=[], attempts=1, promptsWithEdit=0).
//     The pass snapshot is a content FINGERPRINT now, not a bare count.
// ==============================================================================
await check("boundary synthesis: a mid-flight leader edit re-stashes the boundary (fingerprint, not count)", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "boundary-leader-edit" });
  const editedSubmission = "The roof repair is due in March and costs $16k after the second bid.";
  let resolveFirst: ((text: string) => void) | undefined;
  const firstPending = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  let synthesisCalls = 0;
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) {
      synthesisCalls += 1;
      return synthesisCalls === 1 ? firstPending : validSynthesisJson();
    }
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "le-phone");
  const screen = makeSocket("screen", "le-screen");

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "le-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "le-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await flush();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "precondition: welcome's synthesis is in flight (held open)");

  // The leader edits an ALREADY-STORED submission in place — the count does
  // not move, only the content (the leader_override path, §5.5).
  await inst.webSocketMessage(
    screen,
    JSON.stringify({
      type: "leader_override",
      override: { kind: "submission", segmentKey: SEGMENT, clientUuid: "le-0", newContent: editedSubmission },
    }),
  );
  // …and the segment is left again mid-flight (a normal mis-advance correction).
  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  const stashedMidFlight = readPending(inst);
  assert.deepEqual(
    stashedMidFlight,
    [SEGMENT],
    "an edit the in-flight pass never snapshotted must stash the boundary, not vanish (the submission count is unchanged: 2)",
  );

  resolveFirst!(validSynthesisJson()); // pass #1 (old snapshot) settles…
  await ctx.__drain(); // …and its finally() runs the stashed pass with the edited text
  await inst.alarm();
  await ctx.__drain();

  const promptsWithEdit = llm.calls.filter((call) => call.system.includes("SYNTHESIZER") && call.content.includes("$16k")).length;
  console.log(
    `  [measured] stashed mid-flight=${JSON.stringify(stashedMidFlight)}; synthesizer attempts=${llm.countFor("SYNTHESIZER")}; prompts carrying the edit=${promptsWithEdit}`,
  );
  assert.equal(llm.countFor("SYNTHESIZER"), 2, "the boundary re-runs so the leader's edit is synthesized (pre-fix: attempts=1)");
  assert.equal(promptsWithEdit, 1, "the edited text reaches a synthesis prompt exactly once");
  assert.deepEqual(readPending(inst), [], "nothing left pending after the stashed pass runs");
});

// ==============================================================================
// 21) CRITIC wave 1.3 (item 2): mutation M13 (delete-on-success removed) stayed
//     green on the whole shipped suite — nothing pinned the episode ending.
//     A successful pass must clear the segment's failure episode, so a LATER
//     failure is new information and re-notices (Critic probe A2: attempts=3,
//     notices=2).
// ==============================================================================
await check("synthesis: a successful pass clears the failure episode — a later failure re-notices", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "failure-episode-clear" });
  let mode: "fail" | "ok" = "fail";
  const llm = new ScriptedLlmClient((system) => {
    if (system.includes("SYNTHESIZER")) return mode === "fail" ? fabricatedSynthesisJson() : validSynthesisJson();
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
    throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
  });
  injectLlm(inst, llm);
  const phone = makeSocket("phone", "ep-phone");
  const screen = makeSocket("screen", "ep-screen");
  const notices = () =>
    (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.text.includes("failed source verification")).length;

  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "ep-0", content: SUBMISSION_ONE }));
  await inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "ep-1", content: SUBMISSION_TWO }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await ctx.__drain();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "precondition: attempt #1 hit the provenance hard stop");
  assert.equal(notices(), 1, "precondition: notice #1 reached the room");

  // Attempt #2 — same segment, back after the backoff — SUCCEEDS: the episode
  // is over and the room gets the saved-notes message.
  mode = "ok";
  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(inst), [SEGMENT], "precondition: the re-run waits out the synthesis backoff in the stash");
  advanceClock(61_000);
  await inst.alarm();
  await ctx.__drain();
  assert.equal(llm.countFor("SYNTHESIZER"), 2, "precondition: attempt #2 ran");
  const savedMessages = (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.text.includes("Draft plan notes"));
  assert.equal(savedMessages.length, 1, "precondition: the success reached the room as saved notes");

  // Attempt #3 — a later provenance stop after real progress is NEW
  // information; the cleared episode must let the notice through.
  mode = "fail";
  await inst.webSocketMessage(screen, JSON.stringify({ type: "backtrack_segment" }));
  await inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await ctx.__drain();
  console.log(`  [measured] synthesizer attempts=${llm.countFor("SYNTHESIZER")}; notices=${notices()}`);
  assert.equal(llm.countFor("SYNTHESIZER"), 3, "precondition: attempt #3 ran");
  assert.equal(notices(), 2, "a failure after a successful pass must re-notice (M13: the stale episode suppressed it)");
});

// ==============================================================================
// 22) CRITIC wave 1.3 (item 3): the episode marker was in-memory only, so an
//     eviction cleared it and a post-eviction failure re-published a notice
//     the room already had (Critic probe A4: notices=2). The marker now lives
//     in DO storage next to guideHealth and the stash (one key; no D1 table,
//     no migration).
// ==============================================================================
await check("synthesis: the failure-notice episode survives a DO instance swap (no duplicate notice)", async () => {
  resetClock();
  const storage: StoredMap = new Map();
  const scripted = () =>
    new ScriptedLlmClient((system) => {
      if (system.includes("SYNTHESIZER")) return fabricatedSynthesisJson();
      if (system.includes("EVALUATOR")) return evaluatorVerdictJson("", "on_track");
      if (system.includes("PACER")) return JSON.stringify({ message_to_room: "Keep it tight.", rationale: "scripted" });
      throw new Error(`unexpected agent prompt: ${system.slice(0, 48)}`);
    });
  const notices = (inst: unknown) =>
    (readState(inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.text.includes("failed source verification")).length;

  const first = makeHarness({ sessionKey: "episode-eviction", storage });
  const llm1 = scripted();
  injectLlm(first.inst, llm1);
  const phone = makeSocket("phone", "ee-phone");
  const screen = makeSocket("screen", "ee-screen");
  await first.inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "ee-0", content: SUBMISSION_ONE }));
  await first.inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await first.ctx.__drain();
  assert.equal(llm1.countFor("SYNTHESIZER"), 1, "precondition: the pre-eviction pass hit the hard stop");
  assert.equal(notices(first.inst), 1, "precondition: the room saw the honest notice");
  assert.deepEqual(
    storage.get("synthesisFailureNotified"),
    [SEGMENT],
    "the episode marker must be persisted in DO storage (one key; no D1 table, no migration)",
  );

  // Eviction: a NEW instance over the SAME durable storage — same room, same guide log.
  const second = makeHarness({ sessionKey: "episode-eviction", storage });
  await second.waitReady();
  const llm2 = scripted();
  injectLlm(second.inst, llm2);
  const phone2 = makeSocket("phone", "ee-phone-2");
  const screen2 = makeSocket("screen", "ee-screen-2");

  // The same segment's boundary re-runs after the eviction and fails again;
  // the room must NOT see a second copy of a notice it already has.
  await second.inst.webSocketMessage(screen2, JSON.stringify({ type: "backtrack_segment" }));
  await second.inst.webSocketMessage(screen2, JSON.stringify({ type: "advance_segment" }));
  assert.deepEqual(readPending(second.inst), [SEGMENT], "precondition: the re-run waits out the restored backoff in the stash");
  advanceClock(61_000);
  await second.inst.alarm();
  await second.ctx.__drain();
  console.log(
    `  [measured] post-eviction attempts=${llm2.countFor("SYNTHESIZER")}; notices in the room=${notices(second.inst)}; marker=${JSON.stringify(storage.get("synthesisFailureNotified"))}`,
  );
  assert.equal(llm2.countFor("SYNTHESIZER"), 1, "precondition: the post-eviction attempt genuinely ran");
  assert.equal(notices(second.inst), 1, "an eviction must not re-open the episode: the room never sees a duplicate notice (pre-fix: notices=2)");
});

// ==============================================================================
// 23) BRICK A1 (CRITIC F2): an eviction WHILE a synthesis pass is in flight.
//     The stash durability story covers the "cannot start yet" wait, but the
//     claimed pass consumes its key from durable state before the paid call
//     and the in-flight marker was in-memory only — an isolate eviction
//     mid-pass lost the boundary silently (critic probe: revived instance
//     attempts=0, pending=[], no durable record of the pass). The claim is
//     durable now, persisted BEFORE the paid call, and a revived instance
//     re-stashes a stale claim so the alarm path runs it exactly once.
// ==============================================================================
await check("synthesis: an eviction mid-pass leaves a durable claim the revived instance recovers", async () => {
  resetClock();
  const storage: StoredMap = new Map();
  const first = makeHarness({ sessionKey: "evict-mid-synthesis", storage });
  // Held open forever — the instance "dies" inside its paid call. The promise
  // is never settled (like an evicted isolate's in-flight work).
  const synthPending = new Promise<string>(() => {});
  const llm = new ScriptedLlmClient((system, content) => {
    if (system.includes("EVALUATOR")) return evaluatorVerdictJson(content, "on_track");
    if (system.includes("SYNTHESIZER")) return synthPending;
    if (system.includes("PACER")) return JSON.stringify({ message_to_room: "x", rationale: "y" });
    throw new Error("unexpected " + system.slice(0, 40));
  });
  injectLlm(first.inst, llm);
  const phone = makeSocket("phone", "ev-phone");
  const screen = makeSocket("screen", "ev-screen");
  await first.inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "ev-0", content: SUBMISSION_ONE }));
  await first.inst.webSocketMessage(phone, JSON.stringify({ type: "submit", segmentKey: SEGMENT, clientUuid: "ev-1", content: SUBMISSION_TWO }));
  await first.ctx.__drain();
  await first.inst.webSocketMessage(screen, JSON.stringify({ type: "advance_segment" }));
  await flush();
  assert.equal(llm.countFor("SYNTHESIZER"), 1, "precondition: the pass is in flight (held open)");

  // The durable claim record (SYNTHESIS_IN_FLIGHT_KEY in session-do.ts).
  const durableClaim = storage.get("synthesisInFlight") as
    | { segmentKey: string; fingerprint: string; claimedAtMs: number }
    | undefined;
  console.log(
    `  [measured] in-flight claim: durable synthesisInFlight=${JSON.stringify(durableClaim)}; durable pendingSynthesis=${JSON.stringify(storage.get("pendingSynthesis"))}`,
  );
  assert.ok(durableClaim, "the claimed pass must be recorded durably BEFORE the paid call (pre-fix: nothing durable remembers it)");
  assert.equal(durableClaim.segmentKey, SEGMENT, "the durable claim names the segment the pass covers");
  assert.equal(
    durableClaim.fingerprint,
    JSON.stringify([SUBMISSION_ONE, SUBMISSION_TWO]),
    "the durable claim carries the material snapshot the pass consumes",
  );
  assert.deepEqual(storage.get("pendingSynthesis"), [], "the stash key is consumed at claim time — the claim record is what survives the eviction");

  // Evict mid-pass: a NEW instance over the same durable storage, as an
  // isolate eviction / deploy restart produces.
  const later = () =>
    new ScriptedLlmClient((system, content) => {
      if (system.includes("SYNTHESIZER")) return validSynthesisJson();
      if (system.includes("EVALUATOR")) return evaluatorVerdictJson(content, "on_track");
      if (system.includes("PACER")) return JSON.stringify({ message_to_room: "x", rationale: "y" });
      throw new Error("unexpected " + system.slice(0, 40));
    });

  const second = makeHarness({ sessionKey: "evict-mid-synthesis", storage });
  await second.waitReady();
  assert.deepEqual(readPending(second.inst), [], "a fresh claim is left in place while it could still be live on the previous isolate");
  const llm2 = later();
  injectLlm(second.inst, llm2);
  await second.inst.alarm();
  await second.ctx.__drain();
  assert.equal(llm2.countFor("SYNTHESIZER"), 0, "a claim younger than the stale threshold must not be re-run while it could still be live");

  // The claim ages past the stale threshold (a live pass is bounded by the
  // LLM client's 20s hard timeout; 10 minutes is deliberately far beyond any
  // threshold a live pass could hide behind — raising the threshold past
  // this fails the check).
  advanceClock(10 * 60_000);

  // Revive once more — the claim is stale now, so init re-stashes it.
  const third = makeHarness({ sessionKey: "evict-mid-synthesis", storage });
  await third.waitReady();
  assert.deepEqual(readPending(third.inst), [SEGMENT], "a stale claim must be re-stashed on init (pre-fix: nothing durable to recover)");

  const llm3 = later();
  injectLlm(third.inst, llm3);
  await third.inst.alarm();
  await third.ctx.__drain();

  const synthMessages = (readState(third.inst).guideLog ?? []).filter((m) => m.kind === "synthesis" && m.segmentKey === SEGMENT);
  console.log(
    `  [measured] revived instance: synth attempts=${llm3.countFor("SYNTHESIZER")}; room synthesis messages=${synthMessages.length}; pending=${JSON.stringify(readPending(third.inst))}; durable claim after=${JSON.stringify(storage.get("synthesisInFlight"))}`,
  );
  assert.equal(llm3.countFor("SYNTHESIZER"), 1, "the revived instance runs the recovered pass exactly once (pre-fix: attempts=0, the pass was lost)");
  assert.equal(synthMessages.length, 1, "and the room sees the segment's draft notes");
  assert.deepEqual(readPending(third.inst), [], "nothing left pending after the recovery drain");
  assert.equal(storage.get("synthesisInFlight"), undefined, "the durable claim is cleared once the pass completes");

  // A later alarm must not re-run the recovered pass.
  await third.inst.alarm();
  await third.ctx.__drain();
  assert.equal(llm3.countFor("SYNTHESIZER"), 1, "a later alarm must not re-run the recovered pass");
});

Date.now = REAL_NOW;
console.log(`\n${passed}/${total} checks passed.`);
if (process.exitCode) {
  console.error("GUIDE FAILURE-PATH TESTS FAILED");
} else {
  console.log("ALL GUIDE FAILURE-PATH TESTS PASSED");
}
