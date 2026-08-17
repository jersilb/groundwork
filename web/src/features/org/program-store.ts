import type { Initiative, LabSession, OrgRecord, ReviewCycle } from "./types";

/** Tiny persistence layer for the org screens. The Worker has no list
 * endpoints for lab sessions, initiatives, or review cycles, so the client
 * keeps them locally per program. Everything is wrapped in try/catch —
 * storage can be unavailable (private mode) and the screens must still
 * work in memory. */

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — keep working in memory */
  }
}

const orgKey = (orgId: string) => `groundwork:org:${orgId}`;
const sessionsKey = (programId: string) => `groundwork:program:${programId}:sessions`;
const initiativesKey = (programId: string) => `groundwork:program:${programId}:initiatives`;
const cyclesKey = (programId: string) => `groundwork:program:${programId}:review-cycles`;

export const programStore = {
  getOrg(orgId: string): OrgRecord | null {
    return readJson<OrgRecord>(orgKey(orgId));
  },
  saveOrg(orgId: string, record: OrgRecord): void {
    writeJson(orgKey(orgId), record);
  },
  clearOrg(orgId: string): void {
    try {
      localStorage.removeItem(orgKey(orgId));
    } catch {
      /* ignore */
    }
  },

  getSessions(programId: string): LabSession[] {
    return readJson<LabSession[]>(sessionsKey(programId)) ?? [];
  },
  saveSessions(programId: string, sessions: LabSession[]): void {
    writeJson(sessionsKey(programId), sessions);
  },

  getInitiatives(programId: string): Initiative[] {
    return readJson<Initiative[]>(initiativesKey(programId)) ?? [];
  },
  saveInitiatives(programId: string, initiatives: Initiative[]): void {
    writeJson(initiativesKey(programId), initiatives);
  },

  getReviewCycles(programId: string): ReviewCycle[] {
    return readJson<ReviewCycle[]>(cyclesKey(programId)) ?? [];
  },
  saveReviewCycles(programId: string, cycles: ReviewCycle[]): void {
    writeJson(cyclesKey(programId), cycles);
  },
};
