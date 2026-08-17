import type { SocketStatus } from "../../../lib/ws";

export interface StatusMeta {
  /** Human label for the connection chip. */
  label: string;
  /** Tailwind color class for the status dot. */
  dotClass: string;
  /** Tailwind classes for the chip's tone. */
  chipClass: string;
}

const STATUS_META: Record<SocketStatus, StatusMeta> = {
  idle: { label: "Starting", dotClass: "bg-faint", chipClass: "bg-brand-soft text-muted" },
  connecting: { label: "Connecting", dotClass: "bg-warn", chipClass: "bg-warn-soft text-warn" },
  open: { label: "Live", dotClass: "bg-ok", chipClass: "bg-ok-soft text-ok" },
  reconnecting: { label: "Reconnecting", dotClass: "bg-warn", chipClass: "bg-warn-soft text-warn" },
  closed: { label: "Disconnected", dotClass: "bg-err", chipClass: "bg-err-soft text-err" },
};

export function socketStatusMeta(status: SocketStatus): StatusMeta {
  return STATUS_META[status];
}
