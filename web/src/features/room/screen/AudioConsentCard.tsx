import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../../../lib/api";

interface ConsentState {
  consented: boolean;
  consentedAt: string | null;
  consentedBy: string | null;
  killSwitchEngaged: boolean;
}

type LoadPhase = "loading" | "ready" | "error";

interface AudioConsentCardProps {
  sessionId: string;
}

/**
 * Recording consent + kill switch for the shared screen. The leader
 * confirms consent once at session start; after that the card collapses to
 * a status row with the pause switch. Recording never blocks the room, and
 * the pause switch is always one tap away (leader override is absolute).
 */
export default function AudioConsentCard({ sessionId }: AudioConsentCardProps) {
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [busy, setBusy] = useState<"consent" | "kill" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setPhase("loading");
    setError(null);
    try {
      const result = await api.getAudioConsent(sessionId);
      if (!mounted.current) return;
      setConsent({
        consented: result.consented,
        consentedAt: result.consentedAt,
        consentedBy: result.consentedBy,
        killSwitchEngaged: result.killSwitchEngaged,
      });
      setPhase("ready");
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Could not load recording settings.");
      setPhase("error");
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function confirmConsent() {
    if (busy) return;
    setBusy("consent");
    setError(null);
    try {
      await api.postAudioConsent(sessionId, "Room host");
      setConsent((prev) =>
        prev
          ? { ...prev, consented: true, consentedBy: "Room host" }
          : { consented: true, consentedAt: null, consentedBy: "Room host", killSwitchEngaged: false },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record consent.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleKillSwitch() {
    if (!consent || busy) return;
    setBusy("kill");
    setError(null);
    try {
      const result = await api.setKillSwitch(sessionId, !consent.killSwitchEngaged);
      setConsent((prev) => (prev ? { ...prev, killSwitchEngaged: result.killSwitchEngaged } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the recording pause.");
    } finally {
      setBusy(null);
    }
  }

  if (!sessionId) return null;

  return (
    <section className="card p-6" aria-label="Recording">
      <div className="flex flex-wrap items-center gap-2.5">
        <Mic className="h-5 w-5 text-accent" aria-hidden />
        <h2 className="font-sans text-base font-semibold text-ink">Recording</h2>
        {consent?.consented && (
          <span className="chip bg-ok-soft text-ok">
            <Check className="h-3.5 w-3.5" aria-hidden /> Consent recorded
          </span>
        )}
      </div>

      {phase === "loading" && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking recording settings…
        </div>
      )}

      {phase === "error" && (
        <div className="mt-4 rounded-lg bg-err-soft p-4 text-sm text-err">
          <p>{error}</p>
          <button className="btn btn-ghost mt-3 text-sm" onClick={load}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Retry
          </button>
        </div>
      )}

      {phase === "ready" && !consent?.consented && (
        <div className="mt-4">
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            This lab records the conversation so the facilitator can turn the room's
            thinking into a plan. Recording begins only after you confirm, and you can
            pause it anytime with the switch below — it stops immediately and stays off
            until you resume.
          </p>
          <button className="btn btn-accent mt-4" onClick={confirmConsent} disabled={busy !== null}>
            {busy === "consent" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Recording consent…
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" aria-hidden /> I confirm — record this session
              </>
            )}
          </button>
        </div>
      )}

      {phase === "ready" && consent?.consented && (
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
          Recording is on for this session. Pause it anytime with the switch — the room
          goes off the record immediately.
        </p>
      )}

      {error && phase !== "error" && <p className="mt-3 text-sm text-err">{error}</p>}

      {phase === "ready" && consent && (
        <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-5">
          <div>
            <span className="label">Status</span>
            <span
              className={
                "flex items-center gap-2 text-sm font-semibold " +
                (consent.killSwitchEngaged ? "text-warn" : "text-ok")
              }
            >
              <span
                className={
                  "h-2 w-2 rounded-full " + (consent.killSwitchEngaged ? "bg-warn" : "bg-ok")
                }
              />
              {consent.killSwitchEngaged ? "Paused" : "Live"}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={consent.killSwitchEngaged}
            aria-label="Pause or resume recording"
            onClick={toggleKillSwitch}
            disabled={busy !== null}
            className="focus-ring flex items-center"
          >
            <span
              className={
                "relative inline-flex h-7 w-12 items-center rounded-full transition-colors " +
                (consent.killSwitchEngaged ? "bg-warn" : "bg-ok")
              }
            >
              <span
                className={
                  "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
                  (consent.killSwitchEngaged ? "translate-x-6" : "translate-x-1")
                }
              />
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
