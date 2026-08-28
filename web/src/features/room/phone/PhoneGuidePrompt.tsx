import { HelpCircle } from "lucide-react";
import type { GuideMessage } from "../../../lib/types";

/**
 * The Guide's follow-up question, surfaced on the participant's phone so
 * the room can answer it right where they type. Only probes are shown on
 * phones — pacing notes and synthesis summaries belong on the shared
 * screen where the leader works.
 */
export default function PhoneGuidePrompt({ messages, segmentKey }: { messages: GuideMessage[]; segmentKey: string }) {
  // Latest probe for THIS segment (rejoining clients see it from the log).
  const probes = messages.filter((m) => m.kind === "probe" && m.segmentKey === segmentKey);
  const latest = probes[probes.length - 1];
  if (!latest) return null;

  return (
    <div className="mt-4 rounded-xl border border-accent-soft bg-accent-soft/60 px-4 py-3" role="status">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Guide follow-up</p>
          <p className="mt-1 text-sm leading-relaxed text-ink">{latest.text}</p>
        </div>
      </div>
    </div>
  );
}
