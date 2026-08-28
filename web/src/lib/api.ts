// Typed client for the Groundwork Worker REST API. All endpoints are
// same-origin, always: in production the Worker serves the PWA and the API
// together (assets binding + worker fallback), and in local frontend dev
// vite proxies /org, /session, /program, ... to wrangler dev. Deliberately
// NOT configurable via VITE_API_BASE_URL — an ambient env var from another
// project once baked localhost:3001 into a production bundle.

const BASE = "";

/** Dev-only auth bypass for `wrangler dev` / `vite` local mode. In
 * production the Worker sits behind Cloudflare Access, which injects
 * CF-Access-Jwt-Assertion automatically; the browser never sees a
 * dev bypass header there. */
const DEV_AUTH_HEADERS: Record<string, string> = import.meta.env.DEV
  ? {
      "X-Groundwork-Dev-User": "dev@groundwork.local",
      "X-Groundwork-Dev-Sub": "dev-user-00000000-0000-0000-0000-000000000000",
    }
  : {};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...DEV_AUTH_HEADERS,
      ...(init?.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = (body as { error?: string; message?: string }).error
        ?? (body as { message?: string }).message
        ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* ---------- Program / org layer ---------- */

export type OrgType = "church" | "parachurch" | "nonprofit" | "school";

export interface CreateOrgBody { name: string; type: OrgType; annualBudgetBand?: string; }
export interface CreateUserBody { name: string; email: string; role: "leader" | "member"; }
export interface CreateInitiativeBody {
  title: string;
  /** The server column is why_now — "why this initiative, now". */
  whyNow?: string;
  ownerUserId?: string;
  dueDate?: string;
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  /* org */
  createOrg: (body: CreateOrgBody) =>
    request<{ id: string }>("/org", { method: "POST", body: JSON.stringify(body) }),
  createUser: (orgId: string, body: CreateUserBody) =>
    request<{ id: string }>(`/org/${orgId}/users`, { method: "POST", body: JSON.stringify(body) }),
  createProgram: (orgId: string) =>
    request<{ id: string }>(`/org/${orgId}/program`, { method: "POST", body: JSON.stringify({}) }),

  /* program */
  getProgram: (programId: string) => request<Record<string, unknown>>(`/program/${programId}`),
  scheduleLabSession: (programId: string, labNumber: number, scheduledFor: string) =>
    request<{ id: string }>(`/program/${programId}/lab-session`, {
      method: "POST",
      body: JSON.stringify({ labNumber, scheduledFor }),
    }),
  completeLabSession: (labSessionId: string) =>
    request<{ status: string }>(`/lab-session/${labSessionId}/complete`, { method: "POST", body: JSON.stringify({}) }),
  openLabSession: (labSessionId: string) =>
    request<{ sessionKey: string; connectPath: string }>(`/lab-session/${labSessionId}/open`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  recordLabConsent: (labSessionId: string, consentedBy: string) =>
    request<{ status: string }>(`/lab-session/${labSessionId}/consent`, {
      method: "POST",
      body: JSON.stringify({ consentedBy }),
    }),

  /* initiatives + coach */
  createInitiative: (programId: string, body: CreateInitiativeBody) =>
    request<{ id: string }>(`/program/${programId}/initiative`, { method: "POST", body: JSON.stringify(body) }),
  addInitiativeStep: (initiativeId: string, description: string, ownerUserId?: string, dueDate?: string) =>
    request<{ id: string }>(`/initiative/${initiativeId}/step`, {
      method: "POST",
      body: JSON.stringify({ description, ownerUserId, dueDate }),
    }),
  getOverdueSteps: (programId: string) =>
    request<{ steps: Record<string, unknown>[] }>(`/program/${programId}/overdue-steps`),
  getCoachNudges: (programId: string) =>
    request<{ nudges: { stepId: string; message: string; tone?: string }[]; personalized: boolean }>(
      `/program/${programId}/coach/nudges`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  /* review cycles */
  createReviewCycle: (programId: string, periodStart: string, periodEnd: string) =>
    request<{ id: string }>(`/program/${programId}/review-cycle`, {
      method: "POST",
      body: JSON.stringify({ periodStart, periodEnd }),
    }),
  completeReviewCycle: (reviewCycleId: string, programId: string) =>
    request<{ status: string; snapshot: Record<string, unknown> }>(`/review-cycle/${reviewCycleId}/complete`, {
      method: "POST",
      body: JSON.stringify({ programId }),
    }),

  /* audio pipeline */
  getAudioConsent: (sessionId: string) =>
    request<{ consented: boolean; consentedAt: string | null; consentedBy: string | null; killSwitchEngaged: boolean }>(
      `/session/${sessionId}/audio/consent`,
    ),
  postAudioConsent: (sessionId: string, consentedBy: string) =>
    request<{ status: string }>(`/session/${sessionId}/audio/consent`, {
      method: "POST",
      body: JSON.stringify({ consentedBy }),
    }),
  setKillSwitch: (sessionId: string, engaged: boolean) =>
    request<{ status: string; killSwitchEngaged: boolean }>(`/session/${sessionId}/audio/kill-switch`, {
      method: "POST",
      body: JSON.stringify({ engaged }),
    }),
  uploadAudioChunk: (sessionId: string, segmentKey: string, sequence: number, offsetMs: number, body: ArrayBuffer) =>
    fetch(`${BASE}/session/${sessionId}/audio/chunk?segmentKey=${segmentKey}&sequence=${sequence}&offsetMs=${offsetMs}`, {
      method: "POST",
      body,
      headers: DEV_AUTH_HEADERS,
    }),

  /* synthesis */
  synthesize: (sessionId: string, body: { segment: unknown; submissions: string[]; transcriptWindow?: string }) =>
    request<{ status: string; savedArtifactIds: string[]; artifacts: unknown[] }>(
      `/session/${sessionId}/synthesize`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getPlan: (sessionId: string) =>
    request<{ plan: unknown; markdown: string }>(`/session/${sessionId}/plan`),

  /* commerce */
  createCheckout: (orgId: string, body: { band: string; cycle: "monthly" | "annual"; successUrl: string; cancelUrl: string }) =>
    request<{ checkoutUrl: string; sessionId: string }>(`/org/${orgId}/checkout-session`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createBillingPortal: (orgId: string, returnUrl: string) =>
    request<{ portalUrl: string }>(`/org/${orgId}/billing-portal`, {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    }),
};