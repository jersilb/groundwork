#!/usr/bin/env node --experimental-strip-types
// Guide failure-path tests — the silent-failure cluster in the SessionDO's
// guide loop (Build Staff findings, 2026-09-06, items 1/2/4/6):
//
//   * failures must be OBSERVABLE: structured `[guide-error]` lines and
//     per-agent consecutive-failure counters persisted in DO storage (so
//     an eviction cannot silently reset a backing-off agent),
//   * a boundary synthesis blocked by the in-flight mutex must not vanish:
//     it is stashed (durably) and run from the in-flight work's finally()
//     or the next alarm tick — and never twice,
//   * a persistently failing agent must back off (2x, 4x, ... capped 5 min)
//     instead of re-spending on the 30s cadence,
//   * guideClient() must reuse one client per DO instance.
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

function makeFakeCtx(sessionKey: string, storage: StoredMap = new Map()) {
  const waitUntilTasks: Promise<unknown>[] = [];
  const sockets: FakeSocket[] = [];
  return {
    id: { name: sessionKey, toString: () => sessionKey },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
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

function makeFakeDb() {
  const statements: { sql: string; args: unknown[] }[] = [];
  function statement(sql: string, args: unknown[] = []): unknown {
    return {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => null,
      all: async () => ({ results: [] as unknown[] }),
      run: async () => {
        statements.push({ sql, args });
        return { success: true };
      },
    };
  }
  return { prepare: (sql: string) => statement(sql), __statements: statements };
}

type HarnessOptions = { sessionKey?: string; storage?: StoredMap };

function makeHarness(options: HarnessOptions = {}) {
  const ctx = makeFakeCtx(options.sessionKey ?? "guide-failure-test", options.storage);
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

function readState(inst: unknown): { guideLog?: { kind: string; text: string; segmentKey: string }[] } {
  return Reflect.get(inst, "state");
}

interface AgentHealth {
  consecutiveFailures: number;
  skipUntilMs: number;
  totalFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
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
// 6) guideClient(): one cached client per DO instance.
// ==============================================================================
await check("guideClient: one cached client per DO instance", async () => {
  const { inst } = makeHarness({ sessionKey: "client-cache" });
  await (Reflect.get(inst, "ready") as Promise<void>);
  const guideClient = (inst as unknown as { guideClient(): unknown }).guideClient.bind(inst);
  const first = guideClient();
  const second = guideClient();
  assert.ok(first, "client exists when the key is present and the guide is enabled");
  assert.ok(first === second, "guideClient() must reuse the cached instance");
});

// ==============================================================================
// 6) PACER tick failure: logged and exponentially skipped (60s → 120s).
// ==============================================================================
await check("pacer: tick failure is logged and exponentially backed off", async () => {
  resetClock();
  const { inst, ctx } = makeHarness({ sessionKey: "pacer-backoff" });
  const llm = new ScriptedLlmClient(() => {
    throw new Error("scripted pacer transport should not be reached");
  });
  injectLlm(inst, llm);
  let tickCalls = 0;
  // Synthetic fault at the tick boundary: any unexpected throw in the tick
  // body must be observable and must trip the backoff (the old bare catch
  // swallowed it and kept the 30s loop spinning).
  Reflect.set(inst, "buildGuideContext", () => {
    tickCalls += 1;
    throw new Error("synthetic pacer tick fault");
  });
  const cap = captureConsole();
  try {
    await inst.alarm(); // t+0 — fault → skip window opens (60s)
    await ctx.__drain();
    assert.equal(tickCalls, 1, "first alarm runs the tick");
    advanceClock(31_000);
    await inst.alarm(); // t+31s — inside the window, must not re-enter
    await ctx.__drain();
    assert.equal(tickCalls, 1, "backoff must hold the agent out of its own tick loop");
    advanceClock(30_000);
    await inst.alarm(); // t+61s — window expired, retries
    await ctx.__drain();
    assert.equal(tickCalls, 2, "the retry resumes after the window");
  } finally {
    cap.restore();
  }
  const pacerErrors = cap.errors.filter((line) => line.includes("[guide-error] agent=pacer"));
  const retryValues = pacerErrors.map((line) => /retryInMs=(\d+)/.exec(line)?.[1]);
  const health = readHealth(inst).pacer;
  console.log(`  [measured] pacer errorLogs=${pacerErrors.length}; retryInMs sequence=${JSON.stringify(retryValues)}`);
  assert.equal(pacerErrors.length, 2, "each swallowed-silently-before failure is now logged");
  assert.deepEqual(retryValues, ["60000", "120000"], "pacer skips double per consecutive failure");
  assert.ok(health && health.consecutiveFailures === 2, "pacer streak is counted");
  assert.equal(llm.calls.length, 0, "a failing tick never reached the model");
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

Date.now = REAL_NOW;
console.log(`\n${passed}/${total} checks passed.`);
if (process.exitCode) {
  console.error("GUIDE FAILURE-PATH TESTS FAILED");
} else {
  console.log("ALL GUIDE FAILURE-PATH TESTS PASSED");
}
