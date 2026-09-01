import { HelpCircle } from "lucide-react";
import type { GuideMessage } from "../../../lib/types";
import GuideCorrection from "./GuideCorrection";

interface PhoneGuidePromptProps {
  messages: GuideMessage[];
  segmentKey: string;
  /** Sends the participant's correction to the server (parked issue + event). */
  onCorrect: (text: string, aboutMessageId?: string) => void;
  /** Corrections are a session-spine feature — the server records them as
   * parked issues only there, so the affordance appears only when the
   * session actually runs the spine (no silent no-ops on legacy rooms). */
  spineActive?: boolean;
}

/**
 * The Guide's follow-up question, surfaced on the participant's phone so
 * the room can answer it right where they type. Only probes are shown on
 * phones — pacing notes and synthesis summaries belong on the shared
 * screen where the leader works. Every probe carries the correction
 * affordance: the participant can challenge the Guide's question and a
 * human sponsor sees it (build plan §2.1).
 */
export default function PhoneGuidePrompt({ messages, segmentKey, onCorrect, spineActive }: PhoneGuidePromptProps) {
  // Latest probe for THIS segment (rejoining clients see it from the log).
  const probes = messages.filter((m) => m.kind === "probe" && m.segmentKey === segmentKey);
  const latest = probes[probes.length - 1];
  if (!latest) return null;

  return (
    <div className="mt-4 rounded-xl border border-accent-soft bg-accent-soft/60 px-4 py-3" role="status">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Guide follow-up</p>
          <p className="mt-1 text-sm leading-relaxed text-ink">{latest.text}</p>
          {spineActive && <GuideCorrection aboutMessageId={latest.id} onSend={onCorrect} />}
        </div>
      </div>
    </div>
  );
}
