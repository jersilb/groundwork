import { useState } from "react";
import { CalendarRange, CheckCircle2, AlertTriangle } from "lucide-react";
import { api } from "../../lib/api";
import type { HealthSnapshot, ReviewCycle } from "./types";
import { programStore } from "./program-store";
import { EmptyState, ErrorBanner, PanelHeader, StatusChip, formatShortDate } from "./bits";

interface ReviewCyclesProps {
  programId: string;
}

const DOT_TONES: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-faint",
};

function SnapshotCard({ snapshot }: { snapshot: HealthSnapshot }) {
  const stats = [
    { label: "On track", value: snapshot.greenCount, tone: "ok" } as const,
    { label: "Needs attention", value: snapshot.amberCount, tone: "warn" } as const,
    { label: "Off track", value: snapshot.redCount, tone: "err" } as const,
    { label: "Overdue steps", value: snapshot.overdueStepCount, tone: snapshot.overdueStepCount > 0 ? "err" : "neutral" } as const,
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-xl border border-line bg-paper/60 p-4 text-center">
          <span className={"mx-auto block h-2.5 w-2.5 rounded-full " + DOT_TONES[stat.tone]} aria-hidden />
          <p className="mt-2 font-display text-3xl">{stat.value}</p>
          <p className="text-xs text-muted">{stat.label}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Monthly review rhythm: pick the period, run the review, and the server
 * returns a health snapshot (green/amber/red initiatives + overdue steps)
 * that is rendered as a card the team can look at together.
 */
export default function ReviewCycles({ programId }: ReviewCyclesProps) {
  const [cycles, setCycles] = useState<ReviewCycle[]>(() => programStore.getReviewCycles(programId));
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmComplete, setConfirmComplete] = useState<string | null>(null);

  function persist(next: ReviewCycle[]) {
    setCycles(next);
    programStore.saveReviewCycles(programId, next);
  }

  async function createCycle() {
    if (!periodStart || !periodEnd) {
      setError("Pick the start and end of the period you are reviewing.");
      return;
    }
    if (periodEnd < periodStart) {
      setError("The period end has to come after the start.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const startIso = new Date(periodStart + "T00:00:00").toISOString();
      const endIso = new Date(periodEnd + "T23:59:59").toISOString();
      const { id } = await api.createReviewCycle(programId, startIso, endIso);
      persist([...cycles, { id, periodStart: startIso, periodEnd: endIso }]);
      setPeriodStart("");
      setPeriodEnd("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function completeCycle(cycle: ReviewCycle) {
    setBusy("complete:" + cycle.id);
    setError(null);
    try {
      const { snapshot } = await api.completeReviewCycle(cycle.id, programId);
      persist(
        cycles.map((c) =>
          c.id === cycle.id
            ? { ...c, completedAt: new Date().toISOString(), snapshot: snapshot as unknown as HealthSnapshot }
            : c,
        ),
      );
      setConfirmComplete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-6">
      <PanelHeader icon={CalendarRange} title="Review cycles" />
      <p className="mb-5 text-sm text-muted">
        A monthly review captures initiative health so course corrections happen early.
      </p>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="rounded-xl border border-line bg-paper/60 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="review-start">Period start</label>
            <input id="review-start" type="date" className="input w-auto text-sm" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="review-end">Period end</label>
            <input id="review-end" type="date" className="input w-auto text-sm" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
          <button className="btn btn-primary text-sm" disabled={busy === "create"} onClick={() => createCycle()}>
            {busy === "create" ? "Creating…" : "Start a review"}
          </button>
        </div>
      </div>

      {cycles.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            icon={CalendarRange}
            title="No review cycles yet"
            body="Run one monthly — pick the period above and start a review. When it’s done you get a health snapshot for the team."
          />
        </div>
      ) : (
        <ul className="mt-5 space-y-4">
          {cycles.map((cycle) => (
            <li key={cycle.id} className="rounded-xl border border-line p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-lg">
                    {formatShortDate(cycle.periodStart)} – {formatShortDate(cycle.periodEnd)}
                  </h3>
                  {cycle.snapshot ? <StatusChip tone="ok">Reviewed</StatusChip> : <StatusChip tone="neutral">Open</StatusChip>}
                </div>
                {!cycle.snapshot &&
                  (confirmComplete === cycle.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="btn btn-primary text-sm" disabled={busy === "complete:" + cycle.id} onClick={() => completeCycle(cycle)}>
                        {busy === "complete:" + cycle.id ? "Running…" : "Run the review now"}
                      </button>
                      <button className="btn btn-ghost text-sm" onClick={() => setConfirmComplete(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn-ghost text-sm" onClick={() => setConfirmComplete(cycle.id)}>
                      <CheckCircle2 className="h-4 w-4" aria-hidden /> Complete review
                    </button>
                  ))}
              </div>
              {confirmComplete === cycle.id && !cycle.snapshot && (
                <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                  <AlertTriangle className="h-4 w-4 text-warn" aria-hidden />
                  This captures initiative health for the period. You cannot undo it.
                </p>
              )}
              {cycle.snapshot && <SnapshotCard snapshot={cycle.snapshot} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}