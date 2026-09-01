import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle,
  CircleStop,
  Coffee,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  SkipForward,
  Undo2,
  Users,
} from "lucide-react";
import { SessionSocket } from "../../lib/ws";
import { useSession, getOrCreateClientId } from "../../lib/session-store";
import { useScreenToken } from "../../lib/screen-token";
import { computeClockView, formatClock, itineraryStartMinutes } from "../../lib/clock";
import type { RecommendationEntry, SessionPlan, SpineAction, SpineRuntime } from "../../lib/types";

/**
 * The Instructor Console (build plan §6 R3): the human sponsor's operating
 * surface for an AI-led session. One page, eight sections, zero dev tools:
 *
 *   clock ribbon · sponsor controls · recommendation queue · itinerary ·
 *   Guide's voice · output audit · room health · event & override history
 *
 * §5.5 discipline, rendered as UI: every Guide recommendation is a DECISION
 * the leader makes (accept / edit / dismiss — recorded, not auto-applied);
 * every state change is an explicit button the leader presses. Esc pauses
 * the Guide instantly. Emergency stop is two clicks, never one.
 */
export default function InstructorConsole() {
  const { key = "" } = useParams();
  const screenToken = useScreenToken(key);
  const clientUuid = useMemo(() => getOrCreateClientId(), []);
  const [lastError, setLastError] = useState<string | null>(null);
  const socket = useMemo(
    () =>
      new SessionSocket(
        key,
        "screen",
        clientUuid,
        { onError: (m) => setLastError(m) },
        { screenToken },
      ),
    [key, screenToken, clientUuid],
  );
  const { state, status, presence } = useSession(socket);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [editingRecId, setEditingRecId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
  }, [socket]);

  // The reference plan is static data — one fetch, cached server-side.
  useEffect(() => {
    let cancelled = false;
    fetch("/session-plans/reference")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("plan unavailable (" + r.status + ")"))))
      .then((p: SessionPlan) => {
        if (!cancelled) setPlan(p);
      })
      .catch((err) => {
        if (!cancelled) setPlanError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The wall clock drives elapsed/remaining — a 1s tick is plenty.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);

  const rt = state?.runtime ?? null;

  // Esc pauses the Guide instantly — the §5.5 affordance that makes the
  // override promise physical, not theoretical.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (!rt || rt.phase === "setup" || rt.phase === "complete" || rt.guideMode === "paused") return;
      send({ type: "pause_session", reason: "Esc pressed on the console" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt?.phase, rt?.guideMode]);

  function send(action: SpineAction) {
    setLastError(null);
    // A fresh action id per press: the server dedupes reconnect replays of
    // one-shot actions (advance/backtrack/skip/break ends) by this id, so a
    // dropped connection can never double-apply a leader intent.
    socket.send({ type: "spine_action", action, actionId: crypto.randomUUID() });
  }

  const clock = plan && state && rt ? computeClockView(plan, state, rt, now) : null;
  const segment = state ? state.segments[state.currentSegmentIndex] : null;
  const pendingRecs = rt?.recommendations.filter((r) => r.status === "pending") ?? [];
  const decidedRecs = rt?.recommendations.filter((r) => r.status !== "pending").slice(-5).reverse() ?? [];
  const events = rt ? [...rt.events].slice(-40).reverse() : [];
  const missingOutputs = rt?.outputs.filter((o) => o.required && o.status !== "complete" && o.status !== "skipped") ?? [];

  if (!rt || !plan) {
    return (
      <div className="flex min-h-screen flex-col bg-paper">
        <ConsoleHeader phase={null} planId={null} status={status} />
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          <div className="card p-8">
            {planError ? (
              <>
                <h1 className="text-2xl">The session plan could not be loaded</h1>
                <p className="mt-2 text-sm text-muted">{planError}</p>
                <p className="mt-2 text-sm text-muted">
                  The console needs the reference itinerary to render the session. Retry once the service is reachable.
                </p>
              </>
            ) : status !== "open" ? (
              <>
                <h1 className="text-2xl">Connecting to the room…</h1>
                <p className="mt-2 text-sm text-muted">This connects automatically — no need to reload.</p>
              </>
            ) : (
              <>
                <h1 className="text-2xl">This session is not running the instructor console</h1>
                <p className="mt-2 text-sm text-muted">
                  Sessions opened before the session-spine update run the classic room view. Open{" "}
                  <a className="text-brand underline" href={`/session/${key}`}>
                    the shared room
                  </a>{" "}
                  instead, or start a new lab from the dashboard.
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <ConsoleHeader phase={rt.phase} planId={rt.planId} status={status} />

      {lastError && (
        <div className="border-b border-err-soft bg-err-soft px-6 py-2.5">
          <div className="mx-auto flex max-w-6xl items-center gap-2 text-sm text-err">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span className="font-medium">{lastError}</span>
          </div>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
        <ClockRibbon clock={clock} rt={rt} segmentTitle={segment?.title ?? ""} segmentIndex={state!.currentSegmentIndex} total={state!.segments.length} />

        <SponsorControls rt={rt} send={send} confirmingStop={confirmingStop} setConfirmingStop={setConfirmingStop} breakAvailable={breakAvailableFor(plan, rt)} breakoutAvailable={breakoutAvailableFor(plan, rt)} />

        <section id="recommendations" className="card">
          <CardHeader title="Guide recommendations" aside={pendingRecs.length > 0 ? `${pendingRecs.length} awaiting review` : "none pending"} />
          <div className="flex flex-col gap-4 px-6 py-5">
            {pendingRecs.length === 0 && decidedRecs.length === 0 && (
              <p className="text-sm text-muted">No recommendations right now. The Guide speaks when pacing, drift, or the closing buffer need attention.</p>
            )}
            {pendingRecs.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                editing={editingRecId === rec.id}
                editDraft={editDraft}
                onEditDraft={setEditDraft}
                onStartEdit={() => {
                  setEditingRecId(rec.id);
                  setEditDraft(rec.action.type === "time_check" || rec.action.type === "request_confirmation" ? rec.action.text : rec.reason);
                }}
                onCancelEdit={() => setEditingRecId(null)}
                onDecide={(decision, editedText) => {
                  send({ type: "decide_recommendation", recommendationId: rec.id, decision, editedText });
                  setEditingRecId(null);
                  setEditDraft("");
                }}
              />
            ))}
            {decidedRecs.map((rec) => (
              <div key={rec.id} className="flex items-center gap-3 rounded-lg border border-line bg-paper/60 px-4 py-2.5 text-sm">
                <span className="chip bg-brand-soft text-brand">{rec.status}</span>
                <span className="min-w-0 flex-1 truncate text-ink-soft">{rec.editedText ?? ("text" in rec.action ? rec.action.text : rec.reason)}</span>
                <span className="shrink-0 text-xs text-faint">{rec.action.type}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="itinerary" className="card">
          <CardHeader title="Itinerary" aside="adjustable · full history logged" />
          <Itinerary plan={plan} rt={rt} total={state!.segments.length} send={send} />
        </section>

        <section id="guide-voice" className="card">
          <CardHeader title="Guide's voice" aside="what the room sees" />
          <div className="flex flex-col gap-4 px-6 py-5">
            {(state?.guideLog ?? []).slice(-4).reverse().map((m) => (
              <div key={m.id} className="rounded-lg border border-line bg-surface px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="chip bg-accent-soft text-accent">Guide</span>
                  <span className="chip bg-brand-soft text-brand">{m.kind}</span>
                </div>
                <p className="mt-2 text-[15px] leading-relaxed text-ink">{m.text}</p>
                {m.detail && <p className="mt-1.5 text-xs italic text-muted">Why: {m.detail}</p>}
              </div>
            ))}
            {(state?.guideLog ?? []).length === 0 && <p className="text-sm text-muted">The Guide has not spoken yet.</p>}
          </div>
        </section>

        <section id="outputs" className="card">
          <CardHeader
            title="Output audit"
            aside={rt.phase === "complete" ? (rt.completedWithMissingOutputs ? "closed with gaps (recorded)" : "closed — complete") : rt.phase === "closing" ? "closing gate" : "running"}
          />
          <div className="flex flex-col gap-2 px-6 py-5">
            {rt.outputs.map((o) => (
              <div key={o.key} className="flex items-center gap-3 rounded-lg border border-line px-4 py-2.5">
                <span
                  className={
                    "chip " +
                    (o.status === "complete"
                      ? "bg-ok-soft text-ok"
                      : o.status === "skipped"
                        ? "bg-line text-muted"
                        : o.required
                          ? "bg-warn-soft text-warn"
                          : "bg-line text-muted")
                  }
                >
                  {o.status === "complete" ? "complete" : o.status === "skipped" ? "skipped" : o.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{o.title}</span>
                <span className="hidden shrink-0 text-xs text-faint sm:block">{o.kind}</span>
                {o.status !== "complete" && o.status !== "skipped" && (
                  <button className="btn btn-ghost px-3 py-1 text-xs" onClick={() => send({ type: "mark_output", outputKey: o.key })}>
                    Mark complete
                  </button>
                )}
              </div>
            ))}
            {rt.phase !== "complete" && missingOutputs.length > 0 && (
              <p className="mt-1 text-xs text-warn">
                The session cannot close while {missingOutputs.length} required output{missingOutputs.length === 1 ? " is" : "s are"} open — complete, skip, or close with a recorded override.
              </p>
            )}
          </div>
        </section>

        <section id="health" className="card">
          <CardHeader title="Room health" aside="operational only" />
          <div className="grid gap-4 px-6 py-5 sm:grid-cols-3">
            <HealthStat value={presence ? String(presence.phones) : "—"} label={presence && presence.phones === 1 ? "phone connected" : "phones connected"} />
            <HealthStat value={String(state?.submissionCounts[segment?.key ?? ""] ?? 0)} label="responses this segment" />
            <HealthStat value={String(Object.keys(state?.votes[segment?.key ?? ""] ?? {}).length)} label="votes this segment" />
          </div>
          {rt.parkedIssues.length > 0 && (
            <div className="border-t border-line px-6 py-4">
              <p className="label">Parked issues & corrections</p>
              <ul className="mt-2 flex flex-col gap-2">
                {rt.parkedIssues.slice(-5).reverse().map((i) => (
                  <li key={i.id} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-ink-soft">
                    <span className={"chip mr-2 " + (i.source === "participant" ? "bg-accent-soft text-accent" : "bg-brand-soft text-brand")}>{i.source}</span>
                    {i.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section id="history" className="card">
          <CardHeader title="Event & override history" aside={`${rt.events.length} events`} />
          <ol className="flex flex-col gap-1.5 px-6 py-5">
            {events.map((e) => (
              <li key={e.id + e.seq} className="flex items-baseline gap-3 text-sm">
                <span className="chip shrink-0 bg-line text-muted">{e.kind}</span>
                <span className="min-w-0 flex-1 text-ink-soft">{e.summary}</span>
                <span className="shrink-0 text-xs text-faint">{new Date(e.at).toLocaleTimeString()}</span>
              </li>
            ))}
            {events.length === 0 && <li className="text-sm text-muted">No events yet.</li>}
          </ol>
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ConsoleHeader({ phase, planId, status }: { phase: string | null; planId: string | null; status: string }) {
  return (
    <header className="sticky top-0 z-10 bg-brand text-inverse shadow-raise">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
        <span className="font-display text-xl font-semibold tracking-tight">
          Ground<span className="text-accent">work</span>
        </span>
        <span className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-inverse-faint sm:block">Instructor console</span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          {phase && <span className="chip bg-inverse-fill-weak text-inverse">{phase}</span>}
          {planId && <span className="hidden text-inverse-faint md:block">{planId}</span>}
          <span className="chip bg-inverse-fill-weak text-inverse">{status === "open" ? "live" : status}</span>
        </span>
      </div>
    </header>
  );
}

function CardHeader({ title, aside }: { title: string; aside?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
      <h2 className="text-lg">{title}</h2>
      {aside && <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{aside}</span>}
    </div>
  );
}

function ClockRibbon({
  clock,
  rt,
  segmentTitle,
  segmentIndex,
  total,
}: {
  clock: ReturnType<typeof computeClockView> | null;
  rt: SpineRuntime;
  segmentTitle: string;
  segmentIndex: number;
  total: number;
}) {
  const behind = clock ? clock.driftMinutes > 0.5 : false;
  const ahead = clock ? clock.driftMinutes < -0.5 : false;
  return (
    <section id="overview" className="card p-6" aria-label="Session clock">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="font-display text-5xl leading-none text-accent tabular-nums" aria-label="elapsed">
            {clock ? formatClock(clock.elapsedTotalMinutes) : "—:—"}
          </p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            of {clock ? formatClock(clock.plannedTotalMinutes) : "—"} planned
          </p>
        </div>
        <div>
          <p className="font-display text-3xl leading-none text-ink tabular-nums">{clock ? formatClock(clock.remainingMinutes) : "—"}</p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">schedule remaining</p>
        </div>
        {clock && (
          <span className={"chip " + (behind ? "bg-err-soft text-err" : ahead ? "bg-ok-soft text-ok" : "bg-brand-soft text-brand")}>
            {behind ? `▲ ${Math.round(clock.driftMinutes)} min behind` : ahead ? `▼ ${Math.round(-clock.driftMinutes)} min ahead` : "on schedule"}
          </span>
        )}
        <span className={"chip " + (rt.guideMode === "paused" ? "bg-warn-soft text-warn" : rt.guideMode === "human_led" ? "bg-accent-soft text-accent" : "bg-brand-soft text-brand")}>
          {rt.guideMode === "ai_led" ? "AI-led" : rt.guideMode === "human_led" ? "human-led" : "paused"}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          now · segment {Math.min(segmentIndex + 1, total)} of {total}
        </span>
        <span className="font-display text-xl text-ink">{segmentTitle}</span>
      </div>
    </section>
  );
}

function SponsorControls({
  rt,
  send,
  confirmingStop,
  setConfirmingStop,
  breakAvailable,
  breakoutAvailable,
}: {
  rt: SpineRuntime;
  send: (a: SpineAction) => void;
  confirmingStop: boolean;
  setConfirmingStop: (v: boolean) => void;
  breakAvailable: boolean;
  breakoutAvailable: boolean;
}) {
  const paused = rt.guideMode === "paused";
  return (
    <section id="controls" className="rounded-[14px] bg-brand p-5 text-inverse shadow-raise" aria-label="Sponsor controls">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="mr-2 font-display text-lg font-semibold">Sponsor controls</span>
        {rt.phase === "setup" && (
          <button className="btn btn-accent" onClick={() => send({ type: "start_session" })}>
            <PlayCircle className="h-4 w-4" aria-hidden /> Start session
          </button>
        )}
        {rt.phase !== "setup" && rt.phase !== "complete" && (
          <>
            {paused ? (
              <button className="btn btn-accent" onClick={() => send({ type: "resume_session" })}>
                <PlayCircle className="h-4 w-4" aria-hidden /> Resume Guide
              </button>
            ) : (
              <button className="btn btn-inverse" onClick={() => send({ type: "pause_session" })}>
                <PauseCircle className="h-4 w-4" aria-hidden /> Pause Guide
              </button>
            )}
            {rt.phase === "recovery" ? (
              <button className="btn btn-accent" onClick={() => send({ type: "return_to_ai_led" })}>
                Return to AI-led
              </button>
            ) : (
              <button className="btn btn-inverse" onClick={() => send({ type: "enter_human_led" })}>
                Take the floor
              </button>
            )}
            {breakAvailable && rt.phase === "break" && rt.breakState && (
              <>
                <button className="btn btn-inverse" onClick={() => send({ type: "extend_break", minutes: 5 })}>
                  Extend +5
                </button>
                <button className="btn btn-accent" onClick={() => send({ type: "end_break" })}>
                  <Coffee className="h-4 w-4" aria-hidden /> End break
                </button>
              </>
            )}
            {breakAvailable && rt.phase !== "break" && (
              <button className="btn btn-inverse" onClick={() => send({ type: "start_break" })}>
                <Coffee className="h-4 w-4" aria-hidden /> Start break
              </button>
            )}
            {breakoutAvailable && rt.phase !== "breakout" && (
              <button className="btn btn-inverse" onClick={() => send({ type: "start_breakout" })}>
                <Users className="h-4 w-4" aria-hidden /> Start breakout
              </button>
            )}
            {rt.phase === "breakout" && (
              <button className="btn btn-accent" onClick={() => send({ type: "end_breakout" })}>
                <Users className="h-4 w-4" aria-hidden /> End breakout
              </button>
            )}
          </>
        )}
        <span className="ml-auto hidden text-sm text-inverse-faint lg:block">Override is always one click away — Esc pauses the Guide instantly.</span>
        {!confirmingStop ? (
          <button className="btn btn-accent font-semibold" onClick={() => setConfirmingStop(true)} disabled={rt.phase === "complete" || rt.phase === "setup"}>
            Emergency stop
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <span className="text-sm text-inverse-faint">End the session now?</span>
            <button
              className="btn btn-accent"
              onClick={() => {
                send({ type: "end_session", force: true });
                setConfirmingStop(false);
              }}
            >
              <CircleStop className="h-4 w-4" aria-hidden /> Yes, close it
            </button>
            <button className="btn btn-inverse" onClick={() => setConfirmingStop(false)}>
              Keep going
            </button>
          </span>
        )}
      </div>
    </section>
  );
}

function RecommendationCard({
  rec,
  editing,
  editDraft,
  onEditDraft,
  onStartEdit,
  onCancelEdit,
  onDecide,
}: {
  rec: RecommendationEntry;
  editing: boolean;
  editDraft: string;
  onEditDraft: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDecide: (d: "accepted" | "edited" | "dismissed" | "deferred", editedText?: string) => void;
}) {
  const text = "text" in rec.action ? rec.action.text : rec.reason;
  return (
    <div className="rounded-xl border-l-4 border-accent bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip bg-accent-soft text-accent">Guide</span>
        <span className="chip bg-line text-muted">{rec.action.type.replace(/_/g, " ")}</span>
      </div>
      {editing ? (
        <div className="mt-3">
          <textarea className="input min-h-[90px]" value={editDraft} onChange={(e) => onEditDraft(e.target.value)} aria-label="Edit recommendation wording" />
          <div className="mt-2 flex gap-2">
            <button className="btn btn-primary text-sm" onClick={() => onDecide("edited", editDraft.trim() || undefined)} disabled={!editDraft.trim()}>
              Save wording
            </button>
            <button className="btn btn-ghost text-sm" onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-2.5 text-[15px] leading-relaxed text-ink">{text}</p>
          <p className="mt-1.5 text-xs italic text-muted">Why: {rec.reason}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-primary text-sm" onClick={() => onDecide("accepted")}>
              Accept
            </button>
            <button className="btn btn-ghost text-sm" onClick={onStartEdit}>
              Edit wording
            </button>
            <button className="btn btn-ghost text-sm" onClick={() => onDecide("dismissed")}>
              Dismiss
            </button>
            <button className="btn btn-ghost text-sm" onClick={() => onDecide("deferred")}>
              Defer
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Itinerary({
  plan,
  rt,
  total,
  send,
}: {
  plan: SessionPlan;
  rt: SpineRuntime;
  total: number;
  send: (a: SpineAction) => void;
}) {
  const starts = itineraryStartMinutes(plan);
  return (
    <ol className="flex flex-col px-6 py-4">
      {plan.segments.map((seg, i) => {
        const actual = rt.segmentActualMinutes[seg.key];
        const isRunning = i === rt.currentSegmentIndex && rt.phase !== "complete";
        const isDone = actual !== undefined && !isRunning;
        const isSkipped = rt.outputs.some((o) => o.segmentKey === seg.key && o.status === "skipped");
        const brk = plan.breaks.find((b) => b.afterSegmentKey === seg.key);
        const brkTaken = brk ? rt.breakActualMinutes[brk.id] : undefined;
        const bo = plan.breakouts.find((b) => b.appliesToSegmentKey === seg.key);
        const boRunning = rt.breakoutState?.breakoutId === bo?.id;
        return (
          <li key={seg.key} className="border-b border-line last:border-0">
            <div className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-faint">
                {formatClock(starts[i])}–{formatClock(starts[i] + seg.plannedMinutes)}
              </span>
              <span className={"min-w-0 flex-1 truncate text-sm " + (isRunning ? "font-semibold text-ink" : isSkipped ? "text-faint line-through" : "text-ink-soft")}>
                {seg.title}
              </span>
              {isRunning && <span className="chip bg-accent-soft text-accent">running</span>}
              {isDone && <span className="chip bg-ok-soft text-ok">done</span>}
              {isSkipped && <span className="chip bg-line text-muted">skipped</span>}
              {i === plan.segments.length - 1 && <span className="chip bg-brand-soft text-brand">protected</span>}
              {bo && (
                <span className={"chip " + (boRunning ? "bg-accent-soft text-accent" : "bg-line text-muted")}>
                  {boRunning ? "breakout live" : "breakout"}
                </span>
              )}
            </div>
            {brk && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line/60 py-2.5 pl-1">
                <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-faint">
                  {formatClock(starts[i] + seg.plannedMinutes)}–{formatClock(starts[i] + seg.plannedMinutes + brk.plannedMinutes)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted">Break</span>
                {brkTaken !== undefined ? (
                  <span className="chip bg-ok-soft text-ok">taken</span>
                ) : (
                  <span className="chip bg-line text-muted">scheduled</span>
                )}
              </div>
            )}
          </li>
        );
      })}
      <li className="flex flex-wrap gap-2 px-1 py-3">
        <button className="btn btn-ghost text-xs" onClick={() => send({ type: "backtrack_segment" })} disabled={rt.currentSegmentIndex === 0 || rt.phase === "break"}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden /> Backtrack
        </button>
        <button className="btn btn-ghost text-xs" onClick={() => send({ type: "skip_segment" })} disabled={rt.currentSegmentIndex >= plan.segments.length - 1 || rt.phase === "break"}>
          <SkipForward className="h-3.5 w-3.5" aria-hidden /> Skip segment
        </button>
        <button className="btn btn-ghost text-xs" onClick={() => send({ type: "repeat_segment" })} disabled={rt.phase === "break"}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restart this segment
        </button>
        <button className="btn btn-primary text-xs" onClick={() => send({ type: "advance_segment" })} disabled={rt.currentSegmentIndex >= plan.segments.length - 1 || rt.phase === "break"}>
          Advance segment
        </button>
        <span className="ml-auto self-center text-xs text-faint">{total} segments · {plan.breaks.length} breaks · {plan.breakouts.length} breakouts</span>
      </li>
    </ol>
  );
}

function HealthStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-center">
      <p className="font-display text-2xl text-ink tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
    </div>
  );
}

function breakAvailableFor(plan: SessionPlan, rt: SpineRuntime): boolean {
  if (rt.phase === "break") return true;
  if (rt.phase !== "active" && rt.phase !== "closing" && rt.phase !== "breakout") return false;
  const before = plan.segments[rt.currentSegmentIndex - 1]?.key;
  const here = plan.segments[rt.currentSegmentIndex]?.key;
  return plan.breaks.some((b) => b.afterSegmentKey === before || b.afterSegmentKey === here);
}

function breakoutAvailableFor(plan: SessionPlan, rt: SpineRuntime): boolean {
  if (rt.phase === "breakout") return true;
  if (rt.phase !== "active" && rt.phase !== "closing") return false;
  const here = plan.segments[rt.currentSegmentIndex]?.key;
  return plan.breakouts.some((b) => b.appliesToSegmentKey === here);
}


