import type { SessionDO } from "./session-do.ts";
import { handleAudioRoute } from "./audio/routes.ts";
import { transcribeAudioChunk } from "./audio/transcribe.ts";
import { handleSynthesisRoute } from "./synthesis/routes.ts";

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
}

const SESSION_CONNECT_PATH = /^\/session\/([A-Za-z0-9_-]+)\/connect$/;

/**
 * Worker entry point. Routes WebSocket upgrades to the SessionDO instance
 * for a given session key (one DO per session, per build plan §3.2), and
 * HTTP routes for the Phase 4 audio pipeline and Phase 5 synthesis.
 *
 * `sessionKey` here is a simple path segment for the hardcoded fake lab
 * used through Phase 1-5 testing. The full `session:{orgId}:{labId}:
 * {sessionId}` naming scheme and human-typeable join codes land in Phase 6
 * when the program layer exists.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", phase: 5 });
    }

    const audioResponse = await handleAudioRoute(request, env, url);
    if (audioResponse) return audioResponse;

    const synthesisResponse = await handleSynthesisRoute(request, env, url);
    if (synthesisResponse) return synthesisResponse;

    const match = url.pathname.match(SESSION_CONNECT_PATH);
    if (match) {
      const sessionKey = match[1];
      const id = env.SESSION_DO.idFromName(sessionKey);
      const stub = env.SESSION_DO.get(id);
      return stub.fetch(request);
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
