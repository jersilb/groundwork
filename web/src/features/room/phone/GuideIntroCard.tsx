import { ShieldCheck } from "lucide-react";

/**
 * The AI instructor's identity and operating contract, shown on the
 * participant's phone at the start of the session (build plan §6 R1).
 * The AI leads the process; the human sponsor owns final authority;
 * participants can correct the Guide at any time. Written in the Guide's
 * own voice — experienced here, not buried in legal copy.
 */
export default function GuideIntroCard({ onDismissed }: { onDismissed: () => void }) {
  return (
    <section className="mt-5 rounded-2xl border border-brand-soft bg-brand-soft/60 p-5" aria-label="Your AI instructor">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 shrink-0 text-brand" aria-hidden />
        <h2 className="font-display text-base font-semibold text-ink">Your instructor for today is an AI</h2>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-ink-soft">
        I'm the Groundwork Guide. I will lead today's process: I explain each step, manage our time,
        ask follow-up questions, and turn what you say into draft plan notes. Every draft shows its
        sources — your own words.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5 text-sm leading-relaxed text-ink-soft">
        <li>
          <strong className="font-semibold text-ink">I do not decide</strong> your organization's priorities, beliefs, or people — your team and your sponsor do.
        </li>
        <li>
          <strong className="font-semibold text-ink">A human sponsor</strong> is in the room and can pause or overrule me at any moment.
        </li>
        <li>
          <strong className="font-semibold text-ink">You can correct me</strong> — every message I send has a "correct the Guide" link, and your correction reaches the sponsor's console.
        </li>
        <li>
          <strong className="font-semibold text-ink">What you write</strong> is seen by the room's shared screen once submitted, and is used only for this session's plan.
        </li>
      </ul>
      <button className="btn btn-primary mt-4 w-full text-sm" onClick={onDismissed}>
        Got it — let's begin
      </button>
    </section>
  );
}
