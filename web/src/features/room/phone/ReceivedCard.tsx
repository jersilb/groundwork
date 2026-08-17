import { CheckCircle2 } from "lucide-react";

interface ReceivedCardProps {
  content: string;
}

/**
 * Durable confirmation shown once the server's state includes this
 * participant's entry: their own words echoed back, with the room's
 * receipt. Echoing the text makes the confirmation concrete — the
 * participant can see exactly what the leader will read.
 */
export default function ReceivedCard({ content }: ReceivedCardProps) {
  return (
    <section role="status" className="card p-5" aria-label="Response received">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-ok" aria-hidden />
        <h2 className="font-sans text-sm font-semibold text-ink">Your response is with the room</h2>
      </div>
      <blockquote className="mt-3 border-l-2 border-accent bg-paper px-4 py-3 text-[1.02rem] leading-relaxed text-ink-soft">
        {content}
      </blockquote>
      <p className="mt-3 text-sm text-muted">The leader can read it on the big screen.</p>
    </section>
  );
}
