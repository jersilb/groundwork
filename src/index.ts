export { SessionDO } from "./session-do";

export interface Env {
  SESSION_DO: DurableObjectNamespace;
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
}

/**
 * Worker entry point. Phase 0: health check only. Session routing to
 * SessionDO instances (join-by-code, WebSocket upgrade) is Phase 1 scope.
 */
export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", phase: 0 });
    }

    return new Response("Not found", { status: 404 });
  },
};
