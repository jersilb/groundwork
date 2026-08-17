import { useEffect, useState } from "react";
import { BellRing, RefreshCcw, Sparkles, FileText } from "lucide-react";
import { api } from "../../lib/api";
import type { Nudge } from "./types";
import { EmptyState, ErrorBanner, PanelHeader, StatusChip } from "./bits";

interface CoachFeedProps {
  programId: string;
}

/**
 * COACH nudges: between-session reminders about overdue initiative steps.
 * The server answers personalized=true when it generated messages with the
 * LLM client; otherwise it returned the plain template — the chip makes
 * that distinction visible.
 */
export default function CoachFeed({ programId }: CoachFeedProps) {
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [personalized, setPersonalized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  async function fetchNudges() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCoachNudges(programId);
      setNudges(res.nudges);
      setPersonalized(res.personalized);
      setCheckedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchNudges();
  }, [programId]);

  return (
    <section className="card p-6">
      <PanelHeader
        icon={BellRing}
        title="COACH"
        action={
          <button className="btn btn-ghost text-sm" disabled={loading} onClick={() => fetchNudges()}>
            <RefreshCcw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} aria-hidden />
            Refresh
          </button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {personalized ? (
          <StatusChip tone="accent">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Personalized
          </StatusChip>
        ) : (
          <StatusChip tone="neutral">
            <FileText className="h-3.5 w-3.5" aria-hidden /> Template
          </StatusChip>
        )}
        <p className="text-xs text-muted">
          {personalized
            ? "COACH wrote these from your program’s specifics."
            : "Plain reminders — they become personalized once the AI key is connected."}
        </p>
      </div>

      {error ? (
        <ErrorBanner>Could not reach COACH: {error}</ErrorBanner>
      ) : nudges.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="Nothing to nudge"
          body="When an initiative step falls behind, COACH surfaces a gentle reminder here."
        />
      ) : (
        <ul className="space-y-2">
          {nudges.map((nudge) => (
            <li key={nudge.stepId} className="rounded-lg border border-line bg-paper/50 px-4 py-3">
              <p className="text-sm leading-relaxed text-ink">{nudge.message}</p>
              {nudge.tone && (
                <p className="mt-1.5 text-xs text-muted">
                  Tone: <span className="font-medium text-ink">{nudge.tone}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {checkedAt && nudges.length > 0 && (
        <p className="mt-4 text-xs text-faint">
          Last checked {new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </p>
      )}
    </section>
  );
}