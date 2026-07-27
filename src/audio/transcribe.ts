import type { Env } from "../index.ts";

// Whisper transcription — build plan §3.4. Real inference always calls out
// to Cloudflare's Workers AI service; there is no local emulation for this
// binding (unlike D1/R2/DO/Queues). Untestable from this session's sandbox
// specifically — see docs/capability-gaps.md, 2026-07-27. The failure path
// below (catch + structured error, never throw) is what makes that survivable
// in production too: a transient Whisper failure shouldn't crash the queue
// consumer or lose the chunk.

export type TranscribeResult = { text: string } | { error: string };

const WHISPER_MODEL = "@cf/openai/whisper";

export async function transcribeAudioChunk(env: Env, r2Key: string): Promise<TranscribeResult> {
  try {
    const object = await env.AUDIO_BUCKET.get(r2Key);
    if (!object) {
      return { error: `R2 object not found: ${r2Key}` };
    }
    const arrayBuffer = await object.arrayBuffer();
    const result = await env.AI.run(WHISPER_MODEL, {
      audio: Array.from(new Uint8Array(arrayBuffer)),
    });
    const text = (result as { text?: string }).text ?? "";
    return { text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
