import { Compass, HelpCircle, ListChecks, Megaphone, Timer } from "lucide-react";
import type { GuideMessage } from "../../../lib/types";

const KIND_META: Record<
  GuideMessage["kind"],
  { label: string; icon: typeof Compass; chipClass: string; textClass: string }
> = {
  pacer: {
    label: "Pacing",
    icon: Timer,
    chipClass: "bg-warn-soft text-warn",
    textClass: "text-ink",
  },
  probe: {
    label: "Follow-up",
    icon: HelpCircle,
    chipClass: "bg-accent-soft text-accent",
    textClass: "text-ink",
  },
  evaluator: {
    label: "Room read",
    icon: Compass,
    chipClass: "bg-brand-soft text-brand",
    textClass: "text-ink",
  },
  synthesis: {
    label: "Draft notes",
    icon: ListChecks,
    chipClass: "bg-ok-soft text-ok",
    textClass: "text-ink",
  },
  announcement: {
    label: "Announcement",
    icon: Megaphone,
    chipClass: "bg-brand-soft text-brand",
    textClass: "text-ink",
  },
  time_check: {
    label: "Time check",
    icon: Timer,
    chipClass: "bg-warn-soft text-warn",
    textClass: "text-ink",
  },
  intervention: {
    label: "Handoff",
    icon: Compass,
    chipClass: "bg-err-soft text-err",
    textClass: "text-ink",
  },
};

/**
 * The AI Guide's voice on the shared screen: pacing recommendations,
 * follow-up questions when input runs thin, room reads (conflict, stuck),
 * and segment-boundary draft summaries. Recommendations only — the leader
 * decides everything (§5.5); nothing here mutates the session.
 */
export default function GuidePanel({ messages }: { messages: GuideMessage[] }) {
  if (messages.length === 0) return null;
  // Newest first: the leader scans the latest guidance without scrolling.
  const ordered = [...messages].reverse();

  return (
    <section className="card p-5" aria-label="AI guide">
      <div className="flex items-center gap-2">
        <Compass className="h-5 w-5 text-brand" aria-hidden />
        <h2 className="font-display text-lg font-semibold text-ink">Guide</h2>
        <span className="chip ml-auto bg-brand-soft text-brand">AI facilitator</span>
      </div>
      <ul className="mt-4 space-y-3">
        {ordered.map((m) => {
          const meta = KIND_META[m.kind];
          const Icon = meta.icon;
          return (
            <li key={m.id} className="ledger-rule pb-3 last:border-none last:pb-0">
              <div className="flex items-start gap-2.5">
                <span className={"chip shrink-0 " + meta.chipClass}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {meta.label}
                </span>
                <div className="min-w-0">
                  <p className={"text-sm leading-relaxed " + meta.textClass}>{m.text}</p>
                  {m.detail && <p className="mt-0.5 text-xs text-faint">{m.detail}</p>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
