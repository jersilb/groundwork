// Screen-level client for POST /lab-session/:id/open. The worker returns
// { sessionKey, connectPath } where sessionKey is "lab-<labSessionId>" —
// the room URL is /session/<sessionKey>. There is no typed wrapper in
// lib/api.ts yet, so this mirrors the client's request() conventions
// (same BASE, same { error } body shape, ApiError on non-2xx) without
// touching shared lib code. 409 = LabSequenceError (lab completed and
// cannot be reopened).

import { ApiError } from "../../lib/api";

export interface OpenLabResult {
  sessionKey: string;
  connectPath: string;
}

// Same-origin always (see lib/api.ts for why VITE_API_BASE_URL is avoided).
const BASE = "";

export async function openLiveLab(labSessionId: string): Promise<OpenLabResult> {
  const res = await fetch(
    BASE + "/lab-session/" + encodeURIComponent(labSessionId) + "/open",
    { method: "POST" },
  );
  if (!res.ok) {
    let message = "HTTP " + res.status;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as OpenLabResult;
}
