import type { Env } from "../index.ts";
import { createOrg, createUser, type CreateOrgBody, type CreateUserBody } from "./org.ts";
import { createProgram, scheduleLabSession, completeLabSession, recordConsent, getProgramState, openLabSession, LabSequenceError } from "./program.ts";
import { createInitiative, addInitiativeStep, getOverdueSteps, type CreateInitiativeBody } from "./initiatives.ts";
import { generateNudgesForProgram } from "./coach.ts";
import { createReviewCycle, completeReviewCycle, computeHealthSnapshot } from "./review-cycle.ts";
import { upsertOrgCreator, requireOrgMember, requireProgramMember, getAuthFromRequest, type AuthContext } from "../auth/cloudflare-access.ts";

async function json<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

/** Pull the auth context added by index.ts after CF Access / dev-bypass validation. */
function getAuth(request: Request): AuthContext | null {
  return getAuthFromRequest(request);
}

function authRequired(): Response {
  return Response.json({ error: "authentication required" }, { status: 401 });
}

function forbidden(): Response {
  return Response.json({ error: "not authorized for this organization" }, { status: 403 });
}

async function requireLabSessionOrg(env: Env, labSessionId: string): Promise<string | null> {
  const row = await env.DB
    .prepare(`SELECT p.org_id FROM lab_session ls JOIN program p ON p.id = ls.program_id WHERE ls.id = ?1 LIMIT 1`)
    .bind(labSessionId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

async function requireInitiativeOrg(env: Env, initiativeId: string): Promise<string | null> {
  const row = await env.DB
    .prepare(`SELECT p.org_id FROM initiative i JOIN program p ON p.id = i.program_id WHERE i.id = ?1 LIMIT 1`)
    .bind(initiativeId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

async function requireReviewCycleOrg(env: Env, reviewCycleId: string): Promise<string | null> {
  const row = await env.DB
    .prepare(`SELECT p.org_id FROM review_cycle rc JOIN program p ON p.id = rc.program_id WHERE rc.id = ?1 LIMIT 1`)
    .bind(reviewCycleId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

async function route(request: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const method = request.method;

  if (p === "/org" && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const body = await json<CreateOrgBody>(request);
    const id = await createOrg(env, body);
    await upsertOrgCreator(env, auth, id);
    return Response.json({ id }, { status: 201 });
  }

  let m = p.match(/^\/org\/([A-Za-z0-9_-]+)\/users$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const membership = await requireOrgMember(env, auth, m[1]);
    if (!membership) return forbidden();
    if (membership.role !== "leader") {
      return Response.json({ error: "only leaders can invite users" }, { status: 403 });
    }
    const body = await json<CreateUserBody>(request);
    const id = await createUser(env, m[1], body);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/org\/([A-Za-z0-9_-]+)\/program$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireOrgMember(env, auth, m[1]))) return forbidden();
    const id = await createProgram(env, m[1]);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)$/);
  if (m && method === "GET") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireProgramMember(env, auth, m[1]))) return forbidden();
    const program = await getProgramState(env, m[1]);
    if (!program) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(program);
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/lab-session$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireProgramMember(env, auth, m[1]))) return forbidden();
    const body = await json<{ labNumber: number; scheduledFor: string }>(request);
    try {
      const id = await scheduleLabSession(env, m[1], body.labNumber, body.scheduledFor);
      return Response.json({ id }, { status: 201 });
    } catch (err) {
      if (err instanceof LabSequenceError) return Response.json({ error: err.message }, { status: 409 });
      throw err;
    }
  }

  m = p.match(/^\/lab-session\/([A-Za-z0-9_-]+)\/complete$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const orgId = await requireLabSessionOrg(env, m[1]);
    if (!orgId || !(await requireOrgMember(env, auth, orgId))) return forbidden();
    await completeLabSession(env, m[1]);
    return Response.json({ status: "ok" });
  }

  m = p.match(/^\/lab-session\/([A-Za-z0-9_-]+)\/open$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const orgId = await requireLabSessionOrg(env, m[1]);
    // §5.5: the shared screen is the leader's instrument, and opening a
    // room mints its screen token — leader role required.
    const membership = orgId ? await requireOrgMember(env, auth, orgId) : null;
    if (!orgId || !membership || membership.role !== "leader") {
      return forbidden();
    }
    try {
      const opened = await openLabSession(env, m[1]);
      if (!opened) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(opened, { status: 201 });
    } catch (err) {
      if (err instanceof LabSequenceError) return Response.json({ error: err.message }, { status: 409 });
      throw err;
    }
  }

  m = p.match(/^\/lab-session\/([A-Za-z0-9_-]+)\/consent$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const orgId = await requireLabSessionOrg(env, m[1]);
    if (!orgId || !(await requireOrgMember(env, auth, orgId))) return forbidden();
    const body = await json<{ consentedBy: string }>(request);
    await recordConsent(env, m[1], body.consentedBy);
    return Response.json({ status: "ok" });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/initiative$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireProgramMember(env, auth, m[1]))) return forbidden();
    const body = await json<CreateInitiativeBody>(request);
    const id = await createInitiative(env, m[1], body);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/initiative\/([A-Za-z0-9_-]+)\/step$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const orgId = await requireInitiativeOrg(env, m[1]);
    if (!orgId || !(await requireOrgMember(env, auth, orgId))) return forbidden();
    const body = await json<{ description: string; ownerUserId?: string; dueDate?: string }>(request);
    const id = await addInitiativeStep(env, m[1], body.description, body.ownerUserId, body.dueDate);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/overdue-steps$/);
  if (m && method === "GET") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireProgramMember(env, auth, m[1]))) return forbidden();
    const steps = await getOverdueSteps(env, m[1]);
    return Response.json({ steps });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/coach\/nudges$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireProgramMember(env, auth, m[1]))) return forbidden();
    // The dashboard calls this on every load, so the throttle and dedupe live
    // server-side in D1 (see coach.ts) — a refresh cannot re-spend the budget.
    return Response.json(await generateNudgesForProgram(env, m[1]));
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/review-cycle$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    if (!(await requireProgramMember(env, auth, m[1]))) return forbidden();
    const body = await json<{ periodStart: string; periodEnd: string }>(request);
    const id = await createReviewCycle(env, m[1], body.periodStart, body.periodEnd);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/review-cycle\/([A-Za-z0-9_-]+)\/complete$/);
  if (m && method === "POST") {
    const auth = getAuth(request);
    if (!auth) return authRequired();
    const body = await json<{ programId: string }>(request);
    const orgId = await requireReviewCycleOrg(env, m[1]);
    if (!orgId || !(await requireOrgMember(env, auth, orgId))) return forbidden();
    // The snapshot target must belong to the same org as the review cycle.
    // programId arrives in the body, so authorizing the review cycle alone
    // would let a caller read another org's health snapshot.
    const programOrgId = await env.DB
      .prepare(`SELECT org_id FROM program WHERE id = ?1 LIMIT 1`)
      .bind(body.programId)
      .first<{ org_id: string } | null>()
      .then((row) => row?.org_id ?? null);
    if (!programOrgId || programOrgId !== orgId) {
      return Response.json({ error: "program does not belong to this organization" }, { status: 403 });
    }
    const snapshot = await computeHealthSnapshot(env, body.programId);
    await completeReviewCycle(env, m[1], snapshot);
    return Response.json({ status: "ok", snapshot });
  }

  return null;
}

export const handleProgramRoute = route;