// [INFRA-FLAKE-SHIELD] — test-harness-only guard against a KNOWN upstream
// wrangler dev defect, NOT an app-level retry.
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
// Upstream: cloudflare/workers-sdk #15203, #15452, #15317, #14641.
//
// App code must NEVER retry on these. This helper lives only in the test
// harness, fires LOUDLY (it is not silent masking), retries at most ONCE,
// and matches ONLY the exact upstream signature — a genuine app regression
// (any other 5xx, any app error body) is untouched.
const TRANSPORT_BODY_MARKERS = [
  /Network connection lost/i,
  /Error inside ProxyWorker/i,
  /Your worker restarted mid-request/i, // proxy 503 for non-GET after a worker restart
];

export const infraFlake = { events: 0, retried: 0, masked: 0, labels: [] };

export function isTransportClassFailure({ status, body, err } = {}) {
  if (err) {
    const text = `${err?.message ?? err} ${err?.cause?.message ?? err?.cause ?? ""}`;
    // ECONNREFUSED = the dev server exited (the fatal variant of the same
    // upstream defect); the others are socket-level drops.
    return /other side closed|ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET|UND_ERR_CONNECT|socket hang up|Network connection lost|fetch failed/i.test(text);
  }
  if (status !== 500 && status !== 503) return false;
  return TRANSPORT_BODY_MARKERS.some((re) => re.test(body ?? ""));
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
  log(`[INFRA-FLAKE-SHIELD] upstream dev-server transport failure on ${label}: ${sig} — retrying once`);
  await new Promise((r2) => setTimeout(r2, 300));
  r = await attempt();
  infraFlake.retried += 1;
  if (r.err || isTransportClassFailure({ status: r.res.status, body: r.text })) {
    log(`[INFRA-FLAKE-SHIELD] retry ALSO failed on ${label} — surfacing failure`);
  } else {
    infraFlake.masked += 1;
    infraFlake.labels.push(label);
    log(`[INFRA-FLAKE-SHIELD] retry succeeded on ${label} — one dev-server transport drop absorbed (upstream wrangler dev bug, not an app failure)`);
  }
  return r;
}

export function printInfraFlakeSummary() {
  if (infraFlake.events === 0) return;
  console.error(
    `[INFRA-FLAKE-SHIELD] SUMMARY: ${infraFlake.events} transport-class event(s), ${infraFlake.retried} retried, ${infraFlake.masked} masked` +
      (infraFlake.labels.length ? ` (${infraFlake.labels.join(", ")})` : "") +
      " — see cloudflare/workers-sdk #15203/#15452/#15317",
  );
}
