import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";
import {
  FAKE_LAB_SEGMENTS,
  type ClientRole,
  type ClientToServerMessage,
  type LeaderOverride,
  type ServerToClientMessage,
  type SessionState,
} from "./session-protocol.ts";

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
 * This session added: full-state-on-join re-verified, D1-checkpoint restore
 * on lost storage, and the §5.5 leader contract (backtrack_segment +
 * leader_override, screen-role-only).
 * NOT in scope here: real curriculum specs (Phase 2 loader, not this file),
 * org/program wiring (Phase 6 — the room keys live in src/program/),
 * degraded-mode prompt cache (Phase 5/6).
 */
export class SessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<SessionState>("sessionState");
      // Recovery hierarchy: durable storage is authoritative and survives
      // eviction; the D1 checkpoint (written by the 30s alarm and at
      // segment boundaries, build plan §3.2) is the disaster-recovery
      // source when that storage is gone (lost/migrated instance). Fresh
      // sessions (no row yet) fall through to initialState.
      this.state = stored ?? (await this.restoreFromCheckpoint()) ?? this.initialState();
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
      submissions: Object.fromEntries(FAKE_LAB_SEGMENTS.map((s) => [s.key, {}])),
      votes: Object.fromEntries(FAKE_LAB_SEGMENTS.map((s) => [s.key, {}])),
      startedAt: new Date().toISOString(),
    };
  }

  /** Read the latest D1 checkpoint for this session and hydrate from it.
   * Never throws — a recovery miss (no row, bad JSON, missing table) just
   * returns null and the DO starts fresh rather than failing to boot. */
  private async restoreFromCheckpoint(): Promise<SessionState | null> {
    try {
      const sessionId = this.ctx.id.name ?? this.ctx.id.toString();
      const row = await this.env.DB.prepare(
        `SELECT state_json FROM session_checkpoint WHERE session_id = ?1`,
      )
        .bind(sessionId)
        .first<{ state_json: string }>();
      if (!row) return null;
      const restored = JSON.parse(row.state_json) as SessionState;
      if (!restored || typeof restored.stateVersion !== "number") return null;
      if (!restored.submissions) restored.submissions = {}; // pre-2026-08-16 checkpoints lack the map
      await this.scheduleCheckpointAlarm(); // storage was lost — its alarm went with it
      return restored;
    } catch {
      return null;
    }
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
    // Every join — first connection or rejoin after a reconnect/eviction —
    // receives the complete current state, so a rejoining client can never
    // miss a mutation it was offline for (reconnect/replay, Phase 3).
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
      case "backtrack_segment": {
        // Same screen-role gate as advance_segment — the shared screen is
        // the leader's instrument (§5.5).
        if (attachment.role !== "screen") {
          this.sendTo(ws, { type: "error", message: "only the shared screen can backtrack segments" });
          return;
        }
        this.backtrackSegment();
        await this.persist();
        this.broadcast();
        await this.checkpointToD1(); // segment boundary — build plan §3.2
        return;
      }
      case "leader_override": {
        // "Leader override is absolute" (§5.5) — but the leader operates
        // the shared screen; phones may not override on their own behalf.
        if (attachment.role !== "screen") {
          this.sendTo(ws, { type: "error", message: "only the shared screen can override entries or votes" });
          return;
        }
        if (!this.applyLeaderOverride(message.override)) {
          this.sendTo(ws, { type: "error", message: "leader override target not found" });
          return;
        }
        await this.persist();
        this.broadcast();
        await this.checkpointToD1(); // high-value manual edit — checkpoint immediately
        return;
      }
      case "submit":
        this.recordSubmission(message.segmentKey, message.clientUuid, message.content);
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

  private backtrackSegment(): void {
    const s = this.state!;
    if (s.currentSegmentIndex > 0) {
      s.currentSegmentIndex -= 1;
    }
    s.stateVersion += 1;
  }

  private recordSubmission(segmentKey: string, clientUuid: string, content: string): void {
    // Fully ignore duplicates (count AND content): submissions carry no
    // logical clock, so a replayed offline entry must never overwrite a
    // newer response. One submission per participant per segment by design
    // ("every voice counted once"); the phone UI gates the composer after
    // the first send. Leader override is the edit path (§5.5).
    const s = this.state!;
    const seen = s.submittedClientUuids[segmentKey] ?? [];
    if (seen.includes(clientUuid)) return; // dedup by client-generated UUID
    seen.push(clientUuid);
    s.submittedClientUuids[segmentKey] = seen;
    s.submissionCounts[segmentKey] = (s.submissionCounts[segmentKey] ?? 0) + 1;
    const segmentSubs = s.submissions[segmentKey] ?? {};
    segmentSubs[clientUuid] = { content };
    s.submissions[segmentKey] = segmentSubs;
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

  /**
   * Applies a leader override. Returns false when the target entry or vote
   * doesn't exist (the UI should only offer override on real entries, so a
   * miss is a client error, not a silent no-op). Submission override
   * rewrites the stored content. Vote override forces the optionId but
   * deliberately keeps the voter's existing logicalClock: the clock check
   * then rejects any stale replay (clock ≤ stored) while the voter's next
   * genuine vote (strictly higher clock) still lands — "absolute" without
   * breaking the clock discipline or needing client clock sync.
   */
  private applyLeaderOverride(override: LeaderOverride): boolean {
    const s = this.state!;
    if (override.kind === "submission") {
      const target = s.submissions[override.segmentKey]?.[override.clientUuid];
      if (!target) return false;
      if (target.content !== override.newContent) {
        target.content = override.newContent;
        s.stateVersion += 1;
      }
      return true;
    }
    const target = s.votes[override.segmentKey]?.[override.voterUuid];
    if (!target) return false;
    if (target.optionId !== override.optionId) {
      target.optionId = override.optionId;
      s.stateVersion += 1;
    }
    return true;
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

