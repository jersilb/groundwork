import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, CalendarClock, CheckCircle2, Lock, Play, AlertTriangle } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { LabDef, LabSession } from "./types";
import { LABS } from "./types";
import { EmptyState, PanelHeader, StatusChip, WarnBanner, formatDate } from "./bits";
import { openLiveLab } from "./open-lab";

interface LabScheduleProps {
  programId: string;
  /** Number of completed labs (0–4) from the server — the phase gate. */
  currentLab: number;
  sessions: LabSession[];
  onChange: (sessions: LabSession[]) => void;
  /** Called after a completion so the parent can refetch program state. */
  onProgramChanged: (completedLabNumber?: number) => Promise<void>;
}

function defaultDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

/**
 * The four-lab schedule: phase-gated by the server. Only the next lab in
 * sequence can be scheduled; scheduling out of order returns a 409 whose
 * message is shown verbatim. Each scheduled lab can record consent and be
 * completed, which unlocks the next lab.
 */
export default function LabSchedule({ programId, currentLab, sessions, onChange, onProgramChanged }: LabScheduleProps) {
  const [dateInputs, setDateInputs] = useState<Record<number, string>>({});
  const [consentNames, setConsentNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmComplete, setConfirmComplete] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  // Keep a sensible default date on whatever lab is schedulable next.
  useEffect(() => {
    const next = currentLab + 1;
    if (next <= 4 && !dateInputs[next]) {
      setDateInputs((prev) => ({ ...prev, [next]: defaultDate() }));
    }
  }, [currentLab, dateInputs]);

  /** Open the lab as a live room: POST /lab-session/:id/open, then go to
   * /session/<sessionKey>. A completed lab is refused with a 409 whose
   * message we show verbatim. */
  async function startLiveLab(session: LabSession) {
    setBusy("open:" + session.id);
    setNotice(null);
    try {
      const { sessionKey } = await openLiveLab(session.id);
      navigate("/session/" + sessionKey);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNotice(err.message);
      } else {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function schedule(labNumber: number) {
    const scheduledFor = dateInputs[labNumber];
    if (!scheduledFor) {
      setNotice("Pick a date first — the lab needs a day on the calendar.");
      return;
    }
    setBusy("schedule:" + labNumber);
    setNotice(null);
    try {
      const iso = new Date(scheduledFor + "T09:00:00").toISOString();
      const { id } = await api.scheduleLabSession(programId, labNumber, iso);
      onChange([
        ...sessions,
        { id, labNumber, scheduledFor: iso, status: "scheduled" as const },
      ]);
      setDateInputs((prev) => ({ ...prev, [labNumber]: "" }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Phase gate: the server rejected the sequence — show its message.
        setNotice(err.message);
      } else {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function recordConsent(session: LabSession) {
    const name = (consentNames[session.labNumber] ?? "").trim();
    if (!name) {
      setNotice("Enter a name to record consent — who is confirming this session?");
      return;
    }
    setBusy("consent:" + session.id);
    setNotice(null);
    try {
      await api.recordLabConsent(session.id, name);
      onChange(sessions.map((s) => (s.id === session.id ? { ...s, consentedBy: name, consentedAt: new Date().toISOString() } : s)));
      setConsentNames((prev) => ({ ...prev, [session.labNumber]: "" }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function complete(session: LabSession) {
    setBusy("complete:" + session.id);
    setNotice(null);
    try {
      await api.completeLabSession(session.id);
      onChange(
        sessions.map((s) =>
          s.id === session.id ? { ...s, status: "completed" as const, completedAt: new Date().toISOString() } : s,
        ),
      );
      setConfirmComplete(null);
      await onProgramChanged(session.labNumber);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function renderActions(lab: LabDef) {
    const session = sessions.find((s) => s.labNumber === lab.number);
    const done = lab.number <= currentLab;
    const locked = !done && lab.number > currentLab + 1;
    const schedulable = !done && !session && lab.number === currentLab + 1;

    // A completed lab needs no actions — the row already shows the status.
    if (done) return null;

    if (locked) {
      return (
        <p className="text-xs text-faint">
          <Lock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          Complete Lab {lab.number - 1} to unlock
        </p>
      );
    }

    if (schedulable) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            className="input w-44 text-sm"
            aria-label={"Date for Lab " + lab.number}
            value={dateInputs[lab.number] ?? ""}
            onChange={(e) => setDateInputs((prev) => ({ ...prev, [lab.number]: e.target.value }))}
          />
          <button
            className="btn btn-primary text-sm"
            disabled={busy === "schedule:" + lab.number}
            onClick={() => schedule(lab.number)}
          >
            {busy === "schedule:" + lab.number ? "Scheduling…" : "Schedule Lab " + lab.number}
          </button>
        </div>
      );
    }

    if (session) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-accent text-sm"
            disabled={busy === "open:" + session.id}
            onClick={() => startLiveLab(session)}
          >
            <Play className="h-4 w-4" aria-hidden />
            {busy === "open:" + session.id ? "Opening…" : "Start live lab"}
          </button>
          {session.consentedBy ? (
            <StatusChip tone="ok">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Consent on file
            </StatusChip>
          ) : (
            <div className="flex items-center gap-2">
              <input
                className="input w-36 text-sm"
                placeholder="Who consents?"
                aria-label={"Consent recorder for Lab " + lab.number}
                value={consentNames[lab.number] ?? ""}
                onChange={(e) => setConsentNames((prev) => ({ ...prev, [lab.number]: e.target.value }))}
              />
              <button
                className="btn btn-ghost text-sm"
                disabled={busy === "consent:" + session.id}
                onClick={() => recordConsent(session)}
              >
                {busy === "consent:" + session.id ? "Recording…" : "Record consent"}
              </button>
            </div>
          )}
          {confirmComplete === lab.number ? (
            <>
              <button
                className="btn btn-primary text-sm"
                disabled={busy === "complete:" + session.id}
                onClick={() => complete(session)}
              >
                {busy === "complete:" + session.id ? "Completing…" : "Yes, complete Lab " + lab.number}
              </button>
              <button className="btn btn-ghost text-sm" onClick={() => setConfirmComplete(null)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-ghost text-sm" onClick={() => setConfirmComplete(lab.number)}>
              Complete Lab {lab.number}
            </button>
          )}
        </div>
      );
    }

    return null;
  }

  function renderRow(lab: LabDef) {
    const session = sessions.find((s) => s.labNumber === lab.number);
    const done = lab.number <= currentLab;
    const nextUp = lab.number === currentLab + 1;
    return (
      <li
        key={lab.number}
        className={"flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between " + (nextUp ? "bg-brand-soft/40" : "")}
      >
        <div className="flex items-start gap-4">
          <span
            className={"flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-display text-lg font-bold " + (done ? "bg-ok-soft text-ok" : "border border-line-strong bg-surface text-brand")}
          >
            {lab.number}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg">Lab {lab.number} — {lab.name}</h3>
              {done && <StatusChip tone="ok">Completed</StatusChip>}
              {!done && lab.number > currentLab + 1 && <StatusChip tone="neutral">Locked</StatusChip>}
              {session?.status === "scheduled" && <StatusChip tone="accent">Scheduled</StatusChip>}
            </div>
            <p className="mt-0.5 text-sm text-muted">{lab.line}</p>
            {session?.status === "scheduled" && (
              <p className="mt-1 text-xs text-muted">
                <CalendarClock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                Scheduled for {formatDate(session.scheduledFor)}
              </p>
            )}
            {session?.consentedBy && (
              <p className="mt-1 text-xs text-ok">Consent recorded by {session.consentedBy}</p>
            )}
          </div>
        </div>
        <div className="sm:justify-end">{renderActions(lab)}</div>
      </li>
    );
  }

  const started = currentLab > 0 || sessions.length > 0;

  return (
    <section className="card p-6">
      <PanelHeader
        icon={CalendarDays}
        title="Lab schedule"
        action={currentLab === 4 ? <StatusChip tone="ok">All four complete</StatusChip> : undefined}
      />
      <p className="mb-5 text-sm text-muted">
        Four full-day sessions, one arc. Completing a lab unlocks the next.
      </p>

      {notice && (
        <div className="mb-4">
          <WarnBanner>
            <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden />
            {notice}
          </WarnBanner>
        </div>
      )}

      {!started ? (
        <div className="space-y-4">
          <EmptyState
            icon={CalendarDays}
            title="No labs scheduled yet"
            body="Schedule Lab 1 — Purpose — to begin the arc. Each full day ends with something on paper your team can act on."
          />
          <div className="rounded-xl border border-line bg-paper/60 p-5">{renderRow(LABS[0])}</div>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">{LABS.map(renderRow)}</ul>
      )}
    </section>
  );
}