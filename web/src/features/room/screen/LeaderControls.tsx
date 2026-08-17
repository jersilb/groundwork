import { ArrowRight, Check } from "lucide-react";

interface LeaderControlsProps {
  onAdvance: () => void;
  disabled: boolean;
  isLast: boolean;
}

/**
 * Leader-only controls pinned to the bottom of the shared screen. Advance
 * is the only move right now; a backtrack control will be added by the
 * integration agent, so no new protocol messages are introduced here.
 */
export default function LeaderControls({ onAdvance, disabled, isLast }: LeaderControlsProps) {
  return (
    <footer className="border-t border-line bg-surface px-6 py-5">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted">
          Leader controls — advance the room when this segment is done.
        </p>
        <button className="btn btn-primary text-base" onClick={onAdvance} disabled={disabled}>
          {isLast ? (
            <>
              <Check className="h-5 w-5" aria-hidden /> Final segment
            </>
          ) : (
            <>
              <ArrowRight className="h-5 w-5" aria-hidden /> Advance to next segment
            </>
          )}
        </button>
      </div>
    </footer>
  );
}
