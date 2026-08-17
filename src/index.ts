import type { SessionDO } from "./session-do.ts";
import { handleAudioRoute } from "./audio/routes.ts";
import { transcribeAudioChunk } from "./audio/transcribe.ts";
import { handleSynthesisRoute } from "./synthesis/routes.ts";
import { handleProgramRoute } from "./program/routes.ts";
import { handleCommerceRoute } from "./commerce/routes.ts";

export { SessionDO } from "./session-do.ts";

export interface TranscriptionQueueMessage {
  chunkId: string;
  r2Key: string;
}

export interface Env {
  SESSION_DO: DurableObjectNamespace<SessionDO>;
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TRANSCRIPTION_QUEUE: Queue<TranscriptionQueueMessage>;
  AI: Ai;
  ANTHROPIC_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Built frontend (dist/ via the [assets] binding) — served on GETs
   * that no API/WebSocket route matched, with an SPA fallback. */
  ASSETS?: Fetcher;
}

const SESSION_CONNECT_PATH = /^\/session\/([A-Za-z0-9_-]+)\/connect$/;

/**
 * Worker entry point. Routes WebSocket upgrades to the SessionDO instance
 * for a given session key (one DO per session, per build plan §3.2), and
 * HTTP routes for the Phase 4 audio pipeline and Phase 5 synthesis.
 *
 * `sessionKey` is the join code used by /session/:key/connect. The
 * hardcoded fake lab used through Phase 1-5 testing accepts any unique key
 * (tests use timestamped keys); real lab_sessions open rooms with the
 * deterministic key "lab-<labSessionId>" via POST /lab-session/:id/open
 * (src/program/program.ts). The connect regex accepts both.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", phase: 7 });
    }

    const audioResponse = await handleAudioRoute(request, env, url);
    if (audioResponse) return audioResponse;

    const synthesisResponse = await handleSynthesisRoute(request, env, url);
    if (synthesisResponse) return synthesisResponse;

    const programResponse = await handleProgramRoute(request, env, url);
    if (programResponse) return programResponse;

    const commerceResponse = await handleCommerceRoute(request, env, url);
    if (commerceResponse) return commerceResponse;

    const match = url.pathname.match(SESSION_CONNECT_PATH);
    if (match) {
      const sessionKey = match[1];
      const id = env.SESSION_DO.idFromName(sessionKey);
      const stub = env.SESSION_DO.get(id);
      return stub.fetch(request);
    }

    // Static frontend: serve the built PWA for GETs, with a single-page
    // fallback to index.html for client-side routes (no file extension).
    // The assets service answers missing paths with 404 or a 307 trailing-
    // slash redirect; both mean "no such file" for a path with no extension.
    if (request.method === "GET" && env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      const notFoundish =
        assetResponse.status === 404 ||
        assetResponse.status === 307 ||
        assetResponse.status === 308;
      if (notFoundish && !/\.[a-zA-Z0-9]+$/.test(url.pathname)) {
        const indexUrl = new URL("/index.html", request.url);
        return env.ASSETS.fetch(new Request(indexUrl, request));
      }
      return assetResponse;
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Queue-triggered Whisper transcription — build plan §3.4 step 3.
   * A transient failure (or, in this dev sandbox, a fully network-blocked
   * Workers AI call — see docs/capability-gaps.md, 2026-07-27) retries the
   * message rather than dropping the chunk silently.
   */
  async queue(batch: MessageBatch<TranscriptionQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { chunkId, r2Key } = message.body;
      const result = await transcribeAudioChunk(env, r2Key);
      if ("error" in result) {
        await env.DB.prepare(`UPDATE session_audio_chunk SET transcription_error = ?1 WHERE id = ?2`)
          .bind(result.error, chunkId)
          .run();
        message.retry();
      } else {
        await env.DB.prepare(
          `UPDATE session_audio_chunk SET text = ?1, transcribed_at = ?2, transcription_error = NULL WHERE id = ?3`,
        )
          .bind(result.text, new Date().toISOString(), chunkId)
          .run();
        message.ack();
      }
    }
  },
};
