import { Vote } from "lucide-react";
import type { VoteRecord } from "../../../lib/types";

interface VoteResultsProps {
  votes: Record<string, VoteRecord>;
}

/**
 * Ledger-style vote tally for the current segment. Each voter's latest
 * vote is grouped by option and rendered as a bar, longest first.
 */
export default function VoteResults({ votes }: VoteResultsProps) {
  const entries = Object.values(votes);
  const counts = new Map<string, number>();
  for (const vote of entries) {
    counts.set(vote.optionId, (counts.get(vote.optionId) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([optionId, count]) => ({ optionId, count }))
    .sort((a, b) => b.count - a.count);
  const totalVoters = entries.length;

  if (rows.length === 0) {
    return (
      <section className="card mt-8 p-6" aria-label="Vote results">
        <div className="flex items-center gap-2 text-muted">
          <Vote className="h-5 w-5" aria-hidden />
          <h2 className="font-sans text-sm font-semibold text-ink">Votes</h2>
        </div>
        <p className="mt-4 text-sm text-muted">No votes yet. The tally appears here as they come in.</p>
      </section>
    );
  }

  return (
    <section className="card mt-8 p-6" aria-label="Vote results">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted">
          <Vote className="h-5 w-5" aria-hidden />
          <h2 className="font-sans text-sm font-semibold text-ink">Votes</h2>
        </div>
        <span className="chip bg-brand-soft text-brand">{totalVoters} cast</span>
      </div>

      <ol className="mt-5 space-y-4">
        {rows.map((row) => {
          const pct = totalVoters > 0 ? Math.round((row.count / totalVoters) * 100) : 0;
          return (
            <li key={row.optionId} className="ledger-rule pb-4 last:border-b-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-semibold text-ink">{row.optionId}</span>
                <span className="font-display text-2xl font-semibold text-brand">{row.count}</span>
              </div>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-accent" style={{ width: pct + "%" }} />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
