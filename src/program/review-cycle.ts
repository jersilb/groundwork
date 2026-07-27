import type { Env } from "../index.ts";

// Monthly review rhythm — build plan §6 "Then: Monthly review — 45 minutes,
// in-app, guide-led, initiative health and course correction."

export async function createReviewCycle(env: Env, programId: string, periodStart: string, periodEnd: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO review_cycle (id, program_id, period_start, period_end) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(id, programId, periodStart, periodEnd)
    .run();
  return id;
}

export interface HealthSnapshot {
  greenCount: number;
  amberCount: number;
  redCount: number;
  overdueStepCount: number;
}

export async function completeReviewCycle(env: Env, reviewCycleId: string, snapshot: HealthSnapshot): Promise<void> {
  await env.DB.prepare(
    `UPDATE review_cycle SET completed_at = ?1, health_snapshot_json = ?2 WHERE id = ?3`,
  )
    .bind(new Date().toISOString(), JSON.stringify(snapshot), reviewCycleId)
    .run();
}

export async function computeHealthSnapshot(env: Env, programId: string): Promise<HealthSnapshot> {
  const { results } = await env.DB.prepare(
    `SELECT health, COUNT(*) as n FROM initiative WHERE program_id = ?1 GROUP BY health`,
  )
    .bind(programId)
    .all<{ health: string; n: number }>();

  const counts = { green: 0, amber: 0, red: 0 };
  for (const row of results) {
    if (row.health in counts) counts[row.health as "green" | "amber" | "red"] = row.n;
  }

  const overdue = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM initiative_step s JOIN initiative i ON i.id = s.initiative_id
     WHERE i.program_id = ?1 AND s.done_at IS NULL AND s.due_date IS NOT NULL AND s.due_date < ?2`,
  )
    .bind(programId, new Date().toISOString())
    .first<{ n: number }>();

  return {
    greenCount: counts.green,
    amberCount: counts.amber,
    redCount: counts.red,
    overdueStepCount: overdue?.n ?? 0,
  };
}
