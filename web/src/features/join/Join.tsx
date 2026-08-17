import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Landmark } from "lucide-react";

/**
 * Join flow: enter a short session code, choose a device role. Owned by the
 * frontend UX agent (room-join UX). The code today maps directly to the
 * session key used by /session/:key/connect.
 */
export default function Join() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const normalized = code.trim().toUpperCase();

  function join(role: "screen" | "phone") {
    if (normalized.length < 3) {
      setError("Enter the session code your host shared.");
      return;
    }
    const target = role === "screen" ? `/session/${normalized}` : `/session/${normalized}/phone`;
    navigate(target);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="card w-full max-w-md p-8">
        <div className="flex items-center gap-2">
          <Landmark className="h-6 w-6 text-brand" aria-hidden />
          <span className="font-display text-lg font-semibold">Join a session</span>
        </div>
        <label className="label mt-6" htmlFor="code">
          Session code
        </label>
        <input
          id="code"
          className="input font-display text-2xl tracking-[0.3em]"
          placeholder="ABC-123"
          value={code}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && join("phone")}
        />
        {error && <p className="mt-2 text-sm text-err">{error}</p>}
        <div className="mt-6 grid gap-3">
          <button className="btn btn-primary w-full" onClick={() => join("phone")}>
            Join as participant
          </button>
          <button className="btn btn-ghost w-full" onClick={() => join("screen")}>
            Host the room on this screen
          </button>
        </div>
      </div>
    </div>
  );
}
