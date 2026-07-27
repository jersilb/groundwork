import type { LlmClient, LlmCompleteParams, LlmCompleteResult } from "../llm-client.ts";

/** Test double: always returns a fixed response. Proves parsing/validation
 * logic without a live API key. Does NOT prove model judgment quality.
 *
 * Uses an explicit field + constructor body assignment, not a TS parameter
 * property — Node's --experimental-strip-types can't erase those (they
 * require an actual code transform, not just type-syntax removal), and
 * these classes need to run both under wrangler's esbuild and directly
 * under Node for the test scripts.
 */
export class FixedFakeLlmClient implements LlmClient {
  private readonly response: string;

  constructor(response: string) {
    this.response = response;
  }

  async complete(): Promise<LlmCompleteResult> {
    return { text: this.response };
  }
}

/** Test double: runs a caller-supplied function against the actual prompt
 * content instead of a live model. Used by the eval harness self-test to
 * exercise the precision/recall math on a non-trivial confusion matrix
 * without a real API key. This is a harness self-test, NOT a substitute
 * for measuring real EVALUATOR precision — see docs/capability-gaps.md. */
export class HeuristicFakeLlmClient implements LlmClient {
  private readonly respond: (params: LlmCompleteParams) => string;

  constructor(respond: (params: LlmCompleteParams) => string) {
    this.respond = respond;
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    return { text: this.respond(params) };
  }
}
