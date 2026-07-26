import { DurableObject } from "cloudflare:workers";

/**
 * SessionDO — one instance per live lab session, keyed
 * `session:{orgId}:{labId}:{sessionId}` by the caller.
 *
 * STUB for Phase 0. This only needs to compile and respond so the
 * `wrangler dev` gate passes. Real implementation — WebSocket fanout,
 * segment state, join-by-code, stateVersion broadcast, D1 checkpointing —
 * is Phase 1 scope, owned by session-spine-engineer (see docs/agent-team.md).
 */
export class SessionDO extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({ error: "not_implemented", phase_needed: 1 }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  }
}
