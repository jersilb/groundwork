import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";
import {
  FAKE_LAB_SEGMENTS,
  MAX_SUBMISSION_CHARS,
  MAX_SUBMISSIONS_PER_SEGMENT,
  MAX_VOTE_OPTION_CHARS,
  type ClientRole,
  type ClientToServerMessage,
  type GuideMessage,
  type LeaderOverride,
  type ServerToClientMessage,
  type SessionState,
} from "./session-protocol.ts";
import {
  MIN_EVALUATE_INTERVAL_MS,
  MIN_SUBMISSIONS_TO_EVALUATE,
  appendGuideMessage,
  evaluateAndMaybeProbe,
  runPacerTick,
  specFor,
  synthesizeSegment,
  type GuideContext,
} from "./guide-engine/session-guide.ts";
import { AnthropicLlmClient, type LlmClient } from "./guide-engine/llm-client.ts";
import { ProvenanceVerificationError } from "./guide-engine/synthesizer.ts";
import { getRollingTranscriptWindow } from "./audio/transcript-window.ts";
import { saveArtifact } from "./synthesis/plan-artifact-store.ts";
import { SPINE_REFERENCE_PLAN, planToSegmentDefs, type SessionPlan } from "./session-plan.ts";
import {
  applyAction,
  computeClock,
  createRuntimeState,
  cumulativeOverrunMinutes,
  markVoteAnnounced,
  normalizeRuntime,
  spineTick,
  enqueueGuideRecommendation,
  voteQuorumReached,
  type SpineAction,
  type TransitionContext,
} from "./session-runtime.ts";

const CHECKPOINT_INTERVAL_MS = 30_000;
/** Stable log prefixes for guide telemetry — grep-able in production logs
 * (wrangler tail / Workers Logs), one line per failure and per verdict. */
const GUIDE_ERROR_LOG_PREFIX = "[guide-error]";
const GUIDE_VERDICT_LOG_PREFIX = "[guide-verdict]";
/** Backoff before retrying a guide agent after one failure. Doubles per
 * consecutive failure (60 s, 120 s, 240 s, ...) and is capped at 5 min —
 * one alarm tick is 30 s, so a healthy agent never sees a skip. */
const GUIDE_BACKOFF_BASE_MS = 30_000;
const GUIDE_BACKOFF_CAP_MS = 5 * 60_000;
/** DO-storage keys for guide health and stashed boundary syntheses — small,
 * instance-independent state that must survive eviction (no D1 schema). */
const GUIDE_HEALTH_KEY = "guideHealth";
const PENDING_SYNTHESIS_KEY = "pendingSynthesis";
/** Bound on stashed boundary passes (one per segment boundary; rooms are small). */
const MAX_PENDING_SYNTHESIS_KEYS = 8;

type GuideAgentName = "evaluator" | "pacer" | "synthesis";

/** Per-agent failure bookkeeping for the guide's LLM work. `skipUntilMs` is
 * the backoff gate; `consecutiveFailures` resets on the next success. */
interface GuideAgentHealth {
  consecutiveFailures: number;
  /** Epoch ms before which this agent must not be invoked again. */
  skipUntilMs: number;
  totalFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

type GuideHealthState = Partial<Record<GuideAgentName, GuideAgentHealth>>;

/** Real lab rooms use the deterministic "lab-<labSessionId>" key from
 * openLabSession; anything else is an ephemeral test/ad-hoc session that
 * keeps the pre-auth behavior (the test harness relies on it). */
const LAB_KEY_PATTERN = /^lab-([A-Za-z0-9_-]+)$/;

interface SocketAttachment {
  role: ClientRole;
  clientId: string;
}

/**
 * SessionDO — one instance per live lab session, keyed by the session id
 * the Worker used to call `idFromName`. Single authoritative in-memory
 * (+ durable-storage-backed) copy of session state, per build plan §3.2.
 *
 * Session spine: WebSocket hibernation fanout, dedup, per-field
 * logical-clock vote reconciliation, D1 checkpointing, full-state-on-join,
 * §5.5 leader contract (backtrack_segment + leader_override, screen-only).
 *
 * Guide Engine (live, this version): the 30s alarm doubles as PACER's
 * tick; submissions past a floor trigger EVALUATOR (PROBER on thin/
 * off_track/stuck); segment boundaries trigger SYNTHESIZER, which writes
 * provenance-verified draft artifacts server-side. The guide NEVER mutates
 * planning state and NEVER advances segments — §5.5 stays absolute; it
 * speaks through guideLog entries broadcast in the normal state payload.
 * Disabled cleanly when ANTHROPIC_API_KEY is absent or GUIDE_ENABLED=false.
 *
 * Input hardening: segment keys must exist, submissions/votes are capped
 * (MAX_* in session-protocol.ts) so one misbehaving client cannot bloat
 * in-memory state, durable storage, or the D1 checkpoint.
 *
 * Screen-role authorization: for real lab rooms (lab-<id> keys) a screen
 * connection must carry the screenToken minted by POST /lab-session/:id/open
 * and stored on the lab_session row. Ad-hoc test sessions stay open.
 */
export class SessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  private readonly ready: Promise<void>;
  // Guide runtime bookkeeping (deliberately in-memory: reset on eviction
  // costs at most one extra evaluation/pacer message, never correctness).
  private lastEvaluatedAtMs = 0;
  private lastEvaluatedCount: Record<string, number> = {};
  private lastPacerAction: string | undefined;
  private guideWorkInFlight = false;
  // Guide health: per-agent consecutive failures + exponential backoff.
  // Persisted in DO storage, so an eviction cannot silently reset a
  // backing-off agent into hammering a failing provider.
  private guideHealth: GuideHealthState = {};
  /** Boundary syntheses that could not start (mutex busy or agent backing
   * off), oldest first. Persisted so an eviction between the boundary and
   * the retry does not lose the pass. */
  private pendingSynthesisKeys: string[] = [];
  /** The segment whose synthesis pass is currently in flight, if any. A
   * second boundary for the SAME segment (a normal backtrack-and-re-advance)
   * is the boundary the running pass already covers — stashing it made the
   * in-flight finally() synthesize the segment a second time (duplicate
   * Opus spend, duplicate room message, duplicate artifacts). Set
   * synchronously with the mutex claim, cleared in the pass's finally(). */
  private synthesisInFlightKey: string | null = null;
  /** How many submissions the in-flight synthesis pass snapshotted when it
   * claimed the mutex. A same-segment boundary arriving mid-flight counts as
   * covered ONLY while the segment's submission count has not grown past
   * this high-water mark: the unconditional skip silently dropped
   * submissions that arrived after the snapshot — they reached no synthesis
   * prompt at all (CRITIC round 2, item B). Set and cleared synchronously
   * with the mutex claim. */
  private synthesisInFlightSubmissionCount: number | null = null;
  /** Segment keys whose boundary-synthesis failure notice has already
   * reached the room, so a retry or same-segment re-run can never re-publish
   * it (the room's guide log is capped at 25 messages — duplicate notices
   * evict real guide history; CRITIC round 2, item A). Cleared when a
   * synthesis pass for the segment succeeds: a later failure after real
   * progress is new information. */
  private synthesisFailureNotified = new Set<string>();
  /** Cached LLM client — one per DO instance, not one per guide action. */
  private guideClientInstance: LlmClient | null = null;
  /** The spine plan (only meaningful when SESSION_SPINE=true and this
   * session was opened on the reference plan). Cached; plans are static. */
  private spinePlan: SessionPlan | null = null;

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
      this.normalizeState();
      // Guide health + stashed boundary passes are small, instance-
      // independent state — same eviction treatment as the session itself.
      this.guideHealth = (await ctx.storage.get<GuideHealthState>(GUIDE_HEALTH_KEY)) ?? {};
      this.pendingSynthesisKeys = (await ctx.storage.get<string[]>(PENDING_SYNTHESIS_KEY)) ?? [];
    });
  }

  /** Backfill fields added after earlier checkpoints existed, so a state
   * written by the pre-guide DO restores cleanly. */
  private normalizeState(): void {
    const s = this.state!;
    if (!s.guideLog) s.guideLog = [];
    if (!s.segmentStartedAt) s.segmentStartedAt = new Date().toISOString();
    // Spine runtime: backfill missing fields on restore and keep the DO's
    // authoritative segment index mirrored in (the runtime index is derived
    // bookkeeping; the DO's index is the single source of truth).
    if (this.isSpine() && s.runtime) {
      const rt = normalizeRuntime(s.runtime);
      if (rt) {
        rt.currentSegmentIndex = s.currentSegmentIndex;
        s.runtime = rt;
        this.spinePlan = SPINE_REFERENCE_PLAN;
      } else {
        // Unreadable runtime on a spine session — rebuild it so the session
        // keeps working rather than dead-locking the console.
        s.runtime = createRuntimeState(SPINE_REFERENCE_PLAN, Date.now());
        s.runtime.currentSegmentIndex = s.currentSegmentIndex;
        this.spinePlan = SPINE_REFERENCE_PLAN;
      }
    }
  }

  /** The session-spine flag (build plan §6 R0): new sessions opened while
   * SESSION_SPINE=true run the six-hour reference plan with the full
   * runtime. Existing sessions and the fake lab behave exactly as before. */
  private isSpine(): boolean {
    return this.env.SESSION_SPINE === "true";
  }

  private initialState(): SessionState {
    const sessionId = this.ctx.id.name ?? this.ctx.id.toString();
    if (this.isSpine()) {
      const plan = SPINE_REFERENCE_PLAN;
      const segments = planToSegmentDefs(plan);
      const runtime = createRuntimeState(plan, Date.now());
      this.spinePlan = plan;
      return {
        sessionId,
        stateVersion: 0,
        currentSegmentIndex: 0,
        segments,
        submissionCounts: Object.fromEntries(segments.map((s) => [s.key, 0])),
        submittedClientUuids: Object.fromEntries(segments.map((s) => [s.key, []])),
        submissions: Object.fromEntries(segments.map((s) => [s.key, {}])),
        votes: Object.fromEntries(segments.map((s) => [s.key, {}])),
        startedAt: new Date().toISOString(),
        segmentStartedAt: new Date().toISOString(),
        guideLog: [],
        runtime,
      };
    }
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
      segmentStartedAt: new Date().toISOString(),
      guideLog: [],
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

  // ------------------------------------------------------------------
  // Guide plumbing
  // ------------------------------------------------------------------

  /** The guide runs only when explicitly enabled AND a key exists. Tests
   * set GUIDE_ENABLED=false in .dev.vars so no suite depends on a live
   * LLM; production ships GUIDE_ENABLED=true via wrangler [vars]. */
  private guideActive(): boolean {
    return Boolean(this.env.ANTHROPIC_API_KEY) && this.env.GUIDE_ENABLED !== "false";
  }

  /** One cached client per DO instance — a fresh AnthropicLlmClient per guide
   * action was pure overhead (a new SDK object, auth state, and connection
   * pool per evaluation/pacer/synthesis call). The env key is stable for an
   * instance's lifetime, so the cache never needs invalidation. */
  private guideClient(): LlmClient | null {
    if (!this.guideActive()) return null;
    if (!this.guideClientInstance) {
      this.guideClientInstance = new AnthropicLlmClient(this.env.ANTHROPIC_API_KEY!);
    }
    return this.guideClientInstance;
  }

  private guideHealthFor(agent: GuideAgentName): GuideAgentHealth {
    const existing = this.guideHealth[agent];
    if (existing) return existing;
    const fresh: GuideAgentHealth = {
      consecutiveFailures: 0,
      skipUntilMs: 0,
      totalFailures: 0,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
    };
    this.guideHealth[agent] = fresh;
    return fresh;
  }

  /** True while a prior failure still holds this agent in its backoff
   * window — the tick is skipped entirely (no LLM spend, no log spam). */
  private guideAgentSkipped(agent: GuideAgentName): boolean {
    return Date.now() < this.guideHealthFor(agent).skipUntilMs;
  }

  private async persistGuideHealth(): Promise<void> {
    await this.ctx.storage.put(GUIDE_HEALTH_KEY, this.guideHealth);
  }

  /** Success clears the streak — the backoff applies only to CONSECUTIVE
   * failures, so one bad prompt can never mute an agent for the session. */
  private async recordGuideSuccess(agent: GuideAgentName): Promise<void> {
    const health = this.guideHealthFor(agent);
    const wasBackingOff = health.consecutiveFailures > 0 || health.skipUntilMs > 0;
    health.consecutiveFailures = 0;
    health.skipUntilMs = 0;
    health.lastSuccessAt = new Date().toISOString();
    if (wasBackingOff) await this.persistGuideHealth();
  }

  /** A guide failure must never surface into the room — but it must never be
   * invisible either. One structured line with a stable prefix, a persisted
   * consecutive-failure counter, and an exponential skip for the next attempt
   * (60 s, 120 s, ... capped at 5 min). Counters live in DO storage, so an
   * eviction cannot reset a backing-off agent into hammering. */
  private async recordGuideFailure(agent: GuideAgentName, err: unknown): Promise<void> {
    const health = this.guideHealthFor(agent);
    health.consecutiveFailures += 1;
    health.totalFailures += 1;
    const now = Date.now();
    const backoffMs = Math.min(GUIDE_BACKOFF_CAP_MS, GUIDE_BACKOFF_BASE_MS * 2 ** health.consecutiveFailures);
    health.skipUntilMs = now + backoffMs;
    health.lastError = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);
    health.lastErrorAt = new Date(now).toISOString();
    console.error(
      `${GUIDE_ERROR_LOG_PREFIX} agent=${agent} consecutive=${health.consecutiveFailures} total=${health.totalFailures} retryInMs=${backoffMs} session=${this.state?.sessionId ?? "unknown"} error=${health.lastError}`,
    );
    await this.persistGuideHealth();
  }

  private currentElapsedMinutes(): number {
    const s = this.state!;
    const startedMs = s.segmentStartedAt ? Date.parse(s.segmentStartedAt) : Date.now();
    return Math.max(0, (Date.now() - (Number.isNaN(startedMs) ? Date.now() : startedMs)) / 60_000);
  }

  /** Session budget left = planned minutes of segments after the current
   * one, MINUS the overrun already incurred in completed segments and
   * breaks. An extend decision must not quietly consume the next segment's
   * time: the team-review finding (PACER ignoring cumulative overrun) is
   * fixed here. In non-spine sessions (no runtime ledger) the budget is
   * still forward-looking only — legacy behavior is unchanged. */
  private remainingBudgetMinutes(): number {
    const s = this.state!;
    const forward = s.segments.slice(s.currentSegmentIndex + 1).reduce((sum, seg) => sum + seg.plannedMinutes, 0);
    if (!s.runtime) return forward;
    const overrun = cumulativeOverrunMinutes(s.runtime, this.spinePlan ?? SPINE_REFERENCE_PLAN);
    return Math.max(0, forward - overrun);
  }

  private buildGuideContext(segmentKey: string, submissionsOverride?: string[]): GuideContext {
    const s = this.state!;
    const idx = s.segments.findIndex((seg) => seg.key === segmentKey);
    const segment = s.segments[idx >= 0 ? idx : 0];
    const submissions =
      submissionsOverride ?? Object.values(s.submissions[segmentKey] ?? {}).map((r) => r.content);
    const priorSegment = idx > 0 ? s.segments[idx - 1] : undefined;
    return {
      segment,
      elapsedSegmentMin: this.currentElapsedMinutes(),
      remainingSessionBudgetMin: this.remainingBudgetMinutes(),
      submissionCount: submissions.length,
      submissions,
      priorSegment,
      sessionId: s.sessionId,
    };
  }

  /** Append a guide message to the state and push it to every client.
   * Runs after async guide work completes; safe because it only appends
   * to guideLog and re-broadcasts. */
  private publishGuideMessage(message: GuideMessage): void {
    const s = this.state;
    if (!s) return;
    s.guideLog = appendGuideMessage(s.guideLog, message);
    // Bridge LLM Guide speech into the console recommendation queue when this
    // is a spine session. Deterministic spineTick kinds are skipped inside
    // enqueueGuideRecommendation; probe/evaluator/pacer/synthesis become
    // Accept/Edit/Dismiss rows. No-op when SESSION_SPINE is off (no runtime).
    if (s.runtime) {
      enqueueGuideRecommendation(s.runtime, message);
    }
    s.stateVersion += 1;
    this.broadcast();
    // Persist guideLog + any bridged recommendations. LLM evaluate/pacer/synthesis
    // previously broadcast-only; DO hibernation dropped LLM→console queue rows.
    void this.persist();
  }

  /** EVALUATOR(+PROBER) pass, run off the message-handling path so an LLM
   * latency spike never delays a phone's submit ack. At most one guide
   * evaluation in flight at a time; at most one per interval; only when
   * new submissions arrived since the last evaluation; skipped entirely
   * while a prior failure's backoff window is open. */
  private maybeRunEvaluation(segmentKey: string): void {
    const llm = this.guideClient();
    if (!llm || this.guideWorkInFlight) return;
    if (this.guideAgentSkipped("evaluator")) return; // backing off after consecutive failures
    const s = this.state!;
    const count = s.submissionCounts[segmentKey] ?? 0;
    if (count < MIN_SUBMISSIONS_TO_EVALUATE) return;
    if (count <= (this.lastEvaluatedCount[segmentKey] ?? 0)) return;
    if (Date.now() - this.lastEvaluatedAtMs < MIN_EVALUATE_INTERVAL_MS) return;

    this.lastEvaluatedAtMs = Date.now();
    this.lastEvaluatedCount[segmentKey] = count;
    this.guideWorkInFlight = true;
    const work = (async () => {
      const ctx = this.buildGuideContext(segmentKey);
      const spec = specFor(ctx.segment);
      const transcript = await getRollingTranscriptWindow(
        this.env,
        s.sessionId,
        segmentKey,
        ctx.priorSegment?.key,
      ).catch(() => undefined);
      const result = await evaluateAndMaybeProbe({ ...ctx, transcriptWindow: transcript }, spec, llm);
      await this.recordGuideSuccess("evaluator");
      // Verdict telemetry: production can now distinguish "guide agreed,
      // stayed silent" from "guide never ran".
      console.log(
        `${GUIDE_VERDICT_LOG_PREFIX} agent=evaluator verdict=${result.output?.verdict ?? "none"} session=${s.sessionId} segment=${segmentKey} submissions=${count}`,
      );
      if (result.proberError !== undefined) {
        // PROBER failed after a paid verdict. The fallback probe (built from
        // the evaluator's own output) was published and the evaluator is NOT
        // counted failed — its verdict was valid — but the degradation must
        // be observable.
        const detail =
          result.proberError instanceof Error
            ? `${result.proberError.name}: ${result.proberError.message}`
            : String(result.proberError);
        console.error(
          `${GUIDE_ERROR_LOG_PREFIX} agent=evaluator op=prober-fallback verdict=${result.output?.verdict ?? "none"} session=${s.sessionId} segment=${segmentKey} error=${detail.slice(0, 300)}`,
        );
      }
      if (result.message) this.publishGuideMessage(result.message);
    })()
      .catch(async (err) => {
        /* Guide failures must never surface into the room — but they are no
         * longer silent: logged, counted, and backed off. The next eligible
         * tick retries once the skip window closes. */
        await this.recordGuideFailure("evaluator", err);
      })
      .finally(async () => {
        this.guideWorkInFlight = false;
        await this.runPendingSynthesisIfIdle();
      });
    this.ctx.waitUntil(work);
  }

  /** SYNTHESIZER pass for the segment that just ended (advance/backtrack),
   * off the message path. Writes provenance-verified artifacts server-side
   * from stored submissions — client-supplied submission data is never
   * trusted for plan artifacts.
   *
   * A boundary pass that cannot start yet (the shared guide mutex is held by
   * an in-flight evaluation, or the agent is inside a failure backoff) is
   * STASHED, not dropped, and runs from the in-flight work's finally() or the
   * next alarm tick. Returning silently here used to lose the segment's draft
   * notes permanently. */
  private async runBoundarySynthesis(segmentKey: string): Promise<void> {
    const llm = this.guideClient();
    if (!llm) {
      // The guide is inactive (no key / disabled): a stashed pass can never
      // run on this instance. Drop it WITH a diagnostic — a silent return
      // made "nothing pending" indistinguishable from "pending work
      // discarded", and the stranded keys would linger forever.
      if (this.pendingSynthesisKeys.length > 0) {
        const dropped = this.pendingSynthesisKeys;
        this.pendingSynthesisKeys = [];
        console.error(
          `${GUIDE_ERROR_LOG_PREFIX} op=pending-synthesis-drop reason=guide-inactive keys=${dropped.join(",")} session=${this.state?.sessionId ?? "unknown"}`,
        );
        await this.persistPendingSynthesis();
      }
      return;
    }
    const s = this.state!;
    const submissions = Object.values(s.submissions[segmentKey] ?? {}).map((r) => r.content);
    if (submissions.length === 0) {
      // nothing in the room's input to synthesize — drop any stale stash
      this.consumePendingSynthesis(segmentKey);
      await this.persistPendingSynthesis();
      return;
    }
    if (this.guideWorkInFlight || this.guideAgentSkipped("synthesis")) {
      // A boundary for the segment a running synthesis covers is the SAME
      // boundary only while that pass's snapshot covers ALL of the segment's
      // material. Stashing the covered case let the in-flight finally() run
      // the boundary a second time after a normal backtrack-and-re-advance
      // (2x Opus spend, 2 room messages, 2 artifact rows); skipping it
      // UNCONDITIONALLY silently dropped submissions that arrived after the
      // snapshot — they reached no synthesis prompt at all (CRITIC round 2,
      // item B). Compare against the pass's high-water mark: no new material
      // → skip (the running pass is this boundary's synthesis); new material
      // → stash so it is synthesized once the mutex frees.
      if (segmentKey === this.synthesisInFlightKey) {
        const covered = this.synthesisInFlightSubmissionCount ?? 0;
        const current = Object.keys(s.submissions[segmentKey] ?? {}).length;
        if (current <= covered) return;
      }
      await this.stashPendingSynthesis(segmentKey);
      return;
    }
    // Claim the mutex AND consume the stashed key in the same tick, before
    // any await — two interleaved triggers (in-flight finally + alarm) can
    // never start two passes for one boundary, and a synthesis that already
    // succeeded can never be re-run from the stash.
    this.consumePendingSynthesis(segmentKey);
    this.guideWorkInFlight = true;
    this.synthesisInFlightKey = segmentKey;
    // The high-water mark this pass consumes — a later same-segment boundary
    // only counts as covered while the count stands still (item B).
    this.synthesisInFlightSubmissionCount = submissions.length;
    await this.persistPendingSynthesis();
    const work = (async () => {
      const ctx = this.buildGuideContext(segmentKey, submissions);
      const spec = specFor(ctx.segment);
      const transcript = await getRollingTranscriptWindow(
        this.env,
        s.sessionId,
        segmentKey,
        ctx.priorSegment?.key,
      ).catch(() => undefined);
      const result = await synthesizeSegment({ ...ctx, transcriptWindow: transcript }, spec, llm, async (artifacts) => {
        for (const artifact of artifacts) {
          await saveArtifact(this.env, s.sessionId, artifact);
        }
      });
      this.publishGuideMessage(result.message);
      await this.recordGuideSuccess("synthesis");
      // A successful pass ends the segment's failure episode: a later
      // provenance stop after real progress is new information for the room.
      this.synthesisFailureNotified.delete(segmentKey);
    })()
      .catch(async (err) => {
        if (err instanceof ProvenanceVerificationError) {
          // Provenance verification is the designed HARD STOP (a draft that
          // lies about sourcing is worse than none): tell the room honestly —
          // ONCE per boundary, deduped by segment key across re-runs — and do
          // NOT re-stash. A provenance failure cannot pass on retry, so
          // re-stashing it was pure Opus spend plus a duplicate notice that
          // evicted the room's real guide history (CRITIC round 2, item A:
          // measured ~14 attempts / ~14 notices in one simulated hour). The
          // raw input stays available for a manual synthesis from the
          // dashboard.
          if (!this.synthesisFailureNotified.has(segmentKey)) {
            this.synthesisFailureNotified.add(segmentKey);
            this.publishGuideMessage({
              id: crypto.randomUUID(),
              kind: "synthesis",
              segmentKey,
              text: `Draft notes from this segment failed source verification and were not saved. The raw input is intact — you can synthesize manually from the dashboard.`,
              createdAt: new Date().toISOString(),
            });
          }
        } else {
          /* Transient/provider/timeout/parse failures can plausibly succeed
           * on retry — re-stash so the alarm path retries after the backoff
           * window. Re-stash BEFORE recording the failure: a fault in the
           * health recorder (a storage hiccup in persistGuideHealth) used to
           * throw past this line and strand the pass (CRITIC round 2, item
           * C). Safe against livelock: the per-agent skip gate bounds how
           * often the retry can re-spend, and MAX_PENDING_SYNTHESIS_KEYS
           * bounds the list. */
          await this.stashPendingSynthesis(segmentKey);
        }
        /* Failures stay off the room's screen — but never silent: logged,
         * counted, and backed off like every other guide agent. */
        await this.recordGuideFailure("synthesis", err);
      })
      .finally(async () => {
        this.synthesisInFlightKey = null;
        this.synthesisInFlightSubmissionCount = null;
        this.guideWorkInFlight = false;
        await this.runPendingSynthesisIfIdle();
      });
    this.ctx.waitUntil(work);
  }

  /** Stash a boundary pass that could not start, and persist the list — an
   * eviction between the boundary and the retry must not lose the pass. */
  private async stashPendingSynthesis(segmentKey: string): Promise<void> {
    if (this.pendingSynthesisKeys.includes(segmentKey)) return;
    if (this.pendingSynthesisKeys.length >= MAX_PENDING_SYNTHESIS_KEYS) {
      // Bounded — the oldest pass gives way — but never silently: the drop
      // is logged so "nothing pending" is distinguishable from "pending
      // work discarded at the bound".
      const dropped = this.pendingSynthesisKeys.shift();
      console.error(
        `${GUIDE_ERROR_LOG_PREFIX} op=pending-synthesis-drop reason=bound key=${dropped} session=${this.state?.sessionId ?? "unknown"}`,
      );
    }
    this.pendingSynthesisKeys.push(segmentKey);
    await this.persistPendingSynthesis();
  }

  /** Synchronous consume: the caller claims `guideWorkInFlight` in the same
   * tick, so interleaved triggers can never run one boundary twice. */
  private consumePendingSynthesis(segmentKey: string): void {
    if (!this.pendingSynthesisKeys.includes(segmentKey)) return;
    this.pendingSynthesisKeys = this.pendingSynthesisKeys.filter((key) => key !== segmentKey);
  }

  /** Best-effort persistence for the pending-synthesis list — a storage
   * hiccup must never wedge the guide loop (the in-memory list stays
   * authoritative for this instance), but it must not be invisible either. */
  private async persistPendingSynthesis(): Promise<void> {
    try {
      await this.ctx.storage.put(PENDING_SYNTHESIS_KEY, this.pendingSynthesisKeys);
    } catch (err) {
      console.error(
        `${GUIDE_ERROR_LOG_PREFIX} op=pending-synthesis-persist session=${this.state?.sessionId ?? "unknown"} error=${(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300)}`,
      );
    }
  }

  /** Run a stashed boundary pass once the shared mutex is free — called from
   * the in-flight work's finally() and from alarm(). runBoundarySynthesis
   * consumes the stashed key synchronously before starting, so a completed
   * synthesis is never double-run. */
  private async runPendingSynthesisIfIdle(): Promise<void> {
    if (this.guideWorkInFlight) return;
    const nextKey = this.pendingSynthesisKeys[0];
    if (!nextKey) return;
    await this.runBoundarySynthesis(nextKey);
  }

  /** Route one instructor action through the pure runtime (build plan §5.4).
   * On rejection the leader gets the concrete reason back over the socket —
   * the console shows it verbatim. On success: runtime swap, index sync,
   * segment-clock refresh on boundary crossings, guide speech published,
   * then persist/broadcast/checkpoint (boundaries are high-value checkpoints,
   * build plan §3.2). */
  private async applySpineAction(action: SpineAction, ws: WebSocket, actionId?: string): Promise<void> {
    const s = this.state!;
    const rt = s.runtime;
    const plan = this.spinePlan ?? SPINE_REFERENCE_PLAN;
    if (!rt) {
      this.sendTo(ws, { type: "error", message: "this session is not running the session spine" });
      return;
    }
    const segment = s.segments[s.currentSegmentIndex];
    const spec = specFor(segment);
    const ctx: TransitionContext = {
      now: Date.now(),
      elapsedSegmentMinutes: this.currentElapsedMinutes(),
      submissionCount: s.submissionCounts[segment.key] ?? 0,
      voteCount: Object.keys(s.votes[segment.key] ?? {}).length,
      minSubmissions: spec.min_submissions ?? 0,
    };
    const endedKey = segment.key;
    const result = applyAction(plan, rt, action, ctx);
    if (!result.ok) {
      this.sendTo(ws, { type: "error", message: result.reason });
      return;
    }
    s.runtime = result.runtime;
    if (actionId) s.runtime.lastAppliedActionId = actionId;
    s.currentSegmentIndex = result.runtime.currentSegmentIndex;
    // stateVersion is the protocol's mutation counter — clients converge on
    // it (pendingAdvance in the room screen) and the D1 checkpoint records
    // it. Every applied spine action is a mutation and must bump it.
    s.stateVersion += 1;
    // Boundary crossings and session start refresh the segment clock and the
    // per-segment guide bookkeeping — identical to the legacy advance path.
    if (
      action.type === "advance_segment" ||
      action.type === "skip_segment" ||
      action.type === "backtrack_segment" ||
      action.type === "start_session" ||
      action.type === "repeat_segment" ||
      action.type === "end_break"
    ) {
      // Boundary crossings, session start, repeats, and break ends all start
      // a fresh segment clock (re-entry gets a clean window, D7).
      s.segmentStartedAt = new Date().toISOString();
      this.lastEvaluatedCount = {};
      this.lastPacerAction = undefined;
    }
    if (result.guideMessage) this.publishGuideMessage(result.guideMessage);
    await this.persist();
    this.broadcast();
    await this.checkpointToD1(); // every instructor action is high-value state — build plan §3.2
    if (action.type === "advance_segment") await this.runBoundarySynthesis(endedKey);
  }

  // ------------------------------------------------------------------
  // Connections & protocol
  // ------------------------------------------------------------------

  /** Screen-role connections on real lab rooms must present the token
   * minted when the leader opened the room. Phones and ad-hoc test
   * sessions connect as before. */
  private async screenTokenValid(sessionKey: string, token: string | null): Promise<boolean> {
    const match = sessionKey.match(LAB_KEY_PATTERN);
    if (!match) return true; // ad-hoc session — no token to check
    if (!token) return false;
    const row = await this.env.DB.prepare(`SELECT screen_token FROM lab_session WHERE id = ?1`)
      .bind(match[1])
      .first<{ screen_token: string | null }>();
    return Boolean(row?.screen_token) && row!.screen_token === token;
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

    if (role === "screen") {
      const token = url.searchParams.get("screenToken");
      // The state's sessionId IS the URL session key (idFromName).
      const sessionKey = this.state?.sessionId ?? this.ctx.id.name ?? "";
      if (!(await this.screenTokenValid(sessionKey, token))) {
        return new Response("screen token required for this room", { status: 403 });
      }
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
        if (this.isSpine() && this.state?.runtime) {
          // Spine mode: the same leader intent flows through the pure
          // runtime so boundary events, output auto-audit, and the drift
          // ledger stay authoritative.
          await this.applySpineAction({ type: "advance_segment" }, ws);
          return;
        }
        const endedKey = this.state!.segments[this.state!.currentSegmentIndex].key;
        this.advanceSegment();
        await this.persist();
        this.broadcast();
        await this.checkpointToD1(); // segment boundary — build plan §3.2
        await this.runBoundarySynthesis(endedKey);
        return;
      }
      case "backtrack_segment": {
        // Same screen-role gate as advance_segment — the shared screen is
        // the leader's instrument (§5.5).
        if (attachment.role !== "screen") {
          this.sendTo(ws, { type: "error", message: "only the shared screen can backtrack segments" });
          return;
        }
        if (this.isSpine() && this.state?.runtime) {
          await this.applySpineAction({ type: "backtrack_segment" }, ws);
          return;
        }
        this.backtrackSegment();
        await this.persist();
        this.broadcast();
        await this.checkpointToD1(); // segment boundary — build plan §3.2
        return;
      }
      case "spine_action": {
        // Instructor actions (build plan §5.4). The shared screen is the
        // leader's instrument — phones may not run leader actions on their
        // own behalf (§5.5).
        if (attachment.role !== "screen") {
          this.sendTo(ws, { type: "error", message: "only the shared screen can run instructor actions" });
          return;
        }
        if (!this.isSpine() || !this.state?.runtime) {
          this.sendTo(ws, { type: "error", message: "this session is not running the session spine" });
          return;
        }
        // One-shot dedupe across reconnect replays: the same actionId must
        // never apply twice (a queued advance re-sent after a drop cannot be
        // allowed to skip a segment the leader only pressed once).
        const rt = this.state.runtime;
        if (message.actionId && rt.lastAppliedActionId === message.actionId) {
          // Already applied before the drop — ack with the current state so
          // the console converges without re-executing.
          this.sendTo(ws, { type: "state", state: this.state });
          return;
        }
        await this.applySpineAction(message.action, ws, message.actionId);
        return;
      }
      case "guide_feedback": {
        // Participant correction of the Guide (build plan §2.1). Any role
        // may send it; it lands as a parked issue + event — never a state
        // mutation — so the correction mechanism cannot be an attack path.
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) {
          this.sendTo(ws, { type: "error", message: "feedback text is empty" });
          return;
        }
        if (text.length > 500) {
          this.sendTo(ws, { type: "error", message: "feedback text is over the 500-character limit" });
          return;
        }
        if (!this.isSpine() || !this.state?.runtime) {
          this.sendTo(ws, { type: "error", message: "this session is not running the session spine" });
          return;
        }
        await this.applySpineAction(
          { type: "park_issue", text, source: "participant", aboutMessageId: message.aboutMessageId },
          ws,
        );
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
      case "submit": {
        const rejection = this.validateSubmission(message.segmentKey, message.content);
        if (rejection) {
          this.sendTo(ws, { type: "error", message: rejection });
          return;
        }
        const wasNew = this.recordSubmission(message.segmentKey, message.clientUuid, message.content);
        await this.persist();
        this.broadcast();
        if (wasNew) this.maybeRunEvaluation(message.segmentKey);
        return;
      }
      case "vote": {
        if (!this.validateVote(message.segmentKey, message.optionId)) {
          this.sendTo(ws, { type: "error", message: "unknown segment or invalid option" });
          return;
        }
        this.recordVote(message.segmentKey, message.voterUuid, message.optionId, message.logicalClock);
        this.maybeAnnounceVoteQuorum(message.segmentKey);
        break;
      }
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

  /** The 30s alarm does double duty: D1 checkpoint (build plan §3.2) and
   * PACER's tick. PACER recommendations go to the room as guide messages;
   * it never advances on its own (§5.5). */
  async alarm(): Promise<void> {
    await this.ready;
    await this.checkpointToD1();
    await this.runPacerIfDue();
    // A boundary pass stashed while the guide mutex was busy runs here when
    // the in-flight work's finally() has not already picked it up.
    await this.runPendingSynthesisIfIdle();
    if (this.isSpine() && this.state?.runtime && this.state.runtime.phase !== "complete") {
      this.runSpineTick();
    }
    await this.scheduleCheckpointAlarm();
  }

  /** The spine's deterministic voice: drift thresholds, break running long,
   * closing pressure. Runs on the same 30s alarm as PACER; pure functions,
   * so it needs no LLM and survives an outage. */
  private runSpineTick(): void {
    const s = this.state!;
    const rt = s.runtime!;
    if (rt.guideMode === "paused" || rt.phase === "setup") return;
    const plan = this.spinePlan ?? SPINE_REFERENCE_PLAN;
    const clock = computeClock(plan, rt, {
      now: Date.now(),
      segmentStartedAt: s.segmentStartedAt ?? s.startedAt,
      currentSegmentIndex: s.currentSegmentIndex,
    });
    const segmentKey = s.segments[s.currentSegmentIndex]?.key ?? "";
    const result = spineTick(rt, clock, segmentKey);
    s.runtime = result.runtime;
    for (const message of result.guideMessages) {
      this.publishGuideMessage(message); // broadcasts + persists (hibernate-safe)
    }
    if (result.guideMessages.length > 0) {
      void this.persist();
    }
  }

  /** Vote-quorum announcement (team-review fix: vote_completed existed as an
   * exit criterion but nothing surfaced it). Fires once per segment (L5). */
  private maybeAnnounceVoteQuorum(segmentKey: string): void {
    const s = this.state!;
    const rt = s.runtime;
    if (!rt || !this.isSpine()) return;
    const voteCount = Object.keys(s.votes[segmentKey] ?? {}).length;
    const connectedPhones = this.ctx.getWebSockets("phone").length;
    if (voteQuorumReached(rt, segmentKey, voteCount, connectedPhones)) {
      markVoteAnnounced(rt, segmentKey);
      this.publishGuideMessage({
        id: crypto.randomUUID(),
        kind: "announcement",
        segmentKey,
        text: "Every connected participant has voted. The results are ready for the room whenever you want to see them.",
        detail: "vote quorum reached",
        createdAt: new Date().toISOString(),
      });
    }
  }

  private async runPacerIfDue(): Promise<void> {
    const llm = this.guideClient();
    if (!llm || this.guideWorkInFlight) return;
    if (this.guideAgentSkipped("pacer")) return; // backing off after consecutive failures
    const s = this.state!;
    // Spine sessions: PACER speaks for segments, not for breaks, and stays
    // silent when the leader has paused the Guide or taken over.
    if (s.runtime && this.isSpine()) {
      const rt = s.runtime;
      if (
        rt.phase === "break" ||
        rt.phase === "setup" ||
        rt.phase === "complete" ||
        rt.phase === "recovery" ||
        rt.guideMode === "paused"
      ) {
        return;
      }
    }
    const segmentKey = s.segments[s.currentSegmentIndex].key;
    try {
      const ctx = this.buildGuideContext(segmentKey);
      const spec = specFor(ctx.segment);
      const { message, action, escalationError } = await runPacerTick(ctx, spec, llm, this.lastPacerAction);
      this.lastPacerAction = action;
      if (message) this.publishGuideMessage(message);
      // The compress escalation is PACER's ONLY paid call. Swallowing its
      // failure (pre-wave) meant the deterministic fallback shipped while the
      // DO booked a SUCCESS — counters stayed 0, lastSuccessAt lied, and the
      // skip gate could never trip on the failure it was built for. The
      // fallback text above is unchanged; the failure is recorded honestly.
      if (escalationError !== undefined) {
        await this.recordGuideFailure("pacer", escalationError);
      } else {
        await this.recordGuideSuccess("pacer");
      }
    } catch (err) {
      // PACER is deterministic at its core; a failure here costs one tick,
      // never the session — but it is no longer invisible (or re-spent on
      // every 30s alarm while the provider is failing).
      await this.recordGuideFailure("pacer", err);
    }
  }

  // ------------------------------------------------------------------
  // State mutation (all §5.5-adjacent paths stay screen-gated above)
  // ------------------------------------------------------------------

  private advanceSegment(): void {
    const s = this.state!;
    if (s.currentSegmentIndex < s.segments.length - 1) {
      s.currentSegmentIndex += 1;
      s.segmentStartedAt = new Date().toISOString();
      this.lastEvaluatedCount = {};
      this.lastPacerAction = undefined;
    }
    s.stateVersion += 1;
  }

  private backtrackSegment(): void {
    const s = this.state!;
    if (s.currentSegmentIndex > 0) {
      s.currentSegmentIndex -= 1;
      s.segmentStartedAt = new Date().toISOString();
      this.lastEvaluatedCount = {};
      this.lastPacerAction = undefined;
    }
    s.stateVersion += 1;
  }

  /** Unknown segment keys are rejected before this; returns whether the
   * submission was new (deduped replays return false). */
  private recordSubmission(segmentKey: string, clientUuid: string, content: string): boolean {
    // Fully ignore duplicates (count AND content): submissions carry no
    // logical clock, so a replayed offline entry must never overwrite a
    // newer response. One submission per participant per segment by design
    // ("every voice counted once"); the phone UI gates the composer after
    // the first send. Leader override is the edit path (§5.5).
    const s = this.state!;
    const seen = s.submittedClientUuids[segmentKey] ?? [];
    if (seen.includes(clientUuid)) return false; // dedup by client-generated UUID
    seen.push(clientUuid);
    s.submittedClientUuids[segmentKey] = seen;
    s.submissionCounts[segmentKey] = (s.submissionCounts[segmentKey] ?? 0) + 1;
    const segmentSubs = s.submissions[segmentKey] ?? {};
    segmentSubs[clientUuid] = { content };
    s.submissions[segmentKey] = segmentSubs;
    s.stateVersion += 1;
    return true;
  }

  private validateSubmission(segmentKey: string, content: string): string | null {
    const s = this.state!;
    if (!s.submissionCounts || !(segmentKey in s.submissionCounts)) {
      return "unknown segment";
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return "submission is empty";
    }
    if (content.length > MAX_SUBMISSION_CHARS) {
      return `submission is over the ${MAX_SUBMISSION_CHARS}-character limit`;
    }
    if ((s.submissionCounts[segmentKey] ?? 0) >= MAX_SUBMISSIONS_PER_SEGMENT) {
      return "this segment is not accepting further submissions";
    }
    return null;
  }

  private validateVote(segmentKey: string, optionId: string): boolean {
    const s = this.state!;
    return Boolean(s.votes && segmentKey in s.votes) && typeof optionId === "string" && optionId.length > 0 && optionId.length <= MAX_VOTE_OPTION_CHARS;
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
    // Presence is ephemeral room health (build plan §5.4 console view) —
    // computed at broadcast time from the hibernation tags, never persisted.
    const message: ServerToClientMessage & { presence?: { phones: number; screens: number } } = {
      type: "state",
      state: this.state!,
      presence: {
        phones: this.ctx.getWebSockets("phone").length,
        screens: this.ctx.getWebSockets("screen").length,
      },
    };
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