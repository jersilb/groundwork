#!/usr/bin/env node --experimental-strip-types
// LlmClient hard-timeout tests (bug #6). A provider call that never settles
// must reject at the configured deadline with an identifiable LlmTimeoutError
// instead of holding the guide loop's single guideWorkInFlight mutex — and
// every guide agent behind it — forever.
//
// Every transport here is a fake; no network, no API key. The Anthropic SDK
// round-trip is never invoked because each client is built with an injected
// transport.

import assert from "node:assert/strict";
import {
  AnthropicLlmClient,
  DEFAULT_LLM_TIMEOUT_MS,
  LlmTimeoutError,
} from "../src/guide-engine/llm-client.ts";
import type { LlmCompleteParams, LlmTransport } from "../src/guide-engine/llm-client.ts";

let passed = 0;
function check(label: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS: ${label}`);
      passed += 1;
    })
    .catch((err) => {
      console.error(`FAIL: ${label}`);
      console.error(err);
      process.exitCode = 1;
    });
}

// --- timer hygiene instrumentation -------------------------------------
// complete() must schedule exactly one deadline timer per call and clear it
// again on every exit path. These shims record every scheduled handle and
// drop it when cleared, so the last check can prove no timer leaked.
// Installed after module load, so only timers created by the code under
// test are counted.
const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
const realClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
const outstandingTimers = new Set<unknown>();
let timersScheduled = 0;

globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  timersScheduled += 1;
  const handle = realSetTimeout(fn as (...a: unknown[]) => void, ms, ...args);
  outstandingTimers.add(handle);
  return handle;
}) as typeof globalThis.setTimeout;

globalThis.clearTimeout = ((handle?: unknown) => {
  outstandingTimers.delete(handle);
  realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
}) as typeof globalThis.clearTimeout;

const API_KEY = "test-key-never-used"; // transports are injected; no network
const PARAMS: LlmCompleteParams = {
  system: "You are a test double.",
  messages: [{ role: "user", content: "Say something." }],
  maxTokens: 64,
  model: "claude-test-model",
};

const fastTransport: LlmTransport = async () => ({ text: "steady" });

/** Never settles — models a provider call that hangs forever. */
function hangingTransport(): { transport: LlmTransport; capturedSignal: () => AbortSignal | null } {
  let captured: AbortSignal | null = null;
  return {
    transport: (_params, signal) => {
      captured = signal;
      return new Promise<never>(() => {});
    },
    capturedSignal: () => captured,
  };
}

await check("a fast response is unaffected (default timeout)", async () => {
  const client = new AnthropicLlmClient(API_KEY, { transport: fastTransport });
  assert.deepEqual(await client.complete(PARAMS), { text: "steady" });
});

await check("a hung transport rejects with LlmTimeoutError at the deadline", async () => {
  const { transport, capturedSignal } = hangingTransport();
  const client = new AnthropicLlmClient(API_KEY, { timeoutMs: 80, transport });
  const started = Date.now();
  await assert.rejects(client.complete(PARAMS), (err: unknown) => {
    assert.ok(err instanceof LlmTimeoutError, `expected LlmTimeoutError, got ${String(err)}`);
    assert.equal(err.name, "LlmTimeoutError");
    assert.equal(err.code, "LLM_TIMEOUT");
    assert.match(err.message, /timed out after 80ms/);
    assert.equal(err.timeoutMs, 80);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 60, `rejected before the 80ms deadline (${elapsed}ms)`);
  assert.ok(elapsed < 1500, `rejected long after the deadline (${elapsed}ms)`);
  assert.equal(capturedSignal()?.aborted, true, "the hanging request was never aborted");
});

await check("a provider error passes through unmodified (not a timeout)", async () => {
  const boom = new Error("upstream exploded");
  const client = new AnthropicLlmClient(API_KEY, {
    timeoutMs: 500,
    transport: async () => {
      throw boom;
    },
  });
  await assert.rejects(client.complete(PARAMS), (err: unknown) => {
    assert.equal(err, boom, "the provider error must surface as itself");
    assert.ok(!(err instanceof LlmTimeoutError), "a provider error must not be labelled a timeout");
    return true;
  });
});

await check("a transport that honours abort still reports the identifiable timeout", async () => {
  const client = new AnthropicLlmClient(API_KEY, {
    timeoutMs: 60,
    transport: (_params, signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")));
      }),
  });
  await assert.rejects(client.complete(PARAMS), (err: unknown) => {
    assert.ok(err instanceof LlmTimeoutError, `expected LlmTimeoutError, got ${String(err)}`);
    assert.equal(err.timeoutMs, 60);
    return true;
  });
});

await check("the timeout override moves the boundary both ways", async () => {
  // Resolves at ~150ms via the *original* setTimeout, so this timer is
  // deliberately outside the hygiene tracking above.
  const slowishTransport: LlmTransport = () =>
    new Promise((resolve) => {
      realSetTimeout(() => resolve({ text: "slow but fine" }), 150);
    });

  const shortClient = new AnthropicLlmClient(API_KEY, { timeoutMs: 40, transport: slowishTransport });
  const started = Date.now();
  await assert.rejects(shortClient.complete(PARAMS), (err: unknown) => {
    assert.ok(err instanceof LlmTimeoutError, `expected LlmTimeoutError, got ${String(err)}`);
    return true;
  });
  assert.ok(Date.now() - started < 600, "the shorter override did not shorten the wait");

  const longClient = new AnthropicLlmClient(API_KEY, { timeoutMs: 1000, transport: slowishTransport });
  assert.deepEqual(await longClient.complete(PARAMS), { text: "slow but fine" });
});

await check("the default timeout is a named, exported constant (~20s)", () => {
  assert.equal(DEFAULT_LLM_TIMEOUT_MS, 20_000);
});

await check("every deadline timer was cleared (no leaked handles)", () => {
  assert.ok(timersScheduled >= 6, `expected a deadline timer per call; saw ${timersScheduled}`);
  assert.equal(outstandingTimers.size, 0, `leaked ${outstandingTimers.size} timer handle(s)`);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("LLM TIMEOUT TESTS FAILED");
} else {
  console.log("ALL LLM TIMEOUT TESTS PASSED");
}
