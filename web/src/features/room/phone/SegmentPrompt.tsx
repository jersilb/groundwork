import { Clock } from "lucide-react";
import type { SegmentDef } from "../../../lib/types";

interface SegmentPromptProps {
  segment: SegmentDef;
  index: number;
  total: number;
}

/**
 * The current prompt, front and center: position in the run, the prompt
 * itself in the display face, planned length, and a progress strip that
 * mirrors the big screen's segment language so the room reads together.
 */
export default function SegmentPrompt({ segment, index, total }: SegmentPromptProps) {
  return (
    <section aria-label="Current prompt">
      <div className="flex items-center justify-between gap-3">
        <span className="chip bg-brand-soft text-brand">
          Segment {index + 1} of {total}
        </span>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-muted">
          <Clock className="h-4 w-4" aria-hidden />
          {segment.plannedMinutes} min
        </span>
      </div>

      <h1 className="mt-3 text-[1.75rem] leading-snug text-ink">{segment.title}</h1>

      <div
        className="mt-4 flex gap-1.5"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={index + 1}
        aria-label={"Segment " + (index + 1) + " of " + total}
      >
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={"h-1.5 flex-1 rounded-full " + (i <= index ? "bg-accent" : "bg-line")}
          />
        ))}
      </div>
    </section>
  );
}
