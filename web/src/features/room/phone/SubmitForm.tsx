import { Check, Clock3, Send } from "lucide-react";

interface SubmitFormProps {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  /** Durable input is waiting to sync (offline / reconnecting). */
  queued: boolean;
  /** Brief flash after the message went over the wire. */
  justSent: boolean;
}

/**
 * The participant's response composer: a generous textarea and a
 * thumb-sized send button, with a queued notice when the durable outbox
 * is holding input for the connection to return.
 */
export default function SubmitForm({ draft, onDraftChange, onSubmit, queued, justSent }: SubmitFormProps) {
  const empty = draft.trim().length === 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty) onSubmit();
      }}
      className="flex flex-col"
    >
      {queued && (
        <p role="status" className="mb-2.5 flex items-start gap-2 text-sm font-medium text-warn">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Saved on this phone — it will send when the connection returns.
        </p>
      )}
      <label className="label" htmlFor="response">
        Your response
      </label>
      <div className="flex items-end gap-2.5">
        <textarea
          id="response"
          className="input min-h-12 resize-none rounded-xl py-3 text-[1.05rem] leading-relaxed"
          placeholder="Your thoughts, in your own words."
          rows={2}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-accent h-12 shrink-0 px-5 text-[1rem]"
          disabled={empty}
          aria-label="Send your response to the room"
        >
          {justSent ? <Check className="h-5 w-5" aria-hidden /> : <Send className="h-5 w-5" aria-hidden />}
          {justSent ? "Sent" : "Send"}
        </button>
      </div>
    </form>
  );
}
