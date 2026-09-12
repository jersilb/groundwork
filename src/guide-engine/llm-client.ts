import Anthropic from "@anthropic-ai/sdk";

// Node contract (docs/agent-team.md topology rules): explicit input/output
// shape for every LLM-backed agent call, regardless of which model answers it.
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCompleteParams {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  model: string;
}

export interface LlmCompleteResult {
  text: string;
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<LlmCompleteResult>;
}

/** Hard timeout for one complete() call, in milliseconds. A hung provider
 * call must reject rather than hold the Durable Object's single
 * guideWorkInFlight mutex — and every guide agent queued behind it —
 * forever (guide-hardening bug #6). */
export const DEFAULT_LLM_TIMEOUT_MS = 20_000;

/** Identifiable failure for a call that ran past its hard timeout.
 * Match on `code` ("LLM_TIMEOUT") across module boundaries. */
export class LlmTimeoutError extends Error {
  readonly code = "LLM_TIMEOUT";
  readonly timeoutMs: number;
  readonly model: string;

  constructor(timeoutMs: number, model: string, options?: ErrorOptions) {
    super(`LlmClient.complete timed out after ${timeoutMs}ms (model: ${model})`, options);
    this.name = "LlmTimeoutError";
    this.timeoutMs = timeoutMs;
    this.model = model;
  }
}

/** One provider round-trip. Receives the call's AbortSignal so a
 * cooperating transport can cancel in-flight work when the deadline
 * fires. Injectable so tests can exercise timing with fakes instead of
 * the network — see scripts/test-llm-timeout.ts. */
export type LlmTransport = (params: LlmCompleteParams, signal: AbortSignal) => Promise<LlmCompleteResult>;

export interface AnthropicLlmClientOptions {
  /** Hard timeout for one complete() call, in milliseconds.
   * Defaults to DEFAULT_LLM_TIMEOUT_MS (20 s). */
  timeoutMs?: number;
  /** Test seam: replaces the Anthropic SDK round-trip. */
  transport?: LlmTransport;
}

/**
 * Real Anthropic-backed client. Requires ANTHROPIC_API_KEY as a Workers
 * secret (`wrangler secret put ANTHROPIC_API_KEY`) — not present in this
 * dev environment. The SDK round-trip itself is not exercised by any
 * automated test (see docs/capability-gaps.md, 2026-07-27); the timeout
 * wrapper around it is covered by scripts/test-llm-timeout.ts through an
 * injected transport.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private readonly transport: LlmTransport;

  constructor(apiKey: string, options: AnthropicLlmClientOptions = {}) {
    this.client = new Anthropic({ apiKey });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.transport =
      options.transport ??
      (async (params, signal) => {
        const response = await this.client.messages.create(
          {
            model: params.model,
            max_tokens: params.maxTokens,
            system: params.system,
            messages: params.messages,
          },
          { signal },
        );
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
        return { text: textBlock?.text ?? "" };
      });
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Abort first so a cooperating transport (the real SDK fetch)
        // cancels its request, then settle the race with the identifiable
        // error. Transports that ignore the signal are covered by the
        // rejection itself.
        controller.abort();
        reject(new LlmTimeoutError(this.timeoutMs, params.model));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([this.transport(params, controller.signal), deadline]);
    } catch (err) {
      if (err instanceof LlmTimeoutError) throw err;
      // A transport that honours the abort can reject with its own abort
      // error before the deadline rejection is observed. The signal can
      // only have been aborted by this deadline, so normalise.
      if (controller.signal.aborted) {
        throw new LlmTimeoutError(this.timeoutMs, params.model, { cause: err });
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
