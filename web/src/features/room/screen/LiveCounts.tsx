import { MessageSquare, Users } from "lucide-react";

interface LiveCountsProps {
  submissions: number;
  submitters: number;
}

/**
 * Live tally for the current segment: how many responses have landed and
 * how many distinct people have contributed so far.
 */
export default function LiveCounts({ submissions, submitters }: LiveCountsProps) {
  return (
    <section className="mt-8 grid gap-4 sm:grid-cols-2" aria-label="Live counts">
      <StatCard icon={MessageSquare} label="Responses" value={submissions} />
      <StatCard icon={Users} label="People heard" value={submitters} />
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MessageSquare;
  label: string;
  value: number;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-center gap-2 text-muted">
        <Icon className="h-5 w-5" aria-hidden />
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <p className="mt-2 font-display text-6xl font-semibold text-ink">{value}</p>
    </div>
  );
}
