import { useCallback, useEffect, useRef, useState } from "react";
import { enqueue, drain, getPending, remove, type QueuedEntry } from "../../../lib/offline";
import type { ClientToServerMessage, SessionState } from "../../../lib/types";
import type { SessionSocket, SocketStatus } from "../../../lib/ws";

export interface Outbox {
  /** Durable entries not yet confirmed by a broadcast state. */
  pendingCount: number;
  /** True while input is waiting to sync (the "queued" state). */
  queued: boolean;
  /** Persist a text submission so it survives reloads and offline gaps. */
  enqueueSubmit(segmentKey: string, content: string): Promise<void>;
  /** Persist a vote. The caller supplies a fresh clock from nextClock(). */
  enqueueVote(segmentKey: string, optionId: string, logicalClock: number): Promise<void>;
}

/**
 * The phone's durable outbox over web/src/lib/offline.ts (IndexedDB).
 * Every submit/vote is persisted first, then sent immediately when the
 * socket is open; while it is not, entries stay in the queue and are
 * drained on the next open. Entries are dropped only once a broadcast
 * state confirms the server applied them — confirmation by state, not
 * "the send didn't throw", is what proves delivery (same discipline as
 * the SessionSocket durableOutbox).
 */
export function useOutbox(
  socket: SessionSocket | null,
  status: SocketStatus,
  state: SessionState | null,
  clientUuid: string,
  sessionKey: string,
): Outbox {
  const [pendingCount, setPendingCount] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  const refresh = useCallback(async () => {
    try {
      const pending = await getPending();
      setPendingCount(pending.filter((e) => e.sessionKey === sessionKey || !e.sessionKey).length);
    } catch {
      setPendingCount(0);
    }
  }, [sessionKey]);

  // Replay the whole durable queue each time the socket comes up. drain()
  // removes an entry once the send succeeds; anything still pending stays
  // queued for the next open.
  useEffect(() => {
    if (status !== "open") return;
    let cancelled = false;
    void (async () => {
      try {
        await drain((entry) => {
          if (cancelled || statusRef.current !== "open") throw new Error("socket not open");
          if (entry.sessionKey && entry.sessionKey !== sessionKey) return; // another session's queue
          const message = entryToMessage(entry);
          if (!message) return;
          socket?.send(message);
        });
      } finally {
        if (!cancelled) void refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, refresh, socket]);

  // Drop entries once a broadcast state confirms the server applied them.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void (async () => {
      try {
        const pending = await getPending();
        for (const entry of pending) {
          if (entry.sessionKey && entry.sessionKey !== sessionKey) continue; // another session's queue
          if (isApplied(entry, state)) await remove(entry.id as number);
        }
      } finally {
        if (!cancelled) void refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, refresh]);

  const enqueueSubmit = useCallback(
    async (segmentKey: string, content: string) => {
      await enqueue({ kind: "submit", clientUuid, sessionKey, segmentKey, payload: { content } });
      await refresh();
    },
    [clientUuid, sessionKey, refresh],
  );

  const enqueueVote = useCallback(
    async (segmentKey: string, optionId: string, logicalClock: number) => {
      await enqueue({ kind: "vote", clientUuid, sessionKey, segmentKey, payload: { optionId }, logicalClock });
      await refresh();
    },
    [clientUuid, sessionKey, refresh],
  );

  return { pendingCount, queued: pendingCount > 0, enqueueSubmit, enqueueVote };
}

/** Map a queued entry back to its protocol message (submit/vote only). */
function entryToMessage(entry: QueuedEntry): ClientToServerMessage | null {
  if (entry.kind === "submit" && entry.segmentKey) {
    const payload = entry.payload as { content?: string } | undefined;
    return {
      type: "submit",
      segmentKey: entry.segmentKey,
      clientUuid: entry.clientUuid,
      content: payload?.content ?? "",
    };
  }
  if (entry.kind === "vote" && entry.segmentKey) {
    const payload = entry.payload as { optionId?: string } | undefined;
    return {
      type: "vote",
      segmentKey: entry.segmentKey,
      voterUuid: entry.clientUuid,
      optionId: payload?.optionId ?? "",
      logicalClock: entry.logicalClock,
    };
  }
  return null;
}

/** True when a broadcast state shows the server accepted this entry. */
function isApplied(entry: QueuedEntry, state: SessionState): boolean {
  if (!entry.segmentKey) return false;
  if (entry.kind === "submit") {
    return (state.submittedClientUuids[entry.segmentKey] ?? []).includes(entry.clientUuid);
  }
  if (entry.kind === "vote") {
    const vote = state.votes?.[entry.segmentKey]?.[entry.clientUuid];
    return Boolean(vote && vote.logicalClock >= entry.logicalClock);
  }
  return false;
}
