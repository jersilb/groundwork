import { useEffect, useState } from "react";
import { Target, Plus, X, UserRound } from "lucide-react";
import { api } from "../../lib/api";
import type { Initiative, OverdueStep } from "./types";
import { programStore } from "./program-store";
import { EmptyState, ErrorBanner, PanelHeader, StatusChip, formatDate, formatShortDate } from "./bits";

interface InitiativesPanelProps {
  programId: string;
}

interface StepDraft {
  description: string;
  owner: string;
  dueDate: string;
}

const EMPTY_DRAFT: StepDraft = { description: "", owner: "", dueDate: "" };

function daysOverdue(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/**
 * Initiatives are the commitments the team makes out of the labs. This
 * panel keeps them locally per program (the API has create endpoints but
 * no list endpoint) and surfaces the server-driven overdue-steps view
 * with severity chips: amber within a week, red past it.
 */
export default function InitiativesPanel({ programId }: InitiativesPanelProps) {
  const [initiatives, setInitiatives] = useState<Initiative[]>(() => programStore.getInitiatives(programId));
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [stepDrafts, setStepDrafts] = useState<Record<string, StepDraft>>({});
  const [overdue, setOverdue] = useState<OverdueStep[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overdueError, setOverdueError] = useState<string | null>(null);

  useEffect(() => {
    programStore.saveInitiatives(programId, initiatives);
  }, [programId, initiatives]);

  async function refreshOverdue() {
    try {
      const res = await api.getOverdueSteps(programId);
      setOverdue(res.steps as unknown as OverdueStep[]);
      setOverdueError(null);
    } catch (err) {
      setOverdueError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refreshOverdue();
  }, [programId]);

  async function createInitiative() {
    const title = newTitle.trim();
    if (!title) {
      setError("Give the initiative a name — what is the team committing to?");
      return;
    }
    setBusy("create-initiative");
    setError(null);
    try {
      const { id } = await api.createInitiative(programId, { title, description: newDesc.trim() || undefined });
      const next = [...initiatives, { id, title, description: newDesc.trim() || undefined, steps: [] }];
      setInitiatives(next);
      setNewTitle("");
      setNewDesc("");
      setShowNew(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function addStep(initiativeId: string) {
    const draft = stepDrafts[initiativeId] ?? EMPTY_DRAFT;
    const description = draft.description.trim();
    if (!description) {
      setError("Describe the step — what needs to happen?");
      return;
    }
    setBusy("step:" + initiativeId);
    setError(null);
    try {
      const dueIso = draft.dueDate ? new Date(draft.dueDate + "T09:00:00").toISOString() : undefined;
      const { id } = await api.addInitiativeStep(
        initiativeId,
        description,
        draft.owner.trim() || undefined,
        dueIso,
      );
      const next = initiatives.map((i) =>
        i.id === initiativeId
          ? { ...i, steps: [...i.steps, { id, description, ownerUserId: draft.owner.trim() || undefined, dueDate: dueIso }] }
          : i,
      );
      setInitiatives(next);
      setStepDrafts((prev) => ({ ...prev, [initiativeId]: EMPTY_DRAFT }));
      void refreshOverdue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const overdueIds = new Set(overdue.map((o) => o.step_id));

  return (
    <section className="card p-6">
      <PanelHeader
        icon={Target}
        title="Initiatives"
        action={
          !showNew && (
            <button className="btn btn-ghost text-sm" onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New initiative
            </button>
          )
        }
      />
      <p className="mb-5 text-sm text-muted">
        Commitments your team makes out of the labs — each with steps, owners, and dates.
      </p>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {showNew && (
        <div className="mb-5 rounded-xl border border-line bg-paper/60 p-5">
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="initiative-title">Initiative name</label>
              <input
                id="initiative-title"
                className="input"
                placeholder="e.g. Rebuild the volunteer pipeline"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="initiative-desc">Why it matters</label>
              <textarea
                id="initiative-desc"
                className="input"
                rows={2}
                placeholder="One or two sentences on why this commitment matters now."
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary text-sm" disabled={busy === "create-initiative"} onClick={() => createInitiative()}>
                {busy === "create-initiative" ? "Creating…" : "Create initiative"}
              </button>
              <button className="btn btn-ghost text-sm" onClick={() => setShowNew(false)}>
                <X className="h-4 w-4" aria-hidden /> Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overdue steps — the server-driven view */}
      <div className="mb-6">
        <h3 className="label mb-2">Overdue steps</h3>
        {overdueError ? (
          <p className="text-sm text-warn">Could not load overdue steps: {overdueError}</p>
        ) : overdue.length === 0 ? (
          <p className="rounded-lg bg-ok-soft px-4 py-3 text-sm text-ok">
            Nothing overdue. Steady work keeps the plan moving.
          </p>
        ) : (
          <ul className="space-y-2">
            {overdue.map((step) => {
              const days = daysOverdue(step.due_date);
              const critical = days >= 8;
              return (
                <li key={step.step_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper/50 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{step.description}</p>
                    <p className="text-xs text-muted">{step.initiative_title} · due {formatDate(step.due_date)}</p>
                  </div>
                  <StatusChip tone={critical ? "err" : "warn"}>{critical ? "Critical" : "Overdue"} · {days} day{days === 1 ? "" : "s"}</StatusChip>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {initiatives.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No initiatives yet"
          body="Initiatives turn what the labs surface into commitments — a volunteer pipeline, a giving strategy, a building decision. Create the first one when the team is ready."
        />
      ) : (
        <ul className="space-y-4">
          {initiatives.map((initiative) => (
            <li key={initiative.id} className="rounded-xl border border-line p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-lg">{initiative.title}</h3>
                  {initiative.description && <p className="mt-1 text-sm text-muted">{initiative.description}</p>}
                </div>
                <StatusChip tone="neutral">{initiative.steps.length} step{initiative.steps.length === 1 ? "" : "s"}</StatusChip>
              </div>

              {initiative.steps.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {initiative.steps.map((step) => {
                    const isOverdue = step.dueDate ? overdueIds.has(step.id) : false;
                    const days = step.dueDate ? daysOverdue(step.dueDate) : 0;
                    return (
                      <li key={step.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                        <span className="min-w-0 flex-1 text-ink">{step.description}</span>
                        {step.ownerUserId && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted">
                            <UserRound className="h-3.5 w-3.5" aria-hidden /> {step.ownerUserId}
                          </span>
                        )}
                        {step.dueDate && <span className="text-xs text-muted">due {formatShortDate(step.dueDate)}</span>}
                        {isOverdue && <StatusChip tone={days >= 8 ? "err" : "warn"}>{days} day{days === 1 ? "" : "s"} overdue</StatusChip>}
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <input
                  className="input w-full text-sm sm:w-56"
                  placeholder="Next step…"
                  aria-label={"Step for " + initiative.title}
                  value={(stepDrafts[initiative.id] ?? EMPTY_DRAFT).description}
                  onChange={(e) =>
                    setStepDrafts((prev) => ({ ...prev, [initiative.id]: { ...(prev[initiative.id] ?? EMPTY_DRAFT), description: e.target.value } }))
                  }
                />
                <input
                  type="date"
                  className="input w-auto text-sm"
                  aria-label="Due date"
                  value={(stepDrafts[initiative.id] ?? EMPTY_DRAFT).dueDate}
                  onChange={(e) =>
                    setStepDrafts((prev) => ({ ...prev, [initiative.id]: { ...(prev[initiative.id] ?? EMPTY_DRAFT), dueDate: e.target.value } }))
                  }
                />
                <input
                  className="input w-full text-sm sm:w-36"
                  placeholder="Owner (optional)"
                  aria-label="Step owner"
                  value={(stepDrafts[initiative.id] ?? EMPTY_DRAFT).owner}
                  onChange={(e) =>
                    setStepDrafts((prev) => ({ ...prev, [initiative.id]: { ...(prev[initiative.id] ?? EMPTY_DRAFT), owner: e.target.value } }))
                  }
                />
                <button
                  className="btn btn-accent text-sm"
                  disabled={busy === "step:" + initiative.id}
                  onClick={() => addStep(initiative.id)}
                >
                  {busy === "step:" + initiative.id ? "Adding…" : "Add step"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}