import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";
import type {
  ClientRole,
  ClientToServerMessage,
  SegmentDef,
  ServerToClientMessage,
  SessionState,
} from "./session-protocol.ts";

// Phase 1 hardcoded fake lab (build plan §7 Phase 1: "Segment advance,
// hardcoded three-segment fake lab. No AI yet."). Real segment specs load
// from content/packs/ starting Phase 2 — see guide-engine-architect.
const FAKE_LAB_SEGMENTS: SegmentDef[] = [
  { key: "welcome", title: "Welcome", plannedMinutes: 2 },
  { key: "warmup", title: "Warm-up question", plannedMinutes: 3 },
  { key: "wrapup", title: "Wrap-up", plannedMinutes: 2 },
];

const CHECKPOINT_INTERVAL_MS = 30_000;

interface SocketAttachment {
  role: ClientRole;
  clientId: string;
}

/**
 * SessionDO — one instance per live lab session, keyed by the session id
 * the Worker used to call `idFromName`. Single authoritative in-memory
 * (+ durable-storage-backed) copy of session state, per build plan §3.2.
 *
 * Phase 1: WebSocket fanout, segment advance, D1 checkpointing.
 * Phase 3 added: vote recording with per-field logical-clock reconciliation
 * (recordVote) — reconnect/replay itself lives client-side (test/resilience/
 * client.js); the server's job is just correct, idempotent handling of
 * whatever a client sends, which the Phase 1 dedup design already provided.
 * NOT in scope here: real curriculum specs (Phase 2 loader, not this file),
 * org/program wiring (Phase 6), degraded-mode prompt cache (Phase 5/6).
 */
export class SessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<SessionState>("sessionState");
      this.state = stored ?? this.initialState();
    });
  }

  private initialState(): SessionState {
    const sessionId = this.ctx.id.name ?? this.ctx.id.toString();
    return {
      sessionId,
      stateVersion: 0,
      currentSegmentIndex: 0,
      segments: FAKE_LAB_SEGMENTS,
      submissionCounts: Object.fromEntries(FAKE_LAB_SEGMENTS.map((s) => [s.key, 0])),
      submittedClientUuids: Object.fromEntries(FAKE_LAB_SEGMENTS.map((s) => [s.key, []])),
      votes: Object.fromEntries(FAKE_LAB_SEGMENTS.map((s) => [s.key, {}])),
      startedAt: new Date().toISOString(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const role = url.searchParams.get("role");
    const clientId = url.searchParams.get("clientId");
    if (role !== "screen" && role !== "phone") {
      return new Response("role must be 'screen' or 'phone'", { status: 400 });
    }
    if (!clientId) {
      return new Response("clientId is required", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, clientId } satisfies SocketAttachment);

    await this.scheduleCheckpointAlarm();
    this.sendTo(server, { type: "state", state: this.state! });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, messageRaw: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;

    let message: ClientToServerMessage;
    try {
      const text = typeof messageRaw === "string" ? messageRaw : new TextDecoder().decode(messageRaw);
      message = JSON.parse(text);
    } catch {
      this.sendTo(ws, { type: "error", message: "invalid JSON" });
      return;
    }

    switch (message.type) {
      case "join":
        // Identity is established at connect time via the role/clientId
        // query params. This is an ack point reserved for future presence
        // tracking — no state mutation needed yet.
        return;
      case "advance_segment": {
        if (attachment.role !== "screen") {
          this.sendTo(ws, { type: "error", message: "only the shared screen can advance segments" });
          return;
        }
        this.advanceSegment();
        await this.persist();
        this.broadcast();
        await this.checkpointToD1(); // segment boundary — build plan §3.2
        return;
      }
      case "submit":
        this.recordSubmission(message.segmentKey, message.clientUuid);
        break;
      case "vote":
        this.recordVote(message.segmentKey, message.voterUuid, message.optionId, message.logicalClock);
        break;
      default:
        this.sendTo(ws, { type: "error", message: "unknown message type" });
        return;
    }

    await this.persist();
    this.broadcast();
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Hibernation API removes closed sockets from ctx.getWebSockets()
    // automatically. Nothing server-side to do on disconnect — replay is
    // entirely client-driven (test/resilience/client.js): the client
    // resends from its local queue on reconnect, and this DO's existing
    // dedup (recordSubmission) / logical-clock check (recordVote) make
    // that safe to receive twice.
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Same as close.
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.checkpointToD1();
    await this.scheduleCheckpointAlarm();
  }

  private advanceSegment(): void {
    const s = this.state!;
    if (s.currentSegmentIndex < s.segments.length - 1) {
      s.currentSegmentIndex += 1;
    }
    s.stateVersion += 1;
  }

  private recordSubmission(segmentKey: string, clientUuid: string): void {
    const s = this.state!;
    const seen = s.submittedClientUuids[segmentKey] ?? [];
    if (seen.includes(clientUuid)) return; // dedup by client-generated UUID
    seen.push(clientUuid);
    s.submittedClientUuids[segmentKey] = seen;
    s.submissionCounts[segmentKey] = (s.submissionCounts[segmentKey] ?? 0) + 1;
    s.stateVersion += 1;
  }

  /**
   * Reconciles by logicalClock, NOT arrival order or wall-clock time.
   * Build plan §3.3: "last-write-wins is wrong here — use per-field vector
   * timestamps for submissions." A queued offline vote replayed after
   * reconnect only overwrites the stored vote if its logical clock is
   * strictly newer, so an out-of-order replay can never clobber a vote
   * the same voter cast more recently on another connection.
   */
  private recordVote(segmentKey: string, voterUuid: string, optionId: string, logicalClock: number): void {
    const s = this.state!;
    const segmentVotes = s.votes[segmentKey] ?? {};
    const existing = segmentVotes[voterUuid];
    if (existing && existing.logicalClock >= logicalClock) return; // stale replay, ignore
    segmentVotes[voterUuid] = { optionId, logicalClock };
    s.votes[segmentKey] = segmentVotes;
    s.stateVersion += 1;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("sessionState", this.state);
  }

  private broadcast(): void {
    const message: ServerToClientMessage = { type: "state", state: this.state! };
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(payload);
    }
  }

  private sendTo(ws: WebSocket, message: ServerToClientMessage): void {
    ws.send(JSON.stringify(message));
  }

  private async scheduleCheckpointAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_INTERVAL_MS);
    }
  }

  private async checkpointToD1(): Promise<void> {
    const s = this.state;
    if (!s) return;
    await this.env.DB.prepare(
      `INSERT INTO session_checkpoint (session_id, state_version, state_json, checkpointed_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(session_id) DO UPDATE SET
         state_version = excluded.state_version,
         state_json = excluded.state_json,
         checkpointed_at = excluded.checkpointed_at`,
    )
      .bind(s.sessionId, s.stateVersion, JSON.stringify(s), new Date().toISOString())
      .run();
  }
}
