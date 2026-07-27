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

/**
 * Real Anthropic-backed client. Requires ANTHROPIC_API_KEY as a Workers
 * secret (`wrangler secret put ANTHROPIC_API_KEY`) — not present in this
 * dev environment. Not exercised by any automated test in this repo.
 * See docs/capability-gaps.md, 2026-07-27.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
    });
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return { text: textBlock?.text ?? "" };
  }
}
