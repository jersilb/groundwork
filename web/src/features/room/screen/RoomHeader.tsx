import { Landmark } from "lucide-react";
import type { SocketStatus } from "../../../lib/ws";
import { socketStatusMeta } from "./socketStatus";

interface RoomHeaderProps {
  sessionKey: string;
  status: SocketStatus;
  /** True when this device holds the screen token (i.e. the leader's
   * screen) — only then is the instructor console link offered. */
  isLeaderScreen?: boolean;
}

/**
 * The shared screen header. Brand on the left, the join code front and
 * center at a size the back row can read, and the live connection chip on
 * the right. The leader's screen gets a quiet link to the instructor
 * console (same session key; the token rides sessionStorage, not the URL).
 */
export default function RoomHeader({ sessionKey, status, isLeaderScreen }: RoomHeaderProps) {
  const meta = socketStatusMeta(status);
  return (
    <header className="ledger-rule bg-surface px-6 py-5">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex items-center gap-2.5">
          <Landmark className="h-7 w-7 text-brand" aria-hidden />
          <span className="font-display text-xl font-semibold text-ink">Groundwork</span>
        </div>

        <div className="flex flex-col items-center">
          <span className="label mb-1">Join code</span>
          <span
            className="font-display text-5xl font-bold tracking-[0.18em] text-brand sm:text-6xl"
            aria-label={"Session code " + sessionKey}
          >
            {sessionKey}
          </span>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span className={"chip " + meta.chipClass}>
            <span className={"h-2.5 w-2.5 rounded-full " + meta.dotClass} />
            {meta.label}
          </span>
          {isLeaderScreen && (
            <a className="text-xs font-semibold text-brand underline" href={`/console/${sessionKey}`}>
              Open instructor console →
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
