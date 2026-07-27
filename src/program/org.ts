import type { Env } from "../index.ts";

// Org and user setup — build plan §4/§7 Phase 6. First real use of the
// organization/user tables from the Phase 0 schema; Phases 1-5 deliberately
// used lightweight parallel tables (session_checkpoint, session_audio_chunk,
// session_plan_artifact) rather than force fake-lab test data into these
// real tables' foreign-key relationships before they had real meaning.

export interface CreateOrgBody {
  name: string;
  type: "church" | "parachurch" | "nonprofit" | "school";
  annualBudgetBand?: string;
}

export async function createOrg(env: Env, body: CreateOrgBody): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO organization (id, name, type, context_pack, annual_budget_band, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, body.name, body.type, body.type === "church" ? "church" : body.type, body.annualBudgetBand ?? null, new Date().toISOString())
    .run();
  return id;
}

export interface CreateUserBody {
  email: string;
  name: string;
  role: "leader" | "member" | "observer";
}

export async function createUser(env: Env, orgId: string, body: CreateUserBody): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO user (id, org_id, email, name, role, invited_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, orgId, body.email, body.name, body.role, new Date().toISOString())
    .run();
  return id;
}
