import { useSyncExternalStore } from "react";
import type { SessionState } from "./types";
import type { SessionSocket, SocketStatus } from "./ws";

export interface SessionSnapshot {
  state: SessionState | null;
  status: SocketStatus;
}

const EMPTY: SessionSnapshot = { state: null, status: "idle" };

// Module-level registry per socket: one shared snapshot + one listener set,
// so multiple components can subscribe to the same socket without
// clobbering each other's handler callbacks, and getSnapshot returns a
// STABLE reference (a fresh object each call would make useSyncExternalStore
// re-render forever - React error #185).
const snapshots = new WeakMap<SessionSocket, SessionSnapshot>();
const listenerSets = new WeakMap<SessionSocket, Set<() => void>>();

function snapshotFor(socket: SessionSocket): SessionSnapshot {
  const next: SessionSnapshot = { state: socket.state, status: socket.getStatus() };
  const prev = snapshots.get(socket);
  if (prev && prev.state === next.state && prev.status === next.status) return prev;
  snapshots.set(socket, next);
  return next;
}

/**
 * Bridge a SessionSocket into a React-readable snapshot. One store per
 * socket; components subscribe with useSession(socket) and re-render on
 * state or status change.
 */
export function useSession(socket: SessionSocket | null): SessionSnapshot {
  return useSyncExternalStore<SessionSnapshot>(
    (onChange) => {
      if (!socket) return () => {};
      let set = listenerSets.get(socket);
      if (!set) {
        set = new Set();
        listenerSets.set(socket, set);
        const fire = () => {
          snapshotFor(socket);
          for (const fn of set as Set<() => void>) fn();
        };
        socket.handlers.onState = fire;
        socket.handlers.onStatusChange = fire;
      }
      set.add(onChange);
      return () => {
        set?.delete(onChange);
      };
    },
    () => (socket ? snapshotFor(socket) : EMPTY),
    () => (socket ? snapshotFor(socket) : EMPTY),
  );
}

/** Stable client id persisted per browser so reconnects are deduplicated. */
export function getOrCreateClientId(): string {
  const KEY = "groundwork.clientId";
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(KEY, id);
  return id;
}
