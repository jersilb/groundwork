// [INFRA-FLAKE-SHIELD] — test-harness-only guard against a KNOWN upstream
// wrangler dev defect, NOT an app-level retry. v2.
//
// Background (evidence: /tmp/holmes-gw/evidence + upstream issues):
// `wrangler dev` puts a ProxyWorker in front of the user worker. That proxy's
// request-forwarding connection to the runtime intermittently drops
// ("Network connection lost."). Two outcomes are observed:
//   (a) the in-flight request is rejected and the client sees an opaque
//       `500` with a non-JSON body (no per-request log line) — this produced
//       the 2026-09-11 "expected 409/403, got 500 {}" CI sightings;
//   (b) wrangler's ProxyController treats `Error inside ProxyWorker` as
//       fatal and the dev server exits mid-run (empty `✘ [ERROR]`).
// Upstream: cloudflare/workers-sdk #15203, #15452, #15317, #14641
// (fix PR #15252, released in wrangler 4.129.1 — server no longer exits;
// POST failures can still surface as a one-shot 500 / dropped response).
//
// v2 adds the TEXT-FIRST discipline the v1 coverage missed:
//   * `fetchJsonWithShield` — ONE helper for every fetch + JSON.parse site:
//     read the body as TEXT; if it carries the transport signature (or the
//     fetch itself died with a connection-reset class error) → one loud
//     retry; otherwise parse. No site may call `res.json()` raw anymore.
//   * `d1Rows` / `parseJsonText` / `extractJsonPayload` — for `wrangler`
//     CLI stdout (`d1 execute --json`): stdout can be polluted by wrangler's
//     own log/telemetry lines (the `🪵 Writing logs to …` line and the
//     trailing `Metrics dispatcher: Posting data {…"argsUsed":[…]}` line,
//     the latter containing `]` characters). Extract the JSON payload with a
//     string-aware bracket matcher instead of naive indexOf/lastIndexOf.
//   * `cliEnv()` — run one-shot CLI helpers (d1 execute/migrations) WITHOUT
//     the job-level WRANGLER_LOG=debug env, which pollutes their stdout;
//     the spawned dev server keeps it so its debug log is still captured.
//   * `wsJsonFrame` — every WS message handler parses through this: a frame
//     matching the transport signature is counted and loudly dropped (the
//     room state re-syncs; section-level retry applies); anything else that
//     is not JSON throws — a protocol defect is never silently ignored.
//
// Discipline (unchanged): counters + loud [INFRA-FLAKE-SHIELD] lines; the
// suites exit 3 when a transport-class failure survives the shield + restart,
// exit 1 on any app-class failure — transport can never masquerade as green
// and app regressions are never masked.
const LOG_PREFIX = "[INFRA-FLAKE-SHIELD]";

export const infraFlake = {
  events: 0, // total transport-class events seen
  retried: 0, // events that triggered the one-shot retry
  masked: 0, // retries that succeeded (absorbed)
  cliEvents: 0, // transport-class signatures found in wrangler CLI output
  wsEvents: 0, // transport-class non-JSON WS frames dropped
  labels: [],
};

const TRANSPORT_TEXT_RE =
  /Network connection lost|Error inside ProxyWorker|Your worker restarted mid-request|^\s*Error: Net|other side closed|ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET|UND_ERR_CONNECT|socket hang up|fetch failed/im;

/** Transport signature in a RAW TEXT payload (500 body, CLI stdout, WS frame). */
export function isTransportText(text) {
  return TRANSPORT_TEXT_RE.test(String(text ?? ""));
}

/** Transport signature in a thrown error (fetch failed / resets / server gone). */
export function isTransportClassFailure({ status, body, err } = {}) {
  if (err) {
    const text = `${err?.message ?? err} ${err?.cause?.message ?? err?.cause ?? ""}`;
    return isTransportText(text);
  }
  if (status !== 500 && status !== 503) return false;
  return isTransportText(body ?? "");
}

/** True if a thrown error is transport-class (incl. errors tagged by d1Rows). */
export function isTransportError(err) {
  if (!err) return false;
  if (err.holmesTransport) return true;
  if (isTransportClassFailure({ err })) return true;
  // also match transport text inside the message (e.g. parse-failure wrappers)
  return isTransportText(err.message ?? "");
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

/** Non-throwing JSON parse. */
export function parseJsonText(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// String-aware scan for the end of a JSON value that starts at `start`
// (either a [ … ] or { … } in the text). Returns the index of the closing
// bracket, or -1. Only the opening bracket's own type is counted — inside a
// valid JSON document the other bracket type can only appear inside strings,
// which the scanner tracks.
function matchJsonEnd(text, start) {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract the first complete JSON value from noisy text (CLI stdout etc.).
 * Candidates are every `[` or `{` surrounded by JSON-legal boundaries, tried
 * in order; `preferType` ("array"/"object") picks the first value of that
 * type before falling back to any parseable value. Returns
 * { value, start, end } or null. Never throws.
 */
export function extractJsonPayload(text, { preferType } = {}) {
  const clean = stripAnsi(text);
  const direct = parseJsonText(clean);
  if (direct.ok) {
    const t = Array.isArray(direct.value) ? "array" : typeof direct.value;
    if (!preferType || t === preferType) return { value: direct.value, start: 0, end: clean.length - 1 };
  }
  const candidates = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c !== "[" && c !== "{") continue;
    const prev = i === 0 ? "\n" : clean[i - 1];
    // Only treat as a candidate at a line start (optionally after spaces) —
    // avoids matching braces inside log-line prose like "Posting data {…".
    const lineStart = prev === "\n" || /^[ \t]*$/.test(clean.slice(clean.lastIndexOf("\n", i - 1) + 1, i));
    if (!lineStart) continue;
    candidates.push(i);
    if (candidates.length >= 50) break;
  }
  const parsed = [];
  for (const start of candidates) {
    const end = matchJsonEnd(clean, start);
    if (end === -1) continue;
    const p = parseJsonText(clean.slice(start, end + 1));
    if (p.ok) {
      const t = Array.isArray(p.value) ? "array" : typeof p.value;
      parsed.push({ value: p.value, start, end, t });
      if (preferType && t === preferType) return parsed[parsed.length - 1];
    }
  }
  return parsed[0] ?? null;
}

/**
 * Rows from a `wrangler d1 execute --json` stdout blob. Throws (with the raw
 * output attached) when no JSON payload can be extracted — loud, never silent.
 * If the output looks like the upstream transport signature, the error is
 * tagged transport so the suite can exit 3 rather than blaming the app.
 */
export function d1Rows(out, label = "wrangler d1 output") {
  const payload = extractJsonPayload(out, { preferType: "array" });
  if (!payload) {
    const snippet = stripAnsi(String(out ?? "")).slice(0, 500);
    const err = new Error(`could not extract JSON from ${label}; raw output starts: ${JSON.stringify(snippet)}`);
    if (isTransportText(out)) {
      infraFlake.events += 1;
      infraFlake.cliEvents += 1;
      err.holmesTransport = true;
      console.error(`${LOG_PREFIX} transport signature found in ${label} output — tagged transport (upstream wrangler dev defect)`);
    }
    throw err;
  }
  const parsed = payload.value;
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
}

/**
 * Env for one-shot wrangler CLI helpers (d1 execute / migrations). Strips the
 * job-level WRANGLER_LOG* so the CLI's debug lines + telemetry line
 * (`Metrics dispatcher: Posting data {…}`) never pollute parsed stdout.
 * The spawned dev server inherits the full env, keeping its debug log.
 */
export function cliEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^WRANGLER_LOG/.test(key)) delete env[key];
  }
  return env;
}

/**
 * Run `doFetch()` and, iff it fails with the upstream transport signature,
 * retry it once. `doFetch` must be re-callable (fresh Request each time).
 * Returns { res, text, err } — err set when the final attempt failed.
 */
export async function fetchWithShield(doFetch, label, log = console.error) {
  const attempt = async () => {
    try {
      const res = await doFetch();
      const text = await res.clone().text().catch(() => "");
      return { res, text };
    } catch (err) {
      return { err };
    }
  };
  let r = await attempt();
  const failed = (r.err || isTransportClassFailure({ status: r.res.status, body: r.text }));
  if (!failed) return r;

  const sig = r.err ? `fetch error: ${r.err?.cause?.message ?? r.err}` : `${r.res.status} ${r.text.slice(0, 200)}`;
  infraFlake.events += 1;
  log(`${LOG_PREFIX} upstream dev-server transport failure on ${label}: ${sig} — retrying once`);
  await new Promise((r2) => setTimeout(r2, 300));
  r = await attempt();
  infraFlake.retried += 1;
  if (r.err || isTransportClassFailure({ status: r.res.status, body: r.text })) {
    log(`${LOG_PREFIX} retry ALSO failed on ${label} — surfacing failure`);
    infraFlake.labels.push(`${label} (retry failed)`);
  } else {
    infraFlake.masked += 1;
    infraFlake.labels.push(label);
    log(`${LOG_PREFIX} retry succeeded on ${label} — one dev-server transport drop absorbed (upstream wrangler dev bug, not an app failure)`);
  }
  return r;
}

/**
 * THE text-first helper for fetch + JSON.parse sites:
 *   fetch → read body as TEXT → transport signature? (retry once, loud) →
 *   otherwise parse. Returns { res?, text, json?, parsed, err?, transport }.
 * `json` is only present when the body parsed. A transport-class body that
 * survives the retry is returned with `transport: true` and `parsed: false`
 * — callers handle it (restart-resume, or fail loudly as infra, exit 3).
 */
export async function fetchJsonWithShield(doFetch, label, log = console.error) {
  const attempt = await fetchWithShield(doFetch, label, log);
  if (attempt.err) {
    return { err: attempt.err, text: "", parsed: false, transport: isTransportClassFailure({ err: attempt.err }) };
  }
  const { res, text } = attempt;
  const p = parseJsonText(text);
  return {
    res,
    text,
    json: p.ok ? p.value : undefined,
    parsed: p.ok,
    transport: isTransportClassFailure({ status: res.status, body: text }),
  };
}

/**
 * Every WS message handler parses through this. A frame matching the
 * transport signature is counted and loudly dropped (returns null); any
 * other non-JSON frame throws — protocol defects are never swallowed.
 */
export function wsJsonFrame(data, label, log = console.error) {
  const text = typeof data === "string" ? data : String(data ?? "");
  const p = parseJsonText(text);
  if (p.ok) return p.value;
  if (isTransportText(text)) {
    infraFlake.events += 1;
    infraFlake.wsEvents += 1;
    log(`${LOG_PREFIX} transport-class non-JSON WS frame on ${label} — dropped + counted (room state re-syncs; not silent): ${JSON.stringify(text.slice(0, 300))}`);
    return null;
  }
  throw new Error(`non-JSON WS frame on ${label} (protocol defect, not the known transport class): ${JSON.stringify(text.slice(0, 300))}`);
}

export function printInfraFlakeSummary() {
  if (infraFlake.events === 0) return;
  console.error(
    `${LOG_PREFIX} SUMMARY: ${infraFlake.events} transport-class event(s) [http/ws/cli: ${infraFlake.events - infraFlake.cliEvents - infraFlake.wsEvents}/${infraFlake.wsEvents}/${infraFlake.cliEvents}], ` +
      `${infraFlake.retried} retried, ${infraFlake.masked} masked` +
      (infraFlake.labels.length ? ` (${infraFlake.labels.join(", ")})` : "") +
      " — see cloudflare/workers-sdk #15203/#15452 (fix PR #15252, wrangler >=4.129.1)",
  );
}
