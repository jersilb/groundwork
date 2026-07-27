#!/usr/bin/env node --experimental-strip-types
// Real test of Stripe webhook signature verification — pure cryptographic
// verification, no network call, so this genuinely works even though
// api.stripe.com itself is network-blocked from this sandbox
// (docs/capability-gaps.md, 2026-07-27). This is the one piece of the
// commerce integration that's actually fully verifiable here: a forged or
// tampered webhook payload must be rejected regardless of what the
// attacker claims the signature header says.
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createStripeClient } from "../src/commerce/stripe-client.ts";
import { verifyStripeWebhook } from "../src/commerce/routes.ts";

const WEBHOOK_SECRET = "whsec_test_fixture_secret_not_real";
const stripe = createStripeClient("sk_test_fixture_not_real");

let passed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const payload = JSON.stringify({
  id: "evt_test_fixture",
  type: "checkout.session.completed",
  data: { object: { id: "cs_test_fixture", customer: "cus_test_fixture", metadata: { org_id: "org_123", budget_band: "under_250k" } } },
});

check("accepts a genuinely valid signature", () => {
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const event = verifyStripeWebhook(stripe, payload, header, WEBHOOK_SECRET);
  assert.equal(event.type, "checkout.session.completed");
});

check("REJECTS a tampered payload even with a syntactically valid-looking signature header", () => {
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const tamperedPayload = payload.replace("org_123", "org_999"); // attacker tries to redirect the subscription to a different org
  assert.throws(() => verifyStripeWebhook(stripe, tamperedPayload, header, WEBHOOK_SECRET), Stripe.errors.StripeSignatureVerificationError);
});

check("REJECTS a signature generated with the wrong webhook secret", () => {
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong_secret" });
  assert.throws(() => verifyStripeWebhook(stripe, payload, header, WEBHOOK_SECRET), Stripe.errors.StripeSignatureVerificationError);
});

check("REJECTS a missing/malformed signature header", () => {
  assert.throws(() => verifyStripeWebhook(stripe, payload, "not-a-real-signature-header", WEBHOOK_SECRET), Stripe.errors.StripeSignatureVerificationError);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("STRIPE WEBHOOK VERIFICATION TESTS FAILED");
} else {
  console.log("ALL STRIPE WEBHOOK VERIFICATION TESTS PASSED");
}
