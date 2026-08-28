import type { Env } from "../index.ts";
import type { SegmentSpec } from "../guide-engine/segment-schema.ts";
import { parseSegmentSpec } from "../guide-engine/segment-schema.ts";
import { runSynthesizer, ProvenanceVerificationError, SynthesizerParseError } from "../guide-engine/synthesizer.ts";
import { AnthropicLlmClient } from "../guide-engine/llm-client.ts";
import { saveArtifact, getCurrentArtifacts } from "./plan-artifact-store.ts";
import { assembleOnePager, renderOnePagerMarkdown } from "./one-pager.ts";
import { authorizeSessionAccess } from "../auth/authorize.ts";

interface SynthesizeRequestBody {
  segment: SegmentSpec;
  submissions: string[];
  transcriptWindow?: string;
}

async function handleSynthesize(request: Request, env: Env, sessionId: string): Promise<Response> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }
  const body = (await request.json()) as SynthesizeRequestBody;
  if (!body.segment || !Array.isArray(body.submissions)) {
    return Response.json({ error: "segment and submissions are required" }, { status: 400 });
  }
  // The segment spec is validated before it reaches the model: a malformed
  // spec (missing rubric, bad enum) would otherwise surface as a confusing
  // 502 from the LLM call instead of a precise 400 here.
  try {
    parseSegmentSpec(body.segment);
  } catch (err) {
    return Response.json({ error: "invalid segment spec", message: String(err) }, { status: 400 });
  }

  const llm = new AnthropicLlmClient(apiKey);
  try {
    const result = await runSynthesizer(
      { segment: body.segment, submissions: body.submissions, transcriptWindow: body.transcriptWindow },
      llm,
    );
    const savedIds: string[] = [];
    for (const artifact of result.artifacts) {
      savedIds.push(await saveArtifact(env, sessionId, artifact));
    }
    return Response.json({ status: "ok", savedArtifactIds: savedIds, artifacts: result.artifacts });
  } catch (err) {
    if (err instanceof ProvenanceVerificationError) {
      return Response.json({ error: "provenance_verification_failed", message: err.message }, { status: 422 });
    }
    if (err instanceof SynthesizerParseError) {
      return Response.json({ error: "synthesizer_parse_failed", message: err.message }, { status: 502 });
    }
    throw err;
  }
}

async function handleGetPlan(env: Env, sessionId: string): Promise<Response> {
  const artifacts = await getCurrentArtifacts(env, sessionId);
  const plan = assembleOnePager(sessionId, artifacts);
  return Response.json({ plan, markdown: renderOnePagerMarkdown(plan) });
}

const SYNTHESIS_ROUTE = /^\/session\/([A-Za-z0-9_-]+)\/(synthesize|plan)$/;

export async function handleSynthesisRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(SYNTHESIS_ROUTE);
  if (!match) return null;
  const [, sessionId, action] = match;

  // Org authorization for real lab rooms — GET /plan included. The
  // one-page plan is the most sensitive output this Worker serves; it must
  // not be world-readable given a session key.
  const access = await authorizeSessionAccess(request, env, sessionId);
  if (access.kind === "error") return access.response;

  if (action === "synthesize" && request.method === "POST") {
    return handleSynthesize(request, env, sessionId);
  }
  if (action === "plan" && request.method === "GET") {
    return handleGetPlan(env, sessionId);
  }
  return new Response("Method not allowed", { status: 405 });
}
