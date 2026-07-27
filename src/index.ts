import type { SessionDO } from "./session-do";

export { SessionDO } from "./session-do";

export interface Env {
  SESSION_DO: DurableObjectNamespace<SessionDO>;
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
}

const SESSION_CONNECT_PATH = /^\/session\/([A-Za-z0-9_-]+)\/connect$/;

/**
 * Worker entry point. Routes WebSocket upgrades to the SessionDO instance
 * for a given session key (one DO per session, per build plan §3.2).
 *
 * `sessionKey` here is a simple path segment for Phase 1's hardcoded fake
 * lab. The full `session:{orgId}:{labId}:{sessionId}` naming scheme and
 * human-typeable join codes land in Phase 6 when the program layer exists.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", phase: 1 });
    }

    const match = url.pathname.match(SESSION_CONNECT_PATH);
    if (match) {
      const sessionKey = match[1];
      const id = env.SESSION_DO.idFromName(sessionKey);
      const stub = env.SESSION_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
