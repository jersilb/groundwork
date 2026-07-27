import type { Env } from "../index.ts";

// Build plan §3.4 step 5: "Guide reads the rolling transcript window
// (current segment + prior segment) when evaluating." ~60s of lag between
// speech and guide awareness is expected and acceptable — the guide
// evaluates discussion outcomes, not sentences.

interface ChunkRow {
  sequence: number;
  text: string | null;
}

async function chunkTextForSegment(env: Env, sessionId: string, segmentKey: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT sequence, text FROM session_audio_chunk
     WHERE session_id = ?1 AND segment_key = ?2 AND text IS NOT NULL
     ORDER BY sequence ASC`,
  )
    .bind(sessionId, segmentKey)
    .all<ChunkRow>();
  return results.map((r) => r.text).join(" ");
}

/** Concatenates transcribed text for the current segment plus the segment
 * immediately before it. `priorSegmentKey` is undefined for a lab's first
 * segment. Chunks with no transcript yet (transcription still in flight,
 * or failed — see transcribe.ts) are silently skipped, not blocked on. */
export async function getRollingTranscriptWindow(
  env: Env,
  sessionId: string,
  currentSegmentKey: string,
  priorSegmentKey?: string,
): Promise<string> {
  const parts: string[] = [];
  if (priorSegmentKey) {
    const prior = await chunkTextForSegment(env, sessionId, priorSegmentKey);
    if (prior) parts.push(prior);
  }
  const current = await chunkTextForSegment(env, sessionId, currentSegmentKey);
  if (current) parts.push(current);
  return parts.join("\n\n");
}
