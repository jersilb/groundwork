import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Landmark, Lock } from "lucide-react";
import { SessionSocket } from "../../lib/ws";
import { useSession, getOrCreateClientId } from "../../lib/session-store";
import { nextClock } from "../../lib/offline";
import ConnectionChip from "./phone/ConnectionChip";
import SegmentPrompt from "./phone/SegmentPrompt";
import SubmitForm from "./phone/SubmitForm";
import ReceivedCard from "./phone/ReceivedCard";
import VoteOptions from "./phone/VoteOptions";
import PhoneGuidePrompt from "./phone/PhoneGuidePrompt";
import { useOutbox } from "./phone/useOutbox";

/**
 * The phone client: a participant's private input surface during a lab.
 * Joins as the 'phone' role, shows the current prompt prominently, and
 * accepts text responses and votes. Every input is persisted to the
 * durable IndexedDB outbox first, so the send button keeps working
 * offline — entries drain and confirm once the connection returns.
 */
export default function PhoneClient() {
  const { key = "" } = useParams();
  const clientUuid = useMemo(() => getOrCreateClientId(), []);
  const socket = useMemo(() => new SessionSocket(key, "phone", clientUuid), [key, clientUuid]);
  const { state, status } = useSession(socket);
  const [draft, setDraft] = useState("");
  const [justSent, setJustSent] = useState(false);

  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
  }, [socket]);

  const { queued, enqueueSubmit, enqueueVote } = useOutbox(socket, status, state, clientUuid, key);

  const segment = state?.segments[state.currentSegmentIndex] ?? null;
  const total = state?.segments.length ?? 0;
  const index = state?.currentSegmentIndex ?? 0;
  const segmentKey = segment?.key ?? null;

  // Fresh composer for each segment.
  useEffect(() => {
    setDraft("");
    setJustSent(false);
  }, [segmentKey]);

  // Brief "Sent" flash once the message goes over the wire.
  useEffect(() => {
    if (!justSent) return;
    const t = window.setTimeout(() => setJustSent(false), 1800);
    return () => window.clearTimeout(t);
  }, [justSent]);

  const mySubmission = segment ? (state?.submissions[segment.key]?.[clientUuid] ?? null) : null;
  const segmentVotes = segment ? (state?.votes[segment.key] ?? {}) : {};
  const myVote = segmentVotes[clientUuid];
  const voteOptions = [...new Set(Object.values(segmentVotes).map((v) => v.optionId))];

  const offline = status !== "open";

  async function submit() {
    const content = draft.trim();
    if (!content || !segment) return;
    try {
      await enqueueSubmit(segment.key, content);
    } catch {
      // IndexedDB unavailable (e.g. private browsing) — fall back to the
      // socket's in-memory outbox rather than losing the participant's input.
    }
    if (status === "open") {
      socket.send({ type: "submit", segmentKey: segment.key, clientUuid, content });
      setJustSent(true);
    }
    setDraft("");
  }

  async function vote(optionId: string) {
    if (!segment) return;
    const logicalClock = nextClock();
    try {
      await enqueueVote(segment.key, optionId, logicalClock);
    } catch {
      // Same fallback as submit: without IndexedDB, the in-memory outbox
      // still carries the vote across a short disconnect.
    }
    if (status === "open") {
      socket.send({ type: "vote", segmentKey: segment.key, voterUuid: clientUuid, optionId, logicalClock });
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-paper pt-[env(safe-area-inset-top)]">
      <header className="ledger-rule flex items-center gap-2.5 px-5 py-4">
        <Landmark className="h-6 w-6 text-brand" aria-hidden />
        <span className="font-display text-lg font-semibold text-ink">Groundwork</span>
        <span className="ml-auto">
          <ConnectionChip status={status} />
        </span>
      </header>

      {segment ? (
        <>
          <main className="flex-1 overflow-y-auto px-5 pb-5 pt-5">
            <SegmentPrompt segment={segment} index={index} total={total} />

            <PhoneGuidePrompt messages={state?.guideLog ?? []} segmentKey={segment.key} />

            {voteOptions.length > 0 && (
              <div className="mt-5">
                <VoteOptions options={voteOptions} myVote={myVote?.optionId} onVote={(o) => void vote(o)} />
              </div>
            )}

            {mySubmission ? (
              <div className="mt-5">
                <ReceivedCard content={mySubmission.content} />
              </div>
            ) : (
              <p className="mt-5 flex items-center gap-2 text-sm text-muted">
                <Lock className="h-4 w-4 shrink-0" aria-hidden />
                Only you see this until you send it — the room reads it once it lands.
              </p>
            )}
          </main>

          {!mySubmission && (
            <footer className="border-t border-line bg-surface px-5 pb-[max(env(safe-area-inset-bottom),14px)] pt-4">
              <SubmitForm
                draft={draft}
                onDraftChange={setDraft}
                onSubmit={() => void submit()}
                queued={queued && offline}
                justSent={justSent}
              />
            </footer>
          )}
        </>
      ) : (
        <main className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Landmark className="h-10 w-10 text-brand" aria-hidden />
          <h1 className="text-2xl text-ink">
            {status === "open" ? "Waiting for the room to begin" : "Connecting to the room"}
          </h1>
          <p className="max-w-xs text-muted">
            {status === "open"
              ? "The first prompt will appear here when the room starts."
              : "This connects automatically — no need to reload."}
          </p>
        </main>
      )}
    </div>
  );
}
