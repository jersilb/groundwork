// Client-side mirror of the program layer. The Worker exposes only a few
// read endpoints (getProgram, overdue-steps), so the org screens keep the
// lab schedule, initiatives, and review cycles in local state, persisted
// per program (see program-store.ts). Keep these shapes aligned with the
// server types in src/program/*.ts.

export interface ProgramState {
  id: string;
  /** Number of completed labs (0–4). The phase gate: only current_lab + 1
   * can be scheduled next. */
  current_lab: number;
  status: "not_started" | "in_progress" | "completed";
}

export interface LabDef {
  number: number;
  name: string;
  line: string;
}

/** The four full-day labs that make up one program arc. Names follow the
 * arc described on the landing page: purpose, vision, risks, strategy. */
export const LABS: LabDef[] = [
  { number: 1, name: "Purpose", line: "Why we exist, and who we are here to serve." },
  { number: 2, name: "Vision", line: "A flourishing future, named out loud." },
  { number: 3, name: "Risks", line: "An honest look at what could hold us back." },
  { number: 4, name: "Strategy", line: "The few moves that turn vision into a plan." },
];

export interface LabSession {
  id: string;
  labNumber: number;
  scheduledFor: string;
  status: "scheduled" | "completed";
  completedAt?: string;
  consentedBy?: string;
  consentedAt?: string;
}

export interface InitiativeStep {
  id: string;
  description: string;
  ownerUserId?: string;
  dueDate?: string;
}

export interface Initiative {
  id: string;
  title: string;
  description?: string;
  steps: InitiativeStep[];
}

/** Shape returned by GET /program/:id/overdue-steps. */
export interface OverdueStep {
  step_id: string;
  description: string;
  due_date: string;
  initiative_id: string;
  initiative_title: string;
  owner_user_id: string | null;
}

export interface Nudge {
  stepId: string;
  message: string;
  tone?: string;
}

export interface HealthSnapshot {
  greenCount: number;
  amberCount: number;
  redCount: number;
  overdueStepCount: number;
}

export interface ReviewCycle {
  id: string;
  periodStart: string;
  periodEnd: string;
  completedAt?: string;
  snapshot?: HealthSnapshot;
}

/** What the org dashboard knows about the org behind a URL slug. Keyed by
 * org id in program-store.ts; the URL slug ("demo") is just an entry point
 * until setup creates a real org. */
export interface OrgRecord {
  programId: string;
  orgName: string;
  leaderUserId?: string;
  /** True when the API was unreachable during setup and the screens run on
   * local state only — changes are not persisted server-side. */
  localOnly?: boolean;
}
