import { WifiOff } from "lucide-react";

/**
 * Subtle in-room notice while the socket reconnects. Input still queues
 * through the SessionSocket outbox, so this is reassurance, not an error:
 * the room keeps moving and the sync catches up.
 */
export default function DegradedBanner() {
  return (
    <div className="flex items-center justify-center gap-2.5 border-b border-warn-soft bg-warn-soft px-6 py-3 text-sm font-medium text-warn">
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
      <span>Connection is reconnecting — the room keeps moving and input is queued.</span>
    </div>
  );
}
