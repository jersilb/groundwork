import type { SessionDO } from "./session-do.ts";
import { SPINE_REFERENCE_PLAN } from "./session-plan.ts";
import { handleAudioRoute } from "./audio/routes.ts";
import { transcribeAudioChunk } from "./audio/transcribe.ts";
import { handleSynthesisRoute } from "./synthesis/routes.ts";
import { handleProgramRoute } from "./program/routes.ts";
import { handleCommerceRoute } from "./commerce/routes.ts";
import { authenticateRequest } from "./auth/cloudflare-access.ts";

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
  /** Cloudflare Access team domain, e.g. "your-team". When set, all
   * state-changing routes require a valid CF-Access-Jwt-Assertion header. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag. When set, Access JWTs must
   * carry this audience — without it, any token signed by the team's certs
   * from ANY Access application in the team is accepted. */
  CF_ACCESS_AUD?: string;
  /** Enables the header-based dev auth bypass. `wrangler dev` sets this to
   * "true" (via --var or a local .dev.vars) so local runs and integration
   * tests need no Cloudflare Access. Production must NOT set it: with it
   * unset, a missing CF_ACCESS_TEAM_DOMAIN fails closed instead of trusting
   * client-supplied identity headers. */
  DEV_AUTH_BYPASS?: string;
  /** Master switch for the in-session Guide Engine (PACER/EVALUATOR/
   * PROBER/SYNTHESIZER). "false" disables it even when ANTHROPIC_API_KEY
   * exists — local tests set this in .dev.vars so no suite depends on a
   * live LLM. Production sets GUIDE_ENABLED="true" via [vars]. */
  GUIDE_ENABLED?: string;
  /** Session-spine switch (build plan §5.2/§6 Release 0). "true" opens new
   * sessions on the six-hour reference plan with the full runtime (state
   * machine, clock, breaks, breakouts, output audit, event log). Unset or
   * any other value keeps the legacy lab behavior unchanged. */
  SESSION_SPINE?: string;
  /** Built frontend (dist/ via the [assets] binding) — served on GETs
   * that no API/WebSocket route matched, with an SPA fallback. */
  ASSETS?: Fetcher;
}

const SESSION_CONNECT_PATH = /^\/session\/([A-Za-z0-9_-]+)\/connect$/;

/** Identity headers this Worker sets after it verifies a request. Any inbound
 * copy is removed before routing, so a route reads an identity only when
 * index.ts put it there. */
const IDENTITY_HEADERS = [
  "X-Groundwork-Auth-Email",
  "X-Groundwork-Auth-Sub",
  "X-Groundwork-Auth-Name",
  "X-Groundwork-Dev-User",
  "X-Groundwork-Dev-Sub",
];

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

    // The session-spine reference plan (build plan §7) as data. It is a
    // synthetic technical fixture — safe to serve unauthenticated; real
    // curriculum stays behind the IP firewall and is never served here.
    if (url.pathname === "/session-plans/reference" && request.method === "GET") {
      return Response.json(SPINE_REFERENCE_PLAN, { headers: { "cache-control": "public, max-age=3600" } });
    }

    // Resolve identity from a credential this Worker verifies.
    //
    // The X-Groundwork-Auth-* headers are trusted only when this Worker sets
    // them, so any inbound copy is removed before routing. Previously a GET
    // skipped this block and the route read the caller's own
    // X-Groundwork-Auth-Email header, letting an anonymous caller choose an
    // identity.
    //
    // A presented credential is verified on every method (not just
    // mutations), so session-scoped GETs (the one-page plan, consent status)
    // get the same verified identity as writes.
    //
    // /webhooks/* stays exempt from the auth requirement: Stripe's servers
    // cannot present a CF Access JWT, and webhook requests authenticate
    // themselves via their HMAC signature (verified in handleCommerceRoute).
    const headers = new Headers(request.headers);
    const hadIdentityHeader = IDENTITY_HEADERS.some((name) => request.headers.has(name));
    for (const name of IDENTITY_HEADERS) headers.delete(name);

    const hasCredential =
      request.headers.has("CF-Access-Jwt-Assertion") ||
      (env.DEV_AUTH_BYPASS === "true" && request.headers.has("X-Groundwork-Dev-User"));

    const requiresAuth =
      request.method !== "GET" &&
      request.method !== "OPTIONS" &&
      request.method !== "HEAD" &&
      !url.pathname.startsWith("/webhooks/");

    if (hasCredential || requiresAuth) {
      const authResult = await authenticateRequest(request, env);
      if (authResult.kind === "error") return authResult.response;
      headers.set("X-Groundwork-Auth-Email", authResult.auth.email);
      headers.set("X-Groundwork-Auth-Sub", authResult.auth.sub);
      headers.set("X-Groundwork-Auth-Name", authResult.auth.name ?? "");
    }

    if (hasCredential || requiresAuth || hadIdentityHeader) {
      request = new Request(request, { headers });
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
