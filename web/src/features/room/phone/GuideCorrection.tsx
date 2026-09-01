import { Flag } from "lucide-react";
import { useState } from "react";

/**
 * The correction mechanism (build plan §2.1): every Guide message a phone
 * shows carries a "correct the Guide" affordance. The correction is sent to
 * the server as a parked issue + event — it can never mutate session state
 * — and lands on the sponsor's console where a human decides what to do.
 */
export default function GuideCorrection({
  aboutMessageId,
  onSend,
}: {
  aboutMessageId?: string;
  onSend: (text: string, aboutMessageId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ok">
        <Flag className="h-3.5 w-3.5" aria-hidden /> Thank you — your correction reached the sponsor's console.
      </p>
    );
  }

  if (!open) {
    return (
      <button className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-muted underline" onClick={() => setOpen(true)}>
        <Flag className="h-3.5 w-3.5" aria-hidden /> Correct the Guide
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-3">
      <label className="label" htmlFor="guide-correction">
        What should the Guide have said or done?
      </label>
      <textarea
        id="guide-correction"
        className="input min-h-[64px] text-sm"
        maxLength={500}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Be specific — the sponsor reads this verbatim."
      />
      <div className="mt-2 flex gap-2">
        <button
          className="btn btn-primary px-3 py-1.5 text-xs"
          disabled={!draft.trim()}
          onClick={() => {
            onSend(draft.trim(), aboutMessageId);
            setSent(true);
          }}
        >
          Send correction
        </button>
        <button className="btn btn-ghost px-3 py-1.5 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
