import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { SessionSocket } from "../../lib/ws";
import { useSession, getOrCreateClientId } from "../../lib/session-store";
import RoomHeader from "./screen/RoomHeader";
import DegradedBanner from "./screen/DegradedBanner";
import SegmentDisplay from "./screen/SegmentDisplay";
import LiveCounts from "./screen/LiveCounts";
import VoteResults from "./screen/VoteResults";
import AudioConsentCard from "./screen/AudioConsentCard";
import LeaderControls from "./screen/LeaderControls";
import PrepareRoom from "./screen/PrepareRoom";

/**
 * The shared screen in the room: the AI-facilitated lab surface everyone
 * watches. Connects as the screen role, renders live segment state, the
 * vote tally, recording consent + kill switch, and the leader's advance
 * control.
 */
export default function RoomScreen() {
  const { key = "" } = useParams();
  const socket = useMemo(
    () => new SessionSocket(key, "screen", getOrCreateClientId()),
    [key],
  );
  const { state, status } = useSession(socket);
  const [pendingAdvance, setPendingAdvance] = useState<number | null>(null);

  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
  }, [socket]);

  const segment = state?.segments[state.currentSegmentIndex];
  const totalSegments = state?.segments.length ?? 0;
  const isLast =
    state !== null && totalSegments > 0 && state.currentSegmentIndex >= totalSegments - 1;
  const sessionId = state?.sessionId ?? key;

  const submissions = segment ? (state?.submissionCounts[segment.key] ?? 0) : 0;
  const submitters = segment ? (state?.submittedClientUuids[segment.key]?.length ?? 0) : 0;
  const segmentVotes = segment ? (state?.votes[segment.key] ?? {}) : {};

  // A queued or round-tripped advance is resolved once the server bumps state.
  useEffect(() => {
    if (pendingAdvance !== null && state && state.stateVersion > pendingAdvance) {
      setPendingAdvance(null);
    }
  }, [state, pendingAdvance]);

  function advance() {
    if (pendingAdvance !== null || isLast) return;
    setPendingAdvance(state?.stateVersion ?? 0);
    socket.send({ type: "advance_segment" });
  }

  const hasVotes = Object.keys(segmentVotes).length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <RoomHeader sessionKey={key} status={status} />
      {status === "reconnecting" && <DegradedBanner />}

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
        <AudioConsentCard sessionId={sessionId} />

        {segment ? (
          <>
            <div className="mt-8">
              <SegmentDisplay
                segment={segment}
                index={state!.currentSegmentIndex}
                total={totalSegments}
              />
            </div>
            <LiveCounts submissions={submissions} submitters={submitters} />
            {hasVotes && <VoteResults votes={segmentVotes} />}
          </>
        ) : (
          <PrepareRoom sessionKey={key} status={status} />
        )}
      </main>

      {segment && (
        <LeaderControls
          onAdvance={advance}
          disabled={pendingAdvance !== null || isLast}
          isLast={isLast}
        />
      )}
    </div>
  );
}
