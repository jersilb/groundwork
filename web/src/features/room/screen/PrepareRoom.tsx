import { KeyRound, Smartphone, Users } from "lucide-react";
import type { SocketStatus } from "../../../lib/ws";

interface PrepareRoomProps {
  sessionKey: string;
  status: SocketStatus;
}

const JOIN_STEPS = [
  {
    icon: Smartphone,
    title: "Open a phone",
    body: "Have each person open the browser on their phone.",
  },
  {
    icon: KeyRound,
    title: "Enter the code",
    body: "Type the join code, then tap 'Join as participant'.",
  },
  {
    icon: Users,
    title: "Wait for the first segment",
    body: "Responses appear here the moment they land.",
  },
];

/**
 * The "prepare the room" state, shown before the first segment while
 * everyone joins on their phones. The join code is repeated large so the
 * leader can point at it from across the room.
 */
export default function PrepareRoom({ sessionKey, status }: PrepareRoomProps) {
  const stillConnecting = status !== "open";

  return (
    <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
      <span className="chip bg-accent-soft text-accent">Preparing the room</span>

      <h1 className="mt-5 max-w-3xl text-4xl leading-tight text-ink sm:text-5xl">
        {stillConnecting ? "Connecting to the session…" : "Have everyone join with this code"}
      </h1>

      {stillConnecting ? (
        <p className="mt-4 max-w-xl text-lg text-muted">
          We are opening the room. It will be ready in a moment.
        </p>
      ) : (
        <>
          <div className="card mt-8 px-10 py-6">
            <span className="label">Join code</span>
            <span className="font-display text-7xl font-bold tracking-[0.2em] text-brand">
              {sessionKey}
            </span>
          </div>

          <ol className="mt-10 grid w-full max-w-3xl gap-4 text-left sm:grid-cols-3">
            {JOIN_STEPS.map((step) => (
              <li key={step.title} className="card p-5">
                <step.icon className="h-6 w-6 text-brand" aria-hidden />
                <h3 className="mt-3 text-lg text-ink">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
