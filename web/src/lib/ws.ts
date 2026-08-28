import type { ClientRole, ClientToServerMessage, ServerToClientMessage, SessionState } from "./types";
import {
  enqueue as enqueueDurable,
  getPending as getDurablePending,
  remove as removeDurable,
  type QueuedEntry,
} from "./offline";

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface SessionSocketHandlers {
  onState?: (state: SessionState) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: SocketStatus) => void;
}

export interface SessionSocketOptions {
  /** Route submit/vote messages through the durable IndexedDB outbox
   * (web/src/lib/offline.ts) before sending, so they survive a full page
   * reload while offline and are replayed on reconnect. Replay is safe
   * because the server dedups submissions by clientUuid and reconciles
   * votes by logicalClock. Queued entries are removed only once a
   * broadcast state confirms the server applied them. advance_segment /
   * backtrack_segment / leader_override stay in the in-memory outbox
   * only — they are not idempotent and must not be replayed after a
   * reload. Defaults to false. */
  durableOutbox?: boolean;
  /** Screen-role authorization token for real lab rooms — minted by
   * POST /lab-session/:id/open and validated by the SessionDO on the
   * upgrade. Phones never send one. */
  screenToken?: string;
}

function wsUrlFor(key: string, role: ClientRole, clientId: string, screenToken?: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // The SessionDO authorizes identity at UPGRADE time via query params
  // (role + clientId, plus screenToken for screen role on real rooms) —
  // the join message is an ack point, not the gate.
  const params = new URLSearchParams({ role, clientId });
  if (role === "screen" && screenToken) params.set("screenToken", screenToken);
  return proto + "//" + window.location.host + "/session/" + key + "/connect?" + params.toString();
}

/**
 * One WebSocket connection to a session Durable Object. Responsibilities:
 *  - connect with join handshake (role + clientId)
 *  - automatic reconnect with exponential backoff (no user action needed)
 *  - an outbox so messages sent while disconnected are queued and flushed
 *    on the next successful open (durable offline queueing lives in the
 *    phone client layer on top of this)
 *  - status + state change callbacks for React stores
 */
export class SessionSocket {
  private ws: WebSocket | null = null;
  private readonly url: string;
  /** The session key this socket talks to (from the connect path). */
  readonly sessionKey: string;
  private readonly role: ClientRole;
  private readonly clientId: string;
  private readonly durableOutbox: boolean;
  /** Public so React stores can subscribe by swapping handler callbacks. */
  readonly handlers: SessionSocketHandlers;
  private status: SocketStatus = "idle";
  private reconnectAttempt = 0;
  private readonly maxReconnectDelayMs = 15_000;
  private readonly baseReconnectDelayMs = 800;
  private outbox: ClientToServerMessage[] = [];
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  state: SessionState | null = null;

  constructor(
    sessionKey: string,
    role: ClientRole,
    clientId: string,
    handlers: SessionSocketHandlers = {},
    options: SessionSocketOptions = {},
  ) {
    this.sessionKey = sessionKey;
    this.url = wsUrlFor(sessionKey, role, clientId, options.screenToken);
    this.role = role;
    this.clientId = clientId;
    this.handlers = handlers;
    this.durableOutbox = options.durableOutbox ?? false;
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  connect(): void {
    if (this.status === "connecting" || this.status === "open") return;
    this.closedByUser = false;
    this.setStatus("connecting");
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      this.send({ type: "join", role: this.role, clientId: this.clientId });
      this.flushOutbox();
      if (this.durableOutbox) void this.sendDurableQueue();
    });
    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as ServerToClientMessage;
        if (msg.type === "state") {
          this.state = msg.state;
          this.handlers.onState?.(msg.state);
          if (this.durableOutbox) void this.reconcileDurableQueue(msg.state);
        } else if (msg.type === "error") {
          this.handlers.onError?.(msg.message);
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    this.ws.addEventListener("close", () => {
      this.ws = null;
      if (this.closedByUser) {
        this.setStatus("closed");
      } else {
        this.scheduleReconnect();
      }
    });
    this.ws.addEventListener("error", () => {
      // close event follows; nothing else to do here
    });
  }

  /**
   * Send a protocol message. While the socket is not open the message is
   * queued in the outbox and flushed on the next reconnect. With the
   * durable outbox enabled, submit/vote messages are persisted to
   * IndexedDB first (surviving a full reload) and replayed on reconnect;
   * they are dropped from the queue only when a broadcast state confirms
   * the server applied them.
   */
  send(message: ClientToServerMessage): void {
    if (this.durableOutbox && (message.type === "submit" || message.type === "vote")) {
      void enqueueDurable({
        kind: message.type,
        clientUuid: message.type === "submit" ? message.clientUuid : message.voterUuid,
        segmentKey: message.segmentKey,
        payload: message.type === "submit" ? { content: message.content } : { optionId: message.optionId },
        logicalClock: message.type === "vote" ? message.logicalClock : 0,
      }).catch(() => {
        // IndexedDB unavailable (e.g. private browsing) — fall back to the
        // in-memory outbox for the short disconnect gap.
        this.outbox.push(message);
      });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      }
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.outbox.push(message);
    }
  }

  /** Replay every durable outbox entry over the freshly opened socket.
   * Entries are left in place; reconcileDurableQueue removes them once a
   * state broadcast confirms delivery. */
  private async sendDurableQueue(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = await getDurablePending();
    for (const entry of pending) {
      const message = this.durableEntryToMessage(entry);
      if (!message) continue;
      try {
        this.ws.send(JSON.stringify(message));
      } catch {
        break; // socket went away mid-drain — entries stay queued for the next reconnect
      }
    }
  }

  /** Remove durable outbox entries once a broadcast state confirms the
   * server applied them — confirmation, not "send() didn't throw", is
   * what proves delivery over a flaky connection (same discipline as the
   * Phase 3 resilience prototype). */
  private async reconcileDurableQueue(state: SessionState): Promise<void> {
    const pending = await getDurablePending();
    for (const entry of pending) {
      let applied = false;
      if (entry.kind === "submit" && entry.segmentKey) {
        applied = (state.submittedClientUuids[entry.segmentKey] ?? []).includes(entry.clientUuid);
      } else if (entry.kind === "vote" && entry.segmentKey) {
        const segmentVotes = state.votes?.[entry.segmentKey];
        const vote = segmentVotes?.[entry.clientUuid];
        applied = Boolean(vote && vote.logicalClock >= entry.logicalClock);
      }
      if (applied) await removeDurable(entry.id as number);
    }
  }

  /** Map a durable outbox entry back to its protocol message. Only submit
   * and vote entries are durable-replayable ("advance" is not idempotent
   * and is never durably queued by this socket). */
  private durableEntryToMessage(entry: QueuedEntry): ClientToServerMessage | null {
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

  private flushOutbox(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const message of pending) this.ws.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.retryTimer) return;
    this.setStatus("reconnecting");
    const delay = Math.min(
      this.baseReconnectDelayMs * 2 ** this.reconnectAttempt,
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }

  private setStatus(status: SocketStatus): void {
    this.status = status;
    this.handlers.onStatusChange?.(status);
  }
}

