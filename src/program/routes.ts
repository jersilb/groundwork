import type { Env } from "../index.ts";
import { createOrg, createUser, type CreateOrgBody, type CreateUserBody } from "./org.ts";
import { createProgram, scheduleLabSession, completeLabSession, recordConsent, getProgramState, LabSequenceError } from "./program.ts";
import { createInitiative, addInitiativeStep, getOverdueSteps, type CreateInitiativeBody } from "./initiatives.ts";
import { generateNudge, fallbackNudge } from "./coach.ts";
import { AnthropicLlmClient } from "../guide-engine/llm-client.ts";
import { createReviewCycle, completeReviewCycle, computeHealthSnapshot } from "./review-cycle.ts";

async function json<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

async function route(request: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const method = request.method;

  if (p === "/org" && method === "POST") {
    const body = await json<CreateOrgBody>(request);
    const id = await createOrg(env, body);
    return Response.json({ id }, { status: 201 });
  }

  let m = p.match(/^\/org\/([A-Za-z0-9_-]+)\/users$/);
  if (m && method === "POST") {
    const body = await json<CreateUserBody>(request);
    const id = await createUser(env, m[1], body);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/org\/([A-Za-z0-9_-]+)\/program$/);
  if (m && method === "POST") {
    const id = await createProgram(env, m[1]);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)$/);
  if (m && method === "GET") {
    const program = await getProgramState(env, m[1]);
    if (!program) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(program);
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/lab-session$/);
  if (m && method === "POST") {
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
    await completeLabSession(env, m[1]);
    return Response.json({ status: "ok" });
  }

  m = p.match(/^\/lab-session\/([A-Za-z0-9_-]+)\/consent$/);
  if (m && method === "POST") {
    const body = await json<{ consentedBy: string }>(request);
    await recordConsent(env, m[1], body.consentedBy);
    return Response.json({ status: "ok" });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/initiative$/);
  if (m && method === "POST") {
    const body = await json<CreateInitiativeBody>(request);
    const id = await createInitiative(env, m[1], body);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/initiative\/([A-Za-z0-9_-]+)\/step$/);
  if (m && method === "POST") {
    const body = await json<{ description: string; ownerUserId?: string; dueDate?: string }>(request);
    const id = await addInitiativeStep(env, m[1], body.description, body.ownerUserId, body.dueDate);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/overdue-steps$/);
  if (m && method === "GET") {
    const steps = await getOverdueSteps(env, m[1]);
    return Response.json({ steps });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/coach\/nudges$/);
  if (m && method === "POST") {
    const steps = await getOverdueSteps(env, m[1]);
    const llm = env.ANTHROPIC_API_KEY ? new AnthropicLlmClient(env.ANTHROPIC_API_KEY) : null;
    const nudges = [];
    for (const step of steps) {
      const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(step.due_date).getTime()) / 86_400_000));
      const nudge = llm ? await generateNudge(step, llm) : fallbackNudge(step, daysOverdue);
      nudges.push({ stepId: step.step_id, ...nudge });
    }
    return Response.json({ nudges, personalized: Boolean(llm) });
  }

  m = p.match(/^\/program\/([A-Za-z0-9_-]+)\/review-cycle$/);
  if (m && method === "POST") {
    const body = await json<{ periodStart: string; periodEnd: string }>(request);
    const id = await createReviewCycle(env, m[1], body.periodStart, body.periodEnd);
    return Response.json({ id }, { status: 201 });
  }

  m = p.match(/^\/review-cycle\/([A-Za-z0-9_-]+)\/complete$/);
  if (m && method === "POST") {
    const body = await json<{ programId: string }>(request);
    const snapshot = await computeHealthSnapshot(env, body.programId);
    await completeReviewCycle(env, m[1], snapshot);
    return Response.json({ status: "ok", snapshot });
  }

  return null;
}

export const handleProgramRoute = route;
