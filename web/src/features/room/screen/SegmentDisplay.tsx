import { Clock } from "lucide-react";
import type { SegmentDef } from "../../../lib/types";

interface SegmentDisplayProps {
  segment: SegmentDef;
  index: number;
  total: number;
}

/**
 * The current segment: title, planned length, position in the run, and a
 * progress strip the whole room can read from the back.
 */
export default function SegmentDisplay({ segment, index, total }: SegmentDisplayProps) {
  return (
    <section aria-label="Current segment">
      <div className="flex items-center justify-between gap-4">
        <span className="chip bg-brand-soft text-brand">
          Segment {index + 1} of {total}
        </span>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-muted">
          <Clock className="h-4 w-4" aria-hidden />
          {segment.plannedMinutes} min
        </span>
      </div>

      <h1 className="mt-4 text-4xl leading-tight text-ink sm:text-6xl">{segment.title}</h1>

      <div
        className="mt-6"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={index + 1}
        aria-label={"Segment " + (index + 1) + " of " + total}
      >
        <div className="flex gap-1.5">
          {Array.from({ length: total }, (_, i) => (
            <div
              key={i}
              className={"h-2 flex-1 rounded-full " + (i <= index ? "bg-accent" : "bg-line")}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
