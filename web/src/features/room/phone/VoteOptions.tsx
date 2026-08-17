import { Check, Vote } from "lucide-react";

interface VoteOptionsProps {
  /** The distinct options currently on the table for this segment. */
  options: string[];
  /** The option this participant has chosen, if any. */
  myVote: string | undefined;
  onVote(optionId: string): void;
}

/**
 * The participant's private vote surface: the distinct options for the
 * current segment as large tappable rows. Tapping casts (or re-casts) a
 * vote — no tallies here; the running count belongs to the shared screen,
 * so a vote stays personal until it lands in the room's view.
 */
export default function VoteOptions({ options, myVote, onVote }: VoteOptionsProps) {
  return (
    <section aria-label="Room vote" className="card p-5">
      <div className="flex items-center gap-2 text-muted">
        <Vote className="h-5 w-5 shrink-0" aria-hidden />
        <h2 className="font-sans text-sm font-semibold text-ink">Room vote</h2>
        {myVote && (
          <span className="ml-auto chip bg-ok-soft text-ok">
            <Check className="h-3.5 w-3.5" aria-hidden />
            Your vote is in
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-2.5">
        {options.map((optionId) => {
          const selected = optionId === myVote;
          return (
            <button
              key={optionId}
              type="button"
              onClick={() => onVote(optionId)}
              aria-pressed={selected}
              className={
                "flex min-h-12 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-[1.02rem] font-semibold transition-colors " +
                (selected
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-line-strong bg-surface text-ink-soft hover:bg-brand-soft")
              }
            >
              <span>{optionId}</span>
              <span
                className={
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 " +
                  (selected ? "border-accent bg-accent text-white" : "border-line-strong")
                }
                aria-hidden
              >
                {selected && <Check className="h-4 w-4" />}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-sm text-muted">
        {myVote ? "Tap another option to change your vote." : "Tap an option to add your vote to the room."}
      </p>
    </section>
  );
}
