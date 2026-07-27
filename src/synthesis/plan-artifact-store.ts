import type { Env } from "../index.ts";
import type { DraftArtifact } from "../guide-engine/synthesizer.ts";

// Plan artifact versioning — build plan §4/§5.3/§7 Phase 5.
//
// Real finding from testing against live Opus (2026-07-27): a single
// synthesis pass legitimately produces MULTIPLE artifacts of the same
// `kind` — e.g. two distinct risks (a roof repair deadline and a
// leadership turnover pattern) are both genuinely `risk`, not two
// versions of "the" risk. Treating same-kind as "the same artifact,
// supersede it" would have silently merged distinct risks into a fake
// version history. Fixed by only versioning kinds where an org
// conceptually has exactly one (purpose, vision) — everything else is
// additive: each synthesis pass's artifacts are new rows, full stop.
const SINGULAR_KINDS = new Set(["purpose", "vision"]);

interface ExistingArtifactRow {
  id: string;
  version: number;
}

export async function saveArtifact(env: Env, sessionId: string, artifact: DraftArtifact): Promise<string> {
  const isSingular = SINGULAR_KINDS.has(artifact.kind);

  const existing = isSingular
    ? await env.DB.prepare(
        `SELECT id, version FROM session_plan_artifact
         WHERE session_id = ?1 AND kind = ?2 AND superseded_by IS NULL
         ORDER BY version DESC LIMIT 1`,
      )
        .bind(sessionId, artifact.kind)
        .first<ExistingArtifactRow>()
    : null;

  const newId = crypto.randomUUID();
  const version = existing ? existing.version + 1 : 1;

  await env.DB.prepare(
    `INSERT INTO session_plan_artifact (id, session_id, kind, content, version, provenance_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(newId, sessionId, artifact.kind, artifact.content, version, JSON.stringify(artifact.provenance), new Date().toISOString())
    .run();

  if (existing) {
    await env.DB.prepare(`UPDATE session_plan_artifact SET superseded_by = ?1 WHERE id = ?2`)
      .bind(newId, existing.id)
      .run();
  }

  return newId;
}

export interface StoredArtifact {
  id: string;
  kind: string;
  content: string;
  version: number;
  provenance_json: string;
  approved_at: string | null;
  created_at: string;
}

/** Current (non-superseded) artifacts only — the live plan, not history. */
export async function getCurrentArtifacts(env: Env, sessionId: string): Promise<StoredArtifact[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, content, version, provenance_json, approved_at, created_at
     FROM session_plan_artifact
     WHERE session_id = ?1 AND superseded_by IS NULL
     ORDER BY kind ASC`,
  )
    .bind(sessionId)
    .all<StoredArtifact>();
  return results;
}
