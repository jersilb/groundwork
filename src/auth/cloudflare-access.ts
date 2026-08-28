import type { Env } from "../index.ts";

/** Authentication context attached to a verified request. */
export interface AuthContext {
  email: string;
  sub: string;
  name?: string;
}

/** Per-request auth result — either a verified user or an error response. */
export type AuthResult =
  | { kind: "ok"; auth: AuthContext }
  | { kind: "error"; response: Response };

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface JwtPayload {
  sub: string;
  email: string;
  name?: string;
  aud: string;
  exp: number;
  iat: number;
  nbf?: number;
  iss?: string;
}

interface CertsResponse {
  keys: JsonWebKey[];
}

/** Decode a JWT without verifying the signature. */
function decodeJwt(token: string): { header: JwtHeader; payload: JwtPayload } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(atob(parts[0])) as JwtHeader;
    const payload = JSON.parse(atob(parts[1])) as JwtPayload;
    return { header, payload };
  } catch {
    return null;
  }
}

/** Cloudflare Access public-key cache, stored on env for the lifetime of the isolate. */
const certCache = new Map<string, { keys: CryptoKey[]; fetchedAt: number }>();
const CERT_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function importJwk(key: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function fetchAccessCerts(teamDomain: string): Promise<CryptoKey[]> {
  const cacheKey = teamDomain;
  const cached = certCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CERT_TTL_MS) {
    return cached.keys;
  }

  const res = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new Error(`Cloudflare Access certs fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as CertsResponse;
  const keys = await Promise.all(body.keys.map(importJwk));
  certCache.set(cacheKey, { keys, fetchedAt: Date.now() });
  return keys;
}

async function verifyAccessJwt(token: string, teamDomain: string, audience?: string): Promise<AuthContext | null> {
  const decoded = decodeJwt(token);
  if (!decoded) return null;

  const { header, payload } = decoded;
  if (header.alg !== "RS256") return null;
  // Audience binding: Access JWTs name the application (AUD tag) they were
  // issued for. Without this check, any RS256 token signed by the team's
  // certs — from any Access app in the team — would authenticate here.
  if (audience && payload.aud !== audience) return null;

  const keys = await fetchAccessCerts(teamDomain);
  const data = new TextEncoder().encode(token.split(".").slice(0, 2).join("."));
  const signature = Uint8Array.from(atob(token.split(".")[2]), (c) => c.charCodeAt(0));

  for (const key of keys) {
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
    if (valid) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) return null;
      if (payload.nbf && payload.nbf > now) return null;
      if (!payload.email) return null;
      return { email: payload.email, sub: payload.sub, name: payload.name };
    }
  }
  return null;
}

/**
 * Authenticate a request.
 *
 * Production: validates the CF-Access-Jwt-Assertion header against the
 * team's Cloudflare Access public keys (env.CF_ACCESS_TEAM_DOMAIN).
 *
 * Local dev (no CF_ACCESS_TEAM_DOMAIN): accepts X-Groundwork-Dev-User and
 * X-Groundwork-Dev-Sub headers so `wrangler dev` and integration tests can
 * run without Access. This bypass is disabled in production.
 */
export async function authenticateRequest(request: Request, env: Env): Promise<AuthResult> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const jwt = request.headers.get("CF-Access-Jwt-Assertion");

  if (teamDomain && jwt) {
    const auth = await verifyAccessJwt(jwt, teamDomain, env.CF_ACCESS_AUD);
    if (!auth) {
      return { kind: "error", response: new Response("invalid access token", { status: 401 }) };
    }
    return { kind: "ok", auth };
  }

  if (teamDomain && !jwt) {
    return { kind: "error", response: new Response("access token required", { status: 401 }) };
  }

  // Dev bypass — only when Cloudflare Access is not configured.
  const devUser = request.headers.get("X-Groundwork-Dev-User");
  const devSub = request.headers.get("X-Groundwork-Dev-Sub");
  if (devUser && devSub) {
    return { kind: "ok", auth: { email: devUser, sub: devSub } };
  }

  return { kind: "error", response: new Response("authentication required", { status: 401 }) };
}

/**
 * Look up the authenticated user's record(s) in D1.
 * Returns the matching user row if the caller belongs to the given org.
 */
export async function requireOrgMember(
  env: Env,
  auth: AuthContext,
  orgId: string,
): Promise<{ userId: string; role: string } | null> {
  const row = await env.DB
    .prepare(`SELECT id, role FROM user WHERE email = ?1 AND org_id = ?2 LIMIT 1`)
    .bind(auth.email, orgId)
    .first<{ id: string; role: string }>();
  return row ? { userId: row.id, role: row.role } : null;
}

/**
 * Look up the authenticated user's role in a program's org.
 */
export async function requireProgramMember(
  env: Env,
  auth: AuthContext,
  programId: string,
): Promise<{ userId: string; orgId: string; role: string } | null> {
  const row = await env.DB
    .prepare(
      `SELECT u.id as user_id, u.role, p.org_id
       FROM user u
       JOIN program p ON p.org_id = u.org_id
       WHERE u.email = ?1 AND p.id = ?2
       LIMIT 1`,
    )
    .bind(auth.email, programId)
    .first<{ user_id: string; role: string; org_id: string }>();
  return row ? { userId: row.user_id, orgId: row.org_id, role: row.role } : null;
}

/**
 * Create a user row for the authenticated email when they create an org.
 */
export async function upsertOrgCreator(
  env: Env,
  auth: AuthContext,
  orgId: string,
): Promise<string> {
  const existing = await env.DB
    .prepare(`SELECT id FROM user WHERE email = ?1 AND org_id = ?2 LIMIT 1`)
    .bind(auth.email, orgId)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await env.DB
    .prepare(`INSERT INTO user (id, org_id, email, name, role, invited_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(id, orgId, auth.email, auth.name ?? auth.email.split("@")[0], "leader", new Date().toISOString())
    .run();
  return id;
}

/**
 * Extract an already-verified auth context from request headers. Route
 * handlers call this; index.ts is responsible for the actual verification
 * on mutating requests. This helper also accepts the dev-bypass headers
 * directly so GETs and WebSocket upgrades can carry identity without
 * requiring a full re-verification pass.
 */
export function getAuthFromRequest(request: Request): AuthContext | null {
  const email = request.headers.get("X-Groundwork-Auth-Email")
    ?? request.headers.get("X-Groundwork-Dev-User");
  const sub = request.headers.get("X-Groundwork-Auth-Sub")
    ?? request.headers.get("X-Groundwork-Dev-Sub");
  if (!email || !sub) return null;
  const name = request.headers.get("X-Groundwork-Auth-Name")
    ?? undefined;
  return { email, sub, name };
}
