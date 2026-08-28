import type { Env } from "../index.ts";
import { authenticateRequest, requireOrgMember } from "./cloudflare-access.ts";

// Session-scoped route authorization.
//
// GETs skip index.ts's auth gate by design (static assets, health), but
// session-scoped GETs (the one-page plan, consent status) read a real
// org's data, and session-scoped POSTs can mutate another org's session.
// Real lab rooms use the deterministic "lab-<labSessionId>" key from
// openLabSession, so they can be authorized against the org that owns the
// lab_session. Ad-hoc sessions (test harness keys, timestamps) have no
// org mapping and keep the pre-auth open behavior — they exist only for
// automated tests and throwaway manual runs, never for real orgs.

const LAB_KEY_PATTERN = /^lab-([A-Za-z0-9_-]+)$/;

export type SessionAuthResult =
  | { kind: "ok" }
  | { kind: "error"; response: Response };

export async function authorizeSessionAccess(
  request: Request,
  env: Env,
  sessionKey: string,
): Promise<SessionAuthResult> {
  const match = sessionKey.match(LAB_KEY_PATTERN);
  if (!match) return { kind: "ok" };

  const authResult = await authenticateRequest(request, env);
  if (authResult.kind === "error") return authResult;

  const row = await env.DB
    .prepare(
      `SELECT p.org_id FROM lab_session ls JOIN program p ON p.id = ls.program_id WHERE ls.id = ?1 LIMIT 1`,
    )
    .bind(match[1])
    .first<{ org_id: string }>();
  if (!row) {
    return { kind: "error", response: new Response("session not found", { status: 404 }) };
  }
  const membership = await requireOrgMember(env, authResult.auth, row.org_id);
  if (!membership) {
    return {
      kind: "error",
      response: new Response("not authorized for this organization", { status: 403 }),
    };
  }
  return { kind: "ok" };
}
