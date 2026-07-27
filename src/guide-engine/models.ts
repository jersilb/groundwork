// Model routing — build plan §5.1/§9: Sonnet in-session (latency matters
// live), Opus at synthesis (quality matters for the board-facing plan).
// Centralized here so a model change is a one-line edit, not a grep.
export const MODELS = {
  IN_SESSION: "claude-sonnet-5",
  SYNTHESIS: "claude-opus-5",
} as const;
