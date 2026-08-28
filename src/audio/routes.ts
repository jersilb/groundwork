import type { Env } from "../index.ts";
import { authorizeSessionAccess } from "../auth/authorize.ts";

// HTTP routes for the audio pipeline — build plan §3.4. Consent and the
// kill switch gate every chunk upload: no consent recorded, or the kill
// switch engaged, and the Worker rejects the chunk outright rather than
// silently accepting audio the room hasn't agreed to.
//
// Authorization: real lab rooms ("lab-<id>" session keys) require the
// caller to belong to the org that owns the lab_session — consent state
// and chunk uploads mutate another org's session otherwise. Ad-hoc test
// sessions keep the pre-auth behavior (the harness depends on it).

/** 10 MB — a browser MediaRecorder chunk at 64 kbps Opus is ~480 KB/min;
 * anything near this cap is abuse, not audio. */
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;

interface AudioConsentRow {
  session_id: string;
  consented_at: string | null;
  consented_by: string | null;
  kill_switch_engaged: number;
}

async function getConsent(env: Env, sessionId: string): Promise<AudioConsentRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM audio_consent WHERE session_id = ?1`)
    .bind(sessionId)
    .first<AudioConsentRow>();
  return row ?? null;
}

async function handleGetConsent(env: Env, sessionId: string): Promise<Response> {
  const consent = await getConsent(env, sessionId);
  return Response.json({
    consented: Boolean(consent?.consented_at),
    consentedAt: consent?.consented_at ?? null,
    consentedBy: consent?.consented_by ?? null,
    killSwitchEngaged: Boolean(consent?.kill_switch_engaged),
  });
}

async function handlePostConsent(request: Request, env: Env, sessionId: string): Promise<Response> {
  const body = (await request.json()) as { consentedBy?: string };
  if (!body.consentedBy) {
    return Response.json({ error: "consentedBy is required" }, { status: 400 });
  }
  await env.DB.prepare(
    `INSERT INTO audio_consent (session_id, consented_at, consented_by, kill_switch_engaged)
     VALUES (?1, ?2, ?3, 0)
     ON CONFLICT(session_id) DO UPDATE SET consented_at = excluded.consented_at, consented_by = excluded.consented_by`,
  )
    .bind(sessionId, new Date().toISOString(), body.consentedBy)
    .run();
  return Response.json({ status: "ok" });
}

async function handleKillSwitch(request: Request, env: Env, sessionId: string): Promise<Response> {
  const body = (await request.json()) as { engaged?: boolean };
  await env.DB.prepare(
    `INSERT INTO audio_consent (session_id, kill_switch_engaged)
     VALUES (?1, ?2)
     ON CONFLICT(session_id) DO UPDATE SET kill_switch_engaged = excluded.kill_switch_engaged`,
  )
    .bind(sessionId, body.engaged ? 1 : 0)
    .run();
  return Response.json({ status: "ok", killSwitchEngaged: Boolean(body.engaged) });
}

async function handleChunkUpload(request: Request, env: Env, sessionId: string, url: URL): Promise<Response> {
  const segmentKey = url.searchParams.get("segmentKey");
  const sequenceRaw = url.searchParams.get("sequence");
  const offsetRaw = url.searchParams.get("offsetMs");
  if (!segmentKey || sequenceRaw === null || offsetRaw === null) {
    return Response.json({ error: "segmentKey, sequence, and offsetMs are required" }, { status: 400 });
  }
  const sequence = Number(sequenceRaw);
  const startedOffsetMs = Number(offsetRaw);

  const consent = await getConsent(env, sessionId);
  if (!consent?.consented_at) {
    return Response.json({ error: "no consent recorded for this session" }, { status: 403 });
  }
  if (consent.kill_switch_engaged) {
    return Response.json({ error: "recording kill switch is engaged" }, { status: 403 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return Response.json({ error: "empty chunk body" }, { status: 400 });
  }
  if (body.byteLength > MAX_CHUNK_BYTES) {
    return Response.json({ error: `chunk exceeds ${MAX_CHUNK_BYTES} bytes` }, { status: 413 });
  }

  const r2Key = `audio/${sessionId}/${segmentKey}/${sequence}.webm`;
  await env.AUDIO_BUCKET.put(r2Key, body);

  const chunkId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO session_audio_chunk (id, session_id, segment_key, sequence, r2_key, started_offset_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(chunkId, sessionId, segmentKey, sequence, r2Key, startedOffsetMs)
    .run();

  await env.TRANSCRIPTION_QUEUE.send({ chunkId, r2Key });

  return Response.json({ status: "queued", chunkId, r2Key });
}

const AUDIO_ROUTE = /^\/session\/([A-Za-z0-9_-]+)\/audio\/(consent|kill-switch|chunk)$/;

/** Returns null if the URL isn't an audio route, so the caller can fall
 * through to its other routing. */
export async function handleAudioRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(AUDIO_ROUTE);
  if (!match) return null;
  const [, sessionId, action] = match;

  // Org authorization for real lab rooms — applies to GETs too (consent
  // status is org data). Must run before any handler touches D1/R2.
  const access = await authorizeSessionAccess(request, env, sessionId);
  if (access.kind === "error") return access.response;

  if (action === "consent") {
    if (request.method === "GET") return handleGetConsent(env, sessionId);
    if (request.method === "POST") return handlePostConsent(request, env, sessionId);
  }
  if (action === "kill-switch" && request.method === "POST") {
    return handleKillSwitch(request, env, sessionId);
  }
  if (action === "chunk" && request.method === "POST") {
    return handleChunkUpload(request, env, sessionId, url);
  }
  return new Response("Method not allowed", { status: 405 });
}
