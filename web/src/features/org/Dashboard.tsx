import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Landmark, Play, AlertTriangle, RotateCcw, LogOut } from "lucide-react";
import { api } from "../../lib/api";
import type { LabSession, OrgRecord, ProgramState } from "./types";
import { LABS } from "./types";
import { programStore } from "./program-store";
import { prettifySlug, StatusChip, WarnBanner } from "./bits";
import { openLiveLab } from "./open-lab";
import Setup, { type SetupResult } from "./Setup";
import LabSchedule from "./LabSchedule";
import InitiativesPanel from "./InitiativesPanel";
import CoachFeed from "./CoachFeed";
import ReviewCycles from "./ReviewCycles";

function ProgressBar({ value, total }: { value: number; total: number }) {
  return (
    <div className="mt-4 flex gap-1.5" aria-label={value + " of " + total + " labs complete"}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={"h-1.5 flex-1 rounded-full " + (i < value ? "bg-ok" : "bg-line")} />
      ))}
    </div>
  );
}

/**
 * Organization dashboard: program state, lab schedule, initiatives, COACH
 * nudges, and the monthly review rhythm. Renders the setup flow until a
 * program exists for this org, then the full dashboard. The org id from
 * the URL is the entry point; setup creates a real org + program.
 */
export default function Dashboard() {
  const { orgId = "demo" } = useParams();
  return <OrgDashboard key={orgId} orgId={orgId} />;
}

function OrgDashboard({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const [record, setRecord] = useState<OrgRecord | null>(() => programStore.getOrg(orgId));
  const [program, setProgram] = useState<ProgramState | null>(null);
  const [programError, setProgramError] = useState<string | null>(null);
  const [loadingProgram, setLoadingProgram] = useState(false);
  const [sessions, setSessions] = useState<LabSession[]>(() => {
    const rec = programStore.getOrg(orgId);
    return rec ? programStore.getSessions(rec.programId) : [];
  });
  const [openingLive, setOpeningLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    if (record) programStore.saveSessions(record.programId, sessions);
  }, [record, sessions]);

  const loadProgram = useCallback(async (programId: string, rec: OrgRecord) => {
    setLoadingProgram(true);
    setProgramError(null);
    try {
      const state = (await api.getProgram(programId)) as unknown as ProgramState;
      setProgram(state);
    } catch (err) {
      if (rec.localOnly) {
        setProgram({ id: programId, current_lab: 0, status: "not_started" });
      } else {
        setProgram(null);
        setProgramError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoadingProgram(false);
    }
  }, []);

  useEffect(() => {
    if (record) void loadProgram(record.programId, record);
  }, [record, loadProgram]);

  /** Refetch after a lab completes; in local-only mode bump the client state. */
  const handleLabMutated = useCallback(
    async (completedLabNumber?: number) => {
      if (!record) return;
      try {
        const state = (await api.getProgram(record.programId)) as unknown as ProgramState;
        setProgram(state);
      } catch {
        if (record.localOnly && completedLabNumber !== undefined) {
          setProgram((prev) =>
            prev
              ? {
                  ...prev,
                  current_lab: Math.max(prev.current_lab, completedLabNumber),
                  status: completedLabNumber === 4 ? "completed" : "in_progress",
                }
              : prev,
          );
        }
      }
    },
    [record],
  );

  function handleSetupComplete(result: SetupResult) {
    const next: OrgRecord = {
      programId: result.programId,
      orgName: result.orgName,
      leaderUserId: result.leaderUserId,
      localOnly: result.localOnly ?? false,
    };
    programStore.saveOrg(result.orgId, next);
    setRecord(next);
    setSessions([]);
    navigate("/org/" + result.orgId, { replace: true });
  }

  function startOver() {
    programStore.clearOrg(orgId);
    setRecord(null);
    setProgram(null);
    setProgramError(null);
  }

  /** Open the next scheduled lab as a live room and go to /session/<sessionKey>. */
  async function startLiveLab() {
    if (!nextLive) return;
    setOpeningLive(true);
    setLiveError(null);
    try {
      const { sessionKey } = await openLiveLab(nextLive.id);
      navigate("/session/" + sessionKey);
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningLive(false);
    }
  }

  if (!record) {
    return <Setup orgId={orgId} onComplete={handleSetupComplete} />;
  }

  const displayName = record.orgName || prettifySlug(orgId);
  const nextLive = sessions.find((s) => s.status === "scheduled");
  const currentLab = program?.current_lab ?? 0;

  const statusTone: "neutral" | "warn" | "ok" =
    program?.status === "completed" ? "ok" : program?.status === "in_progress" ? "warn" : "neutral";
  const statusLabel =
    program?.status === "completed" ? "Completed" : program?.status === "in_progress" ? "In progress" : "Not started";

  return (
    <div className="min-h-screen">
      <header className="ledger-rule sticky top-0 z-10 bg-paper/95 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/" className="flex items-center gap-2 text-brand">
              <Landmark className="h-6 w-6" aria-hidden />
              <span className="font-display text-lg font-semibold">Groundwork</span>
            </Link>
            <span className="hidden h-5 w-px bg-line-strong sm:block" aria-hidden />
            <span className="hidden truncate text-sm text-muted sm:block">{displayName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link to={"/org/" + orgId + "/billing"} className="btn btn-ghost text-sm">
              Billing
            </Link>
            {nextLive ? (
              <button className="btn btn-accent text-sm" disabled={openingLive} onClick={() => startLiveLab()}>
                <Play className="h-4 w-4" aria-hidden />
                {openingLive ? "Opening…" : "Start a live lab"}
              </button>
            ) : (
              <button className="btn btn-accent text-sm opacity-50" disabled title="Schedule a lab first">
                <Play className="h-4 w-4" aria-hidden /> Start a live lab
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {record.localOnly && (
          <div className="mb-6">
            <WarnBanner>
              <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden />
              Server unreachable — you are in a local demo. Changes are kept on this device only.
            </WarnBanner>
          </div>
        )}

        {liveError && (
          <div className="mb-6">
            <WarnBanner>
              <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden />
              {liveError}
            </WarnBanner>
          </div>
        )}

        {programError && !program ? (
          <section className="card mx-auto max-w-lg p-8 text-center">
            <h1 className="text-2xl">We could not load your program</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">{programError}</p>
            <div className="mt-6 flex justify-center gap-2">
              <button
                className="btn btn-primary text-sm"
                disabled={loadingProgram}
                onClick={() => record && void loadProgram(record.programId, record)}
              >
                <RotateCcw className="h-4 w-4" aria-hidden /> Try again
              </button>
              <button className="btn btn-ghost text-sm" onClick={startOver}>
                <LogOut className="h-4 w-4" aria-hidden /> Start over
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="card p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="label">Program</p>
                  <h1 className="text-3xl">{displayName}</h1>
                  {loadingProgram && !program && <p className="mt-2 text-sm text-muted">Loading your program…</p>}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <StatusChip tone={statusTone}>{statusLabel}</StatusChip>
                  <span className="text-sm text-muted">Lab {currentLab} of 4 complete</span>
                </div>
              </div>
              <ProgressBar value={currentLab} total={4} />
              {program && program.status !== "completed" && currentLab < 4 && (
                <p className="mt-3 text-sm text-muted">
                  Next up: <span className="font-semibold text-ink">Lab {currentLab + 1} — {LABS[currentLab].name}</span>. {LABS[currentLab].line}
                </p>
              )}
              {program?.status === "completed" && (
                <p className="mt-3 text-sm text-ok">
                  All four labs complete — your plan is on paper. Keep the rhythm: reviews keep it honest.
                </p>
              )}
            </section>

            <div className="mt-6 grid gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <LabSchedule
                  programId={record.programId}
                  currentLab={currentLab}
                  sessions={sessions}
                  onChange={setSessions}
                  onProgramChanged={handleLabMutated}
                />
                <InitiativesPanel programId={record.programId} />
              </div>
              <div className="space-y-6">
                <CoachFeed programId={record.programId} />
                <ReviewCycles programId={record.programId} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}