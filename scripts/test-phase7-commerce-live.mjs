#!/usr/bin/env node
// Real Phase 7 commerce test against the LIVE Stripe test-mode API.
// Could not run in the cloud sandbox — api.stripe.com was network-blocked
// there regardless of the valid key on hand (docs/capability-gaps.md,
// 2026-07-27). Runs against local wrangler dev (--local — no billed
// Cloudflare resources touched, same as every other phase test) so only
// the D1/R2/Queue bindings are emulated; the Stripe calls this test
// exercises go straight to the real api.stripe.com over this machine's
// normal network access.
import { spawn, execFileSync } from "node:child_process";
import Stripe from "stripe";

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error("FAIL: STRIPE_SECRET_KEY not set in the environment. Source .dev.vars first.");
    process.exit(1);
  }
  if (secretKey.startsWith("sk_live_")) {
    console.error("REFUSING to run: this is a LIVE Stripe key, not a test-mode key. This script creates real checkout sessions and would hit real Stripe.");
    process.exit(1);
  }

  console.log(`Starting wrangler dev on port ${PORT} (--local — D1/R2/Queue emulated, no billed Cloudflare resources)...`);
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env },
  });
  wrangler.stdout.on("data", () => {});
  wrangler.stderr.on("data", () => {});

  let exitCode = 1;

  try {
    const up = await waitForServer(30_000);
    if (!up) throw new Error("wrangler dev did not become healthy in time");
    console.log("Server up.\n");

    console.log("1. Create a local test org...");
    const { res: orgRes, json: orgJson } = await postJson("/org", { name: "Phase 7 Live Test Org", type: "church" });
    if (!orgRes.ok) throw new Error(`FAIL: org creation failed: ${JSON.stringify(orgJson)}`);
    const orgId = orgJson.id;
    console.log(`PASS: org created (${orgId}).\n`);

    console.log("2. Create a real Stripe Checkout Session (under_250k / monthly) against the live test-mode API...");
    const { res: checkoutRes, json: checkoutJson } = await postJson(`/org/${orgId}/checkout-session`, {
      band: "under_250k",
      cycle: "monthly",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    if (!checkoutRes.ok) throw new Error(`FAIL: checkout session creation failed: ${JSON.stringify(checkoutJson)}`);
    if (!checkoutJson.checkoutUrl?.startsWith("https://checkout.stripe.com/")) {
      throw new Error(`FAIL: checkoutUrl doesn't look like a real Stripe-hosted checkout URL: ${checkoutJson.checkoutUrl}`);
    }
    if (!checkoutJson.sessionId?.startsWith("cs_test_")) {
      throw new Error(`FAIL: sessionId doesn't look like a real Stripe test-mode session id: ${checkoutJson.sessionId}`);
    }
    console.log(`PASS: real Stripe checkout session created — ${checkoutJson.sessionId}`);
    console.log(`      ${checkoutJson.checkoutUrl}\n`);

    console.log("3. Create a real Stripe customer directly (proves the key can write, not just read)...");
    const stripe = new Stripe(secretKey, { apiVersion: "2026-06-24.dahlia" });
    const customer = await stripe.customers.create({ name: "Phase 7 Live Test Org", metadata: { org_id: orgId } });
    console.log(`PASS: real Stripe customer created — ${customer.id}\n`);

    console.log("4. Attach that customer to the local org row (simulating what the webhook handler does on checkout.session.completed)...");
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "groundwork", "--local", "--command",
        `UPDATE organization SET stripe_customer_id = '${customer.id}' WHERE id = '${orgId}';`],
      { stdio: "pipe" },
    );
    console.log("PASS: local org row updated.\n");

    console.log("5. Create a real Stripe Billing Portal session for that customer...");
    const { res: portalRes, json: portalJson } = await postJson(`/org/${orgId}/billing-portal`, {
      returnUrl: "https://example.com/account",
    });
    if (!portalRes.ok) throw new Error(`FAIL: billing portal session creation failed: ${JSON.stringify(portalJson)}`);
    if (!portalJson.portalUrl?.startsWith("https://billing.stripe.com/")) {
      throw new Error(`FAIL: portalUrl doesn't look like a real Stripe-hosted billing portal URL: ${portalJson.portalUrl}`);
    }
    console.log(`PASS: real Stripe billing portal session created.`);
    console.log(`      ${portalJson.portalUrl}\n`);

    console.log("6. Clean up the real Stripe customer created for this test...");
    await stripe.customers.del(customer.id);
    console.log(`PASS: test customer ${customer.id} deleted from Stripe test-mode account.\n`);

    console.log("=== PHASE 7 COMMERCE GATE (live Stripe test-mode API): PASS ===");
    console.log("Real checkout session, real customer, real billing portal session — all against the actual api.stripe.com, not emulated.");
    console.log("Still not covered by this test: a human completing checkout in a real browser, and the webhook firing from Stripe's side (needs a public URL or `stripe listen` — not attempted here).");
    exitCode = 0;
  } catch (err) {
    console.error("TEST FAILED:", err.message ?? err);
    exitCode = 1;
  } finally {
    if (wrangler.pid) {
      try {
        process.kill(-wrangler.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    await sleep(200);
  }

  process.exit(exitCode);
}

main();
