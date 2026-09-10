// WebSocket protocol between clients and SessionDO. Node contract: explicit
// input/output shapes, no free-text — per docs/agent-team.md's topology rules.

import type { SpineAction } from "./session-runtime.ts";

export type ClientRole = "screen" | "phone";

export interface SegmentDef {
  key: string;
  title: string;
  plannedMinutes: number;
}

/** The hardcoded three-segment fake lab used through Phase 1-5 testing
 * (build plan §7 Phase 1: "Segment advance, hardcoded three-segment fake
 * lab. No AI yet."). Real segment specs load from content/packs/ starting
 * Phase 2 — see guide-engine-architect. Lives here so the SessionDO and
 * the program layer (lab_session open → opening segment_run) share one
 * definition. */
export const FAKE_LAB_SEGMENTS: SegmentDef[] = [
  { key: "welcome", title: "Welcome", plannedMinutes: 2 },
  { key: "warmup", title: "Warm-up question", plannedMinutes: 3 },
  { key: "wrapup", title: "Wrap-up", plannedMinutes: 2 },
];

/** A single voter's current vote for a segment. `logicalClock` is a
 * client-incrementing counter, not wall-clock time — build plan §3.3:
 * "last-write-wins is wrong here; use per-field vector timestamps." A
 * vote reconciles by logicalClock, not by arrival order or timestamp,
 * so replaying a queued offline vote after reconnect can't clobber a
 * newer vote the same voter cast on another device. */
export interface VoteRecord {
  optionId: string;
  logicalClock: number;
}

/** One participant submission as tracked by the server. Content is stored
 * (not just counted) so the shared screen can display it and so
 * leader_override can replace it — §5.5 "Leader override is absolute." */
export interface SubmissionRecord {
  content: string;
}

export interface SessionState {
  sessionId: string;
  stateVersion: number;
  currentSegmentIndex: number;
  segments: SegmentDef[];
  submissionCounts: Record<string, number>;
  submittedClientUuids: Record<string, string[]>;
  /** segmentKey -> clientUuid -> submission. Mirrors submittedClientUuids
   * (same key set); kept as its own map so a leader override can rewrite
   * content without touching the dedup index. */
  submissions: Record<string, Record<string, SubmissionRecord>>;
  votes: Record<string, Record<string, VoteRecord>>; // segmentKey -> voterUuid -> vote
  startedAt: string;
  /** ISO timestamp of when the current segment started — PACER's input.
   * Optional so pre-guide checkpoints (which lack it) still restore; the
   * restore path defaults it to the checkpoint time. */
  segmentStartedAt?: string;
  /** Guide Engine messages addressed to the room, oldest last, capped.
   * Rides the normal state broadcast so rejoins see full history. */
  guideLog?: GuideMessage[];
  /** Session-spine runtime (build plan §5.2) — present only in sessions
   * opened with SESSION_SPINE=true. All optional fields are backfilled on
   * restore by normalizeState, so pre-spine checkpoints load unchanged. */
  runtime?: import("./session-runtime.ts").SpineRuntime;
}

/** Protocol input limits. Rooms are 6-12 people; these caps exist to stop a
 * misbehaving client from growing the in-memory state, every future
 * broadcast, and the D1 checkpoint without bound — not to constrain real
 * facilitation (a 2,000-char answer is already an essay). */
export const MAX_SUBMISSION_CHARS = 2000;
export const MAX_VOTE_OPTION_CHARS = 200;
export const MAX_SUBMISSIONS_PER_SEGMENT = 100;
export const MAX_GUIDE_LOG_ENTRIES = 25;

/** Prompt-budget layer (guide-hardening wave 1, bug #3). The protocol caps
 * above bound what the server STORES and broadcasts; these bound what one
 * guide-engine call SENDS to a model. Without them, MAX_SUBMISSIONS_PER_SEGMENT
 * x MAX_SUBMISSION_CHARS = ~200 KB of user content could ride a single request
 * — a context-overflow failure or token-cost blowup one chatty room away. The
 * values stay generous for real facilitation: a 6-12 person room submits well
 * under a dozen answers per segment. */
export const MAX_PROMPT_SUBMISSIONS = 12;
/** Hard ceiling on an assembled guide-engine user-content payload. */
export const MAX_PROMPT_USER_CONTENT_CHARS = 24000;
/** Hard ceiling on a rolling transcript window handed to a prompt. */
export const MAX_PROMPT_TRANSCRIPT_CHARS = 12000;

/** Prefix of every truncation notice. Wherever material is elided the model
 * sees this marker, so it knows the input it received is partial. One
 * constant so the wording is defined in exactly one place. */
export const PROMPT_TRUNCATION_MARKER = "[prompt budget: older material elided]";

/** A submission carried into a prompt. `index` is its position in the
 * caller's FULL submission list — preserved through elision so SYNTHESIZER
 * provenance indices keep addressing the same entries during verification. */
export interface PromptSubmission {
  index: number;
  text: string;
}

/** The pieces a budgeted prompt render receives. */
export interface PromptBudgetPieces {
  /** Kept submissions, oldest first, original indices preserved. */
  submissions: PromptSubmission[];
  /** Transcript after tail-capping, or undefined when there was none. */
  transcript: string | undefined;
  submissionsElided: number;
  transcriptTruncated: boolean;
}

export interface PromptBudgetResult {
  content: string;
  submissionsIncluded: number;
  submissionsElided: number;
  transcriptTruncated: boolean;
}

/** Keeps the newest MAX_PROMPT_SUBMISSIONS submissions — the tail of the
 * list, which is where both the DO and the guide append new answers. */
export function selectPromptSubmissions(submissions: string[]): {
  kept: PromptSubmission[];
  elidedCount: number;
} {
  const start = Math.max(0, submissions.length - MAX_PROMPT_SUBMISSIONS);
  return {
    kept: submissions.slice(start).map((text, i) => ({ index: start + i, text })),
    elidedCount: start,
  };
}

/** Keeps the END of `text` under `budget` chars — the newest material — and
 * prefixes the truncation marker. Pure and deterministic, same input twice
 * gives the same string. */
export function truncateTextTail(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const prefix = PROMPT_TRUNCATION_MARKER + "\n";
  if (budget <= prefix.length) return { text: prefix.slice(0, budget), truncated: true };
  return { text: prefix + text.slice(text.length - (budget - prefix.length)), truncated: true };
}

/** Tail-caps a rolling transcript window. Applied where the window is built
 * (transcript-window.ts) and again by each builder, since both paths can
 * feed a prompt. Idempotent: an already-capped window passes through. */
export function capTranscriptWindow(text: string): string {
  return truncateTextTail(text, MAX_PROMPT_TRANSCRIPT_CHARS).text;
}

/** The verification source with the prompt-truncation marker removed. The
 * marker is SYSTEM boilerplate, not room speech (guide-hardening wave 1.1):
 * wherever the capped window doubles as a provenance source, a quote of the
 * marker — or of a phrase inside it — must not verify. Stripping (rather
 * than rejecting marker substrings outright) keeps every genuine quote
 * valid, and keeps one artifact verifying the same way on every route:
 * the alarm path's capped window and the manual synthesize route's raw
 * window both reject marker quotes now.
 *
 * `truncateTextTail` normally emits the full marker as a prefix; a budget
 * shorter than the marker slices it, leaving a leading fragment — strip any
 * such fragment of at least "[prompt " (a floor that avoids eating a lone
 * "[" the room could genuinely have typed). */
export function stripPromptTruncationMarker(text: string): string {
  const withoutMarkers = text.split(PROMPT_TRUNCATION_MARKER).join("");
  const MIN_FRAGMENT = "[prompt ".length;
  for (let end = PROMPT_TRUNCATION_MARKER.length - 1; end >= MIN_FRAGMENT; end--) {
    if (withoutMarkers.startsWith(PROMPT_TRUNCATION_MARKER.slice(0, end))) {
      return withoutMarkers.slice(end);
    }
  }
  return withoutMarkers;
}

/** Renders a submissions block: heading, one line per kept submission, and —
 * when older entries were shed — an explicit truncation notice. `formatLine`
 * must be deterministic; it receives the entry and its position among the
 * kept (0-based). */
export function renderPromptSubmissions(
  heading: string,
  kept: PromptSubmission[],
  elidedCount: number,
  formatLine: (entry: PromptSubmission, position: number) => string,
): string {
  const parts = [heading, kept.map(formatLine).join("\n") || "(none)"];
  if (elidedCount > 0) {
    parts.push(
      `${PROMPT_TRUNCATION_MARKER} ${elidedCount} older submission(s) omitted; the newest ${kept.length} are shown.`,
    );
  }
  return parts.join("\n\n");
}

/** Assembles a guide-engine user payload under the prompt budget.
 *
 * `render` must be deterministic — identical pieces must always produce an
 * identical string; the assembler calls it repeatedly while it sheds
 * material, always oldest-first: excess submissions are dropped before any
 * transcript text is trimmed, and the newest material survives every pass.
 * The returned content is guaranteed <= MAX_PROMPT_USER_CONTENT_CHARS. */
export function applyPromptBudget(params: {
  submissions: string[];
  transcript?: string;
  render: (pieces: PromptBudgetPieces) => string;
}): PromptBudgetResult {
  const selected = selectPromptSubmissions(params.submissions);
  let kept = selected.kept;
  let elided = selected.elidedCount;
  let transcript: string | undefined;
  let transcriptTruncated = false;
  if (params.transcript) {
    const capped = truncateTextTail(params.transcript, MAX_PROMPT_TRANSCRIPT_CHARS);
    transcript = capped.text;
    transcriptTruncated = capped.truncated;
  }

  for (;;) {
    const content = params.render({
      submissions: kept,
      transcript,
      submissionsElided: elided,
      transcriptTruncated,
    });
    if (content.length <= MAX_PROMPT_USER_CONTENT_CHARS) {
      return {
        content,
        submissionsIncluded: kept.length,
        submissionsElided: elided,
        transcriptTruncated,
      };
    }
    if (kept.length > 0) {
      kept = kept.slice(1); // shed the oldest kept submission; newest survive
      elided += 1;
      continue;
    }
    if (transcript !== undefined && transcript.length > 0) {
      const overshoot = content.length - MAX_PROMPT_USER_CONTENT_CHARS;
      const nextBudget = Math.max(0, transcript.length - overshoot - PROMPT_TRUNCATION_MARKER.length - 1);
      transcript = nextBudget === 0 ? undefined : truncateTextTail(transcript, nextBudget).text;
      transcriptTruncated = true;
      continue;
    }
    // No real segment spec makes the fixed sections alone exceed the
    // ceiling; a hard cut is the only way to keep the ceiling absolute when
    // it happens anyway.
    return {
      content:
        content.slice(0, MAX_PROMPT_USER_CONTENT_CHARS - PROMPT_TRUNCATION_MARKER.length) +
        PROMPT_TRUNCATION_MARKER,
      submissionsIncluded: 0,
      submissionsElided: elided,
      transcriptTruncated,
    };
  }
}

/** A Guide Engine message addressed to the room. Emitted by PACER (pacing
 * recommendations — never a forced advance; §5.5 keeps the leader
 * absolute), EVALUATOR/PROBER (follow-up questions when input runs thin),
 * and SYNTHESIZER (segment-boundary draft summaries). Guide messages ride
 * inside the normal state broadcast as `guideLog` so a rejoining client
 * sees the full history — no separate replay transport needed. */
export type GuideMessageKind = "pacer" | "probe" | "synthesis" | "evaluator" | "announcement" | "time_check" | "intervention";

export interface GuideMessage {
  id: string;
  kind: GuideMessageKind;
  /** What the room sees. Professional facilitator voice, no emoji. */
  text: string;
  /** Machine context: why the guide said this (verdict, overrun %, ...). */
  detail?: string;
  /** Session minutes remaining — set by PACER so console time_check bridging
   * is not stuck at a placeholder 0. */
  minutesRemaining?: number;
  segmentKey: string;
  createdAt: string;
}

/** Leader-only mutation payloads (screen role). §5.5: "Leader override is
 * absolute" — the human in the room can always rewrite a submitted entry
 * or force a vote. This is the server-side contract the UI calls; no
 * conflict-resolution UI is built here. */
export type LeaderOverride =
  | { kind: "submission"; segmentKey: string; clientUuid: string; newContent: string }
  | { kind: "vote"; segmentKey: string; voterUuid: string; optionId: string };

export type ClientToServerMessage =
  | { type: "join"; role: ClientRole; clientId: string }
  | { type: "advance_segment" }
  | { type: "backtrack_segment" }
  | { type: "submit"; segmentKey: string; clientUuid: string; content: string }
  | { type: "vote"; segmentKey: string; voterUuid: string; optionId: string; logicalClock: number }
  | { type: "leader_override"; override: LeaderOverride }
  /** Session-spine instructor action (build plan §5.4). Screen role only —
   * the shared screen is the leader's instrument (§5.5). The action is a
   * fully typed SpineAction; the DO routes it through the pure runtime.
   * `actionId` dedupes one-shot actions across reconnect replays: a queued
   * advance re-sent after a drop must never double-advance. */
  | { type: "spine_action"; action: SpineAction; actionId?: string }
  /** Participant correction of the Guide (build plan §2.1). Phones may send
   * this; the DO records it as a parked issue + event — never a mutation. */
  | { type: "guide_feedback"; aboutMessageId?: string; text: string };

// Every server response is either a full `state` broadcast — all mutations
// fan out the complete SessionState, so a rejoining client receives
// everything it missed and needs no separate resync message — or an
// `error`. No other server message types exist.
export type ServerToClientMessage =
  | { type: "state"; state: SessionState }
  | { type: "error"; message: string };
