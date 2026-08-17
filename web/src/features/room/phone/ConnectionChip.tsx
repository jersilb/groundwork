import type { SocketStatus } from "../../../lib/ws";
import { socketStatusMeta } from "../screen/socketStatus";

interface ConnectionChipProps {
  status: SocketStatus;
}

/**
 * The participant's connection state, in the same visual language as the
 * shared screen's chip so the two surfaces read consistently.
 */
export default function ConnectionChip({ status }: ConnectionChipProps) {
  const meta = socketStatusMeta(status);
  return (
    <span className={"chip " + meta.chipClass}>
      <span className={"h-2 w-2 rounded-full " + meta.dotClass} aria-hidden />
      {meta.label}
    </span>
  );
}
