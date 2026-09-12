// Shared text limits for the program layer — the write-boundary caps and the
// one truncation rule, kept in a single place.
//
// Deliberately dependency-free (not even a type-only import): the web app
// (web/src/features/org/InitiativesPanel.tsx) imports this file directly so
// the input cap it enforces and the cut the server applies can never drift
// apart. web/tsconfig.json cannot resolve the rest of src/ — the Worker tree
// needs @cloudflare/workers-types and its .ts-extension imports are rejected
// there — so adding any import to this file breaks `npm run typecheck`.
// Nothing else may be added here that isn't importable by the browser.

/** Headline length. Write-boundary cap on initiative.title
 * (src/program/initiatives.ts) and read-side cap in the COACH nudge prompt
 * (src/program/coach.ts). */
export const MAX_INITIATIVE_TITLE_CHARS = 200;

/** One solid paragraph — long enough for a real step ("call the ten lapsed
 * volunteers, confirm the fall schedule, and flag anyone who wants a visit"),
 * short enough that a COACH nudge prompt built from it is bounded by
 * construction. Write-boundary cap on initiative_step.description, read-side
 * cap in coach.ts. */
export const MAX_STEP_DESCRIPTION_CHARS = 500;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** What a capped write actually stored, so the caller can tell the truth
 * about the cut instead of assuming the submission landed intact. Shared by
 * the two write-boundary functions in initiatives.ts. */
export interface CappedWrite {
  id: string;
  /** True when the write boundary cut the submitted text. */
  truncated: boolean;
  /** Length of the text actually stored, in UTF-16 code units. */
  storedLength: number;
  /** UTF-16 code units dropped from the end; 0 when nothing was cut. */
  omittedChars: number;
}

export interface TextTruncation {
  /** The text as it should be stored — identical to the input when nothing
   * needed cutting. */
  text: string;
  truncated: boolean;
  /** UTF-16 code units dropped from the end; 0 when nothing was cut. */
  omittedChars: number;
}

/** Cut for length only, never through the middle of a surrogate pair, with a
 * report of what was dropped. When the cap lands between the two halves of an
 * astral character (an emoji, say), the cut backs off one code unit so the
 * result is a valid Unicode prefix of the input instead of ill-formed UTF-16
 * ending in a lone high surrogate. Text already within the cap is returned
 * unchanged, byte for byte. */
export function truncateCharsWithInfo(text: string, maxChars: number): TextTruncation {
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };
  let end = maxChars;
  // The last kept unit is a high surrogate whose low half sits just past the
  // cut — keep the character whole by dropping the orphaned high half.
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  const cut = text.slice(0, end);
  return { text: cut, truncated: true, omittedChars: text.length - cut.length };
}

/** The string form, same rule, for callers that only need the text. */
export function truncateChars(text: string, maxChars: number): string {
  return truncateCharsWithInfo(text, maxChars).text;
}

/** The value a client should display OPTIMISTICALLY for a write that just
 * returned 201: exactly what the write boundary stored for the same input.
 * The web panel (web/src/features/org/InitiativesPanel.tsx) calls this to
 * render a just-created row; it must never render the raw submission,
 * because the server capped it — and a cut that lands between the halves of
 * a surrogate pair drops one more unit than a plain slice would (499 vs
 * 500), so a locally re-implemented cut drifts from what is stored. Kept
 * here, next to the truncation rule, so the displayed value and the stored
 * value cannot drift apart. */
export function optimisticStoredText(value: string, maxChars: number): string {
  return truncateChars(value, maxChars);
}
