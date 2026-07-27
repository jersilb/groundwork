import type Stripe from "stripe";
import type { Env } from "../index.ts";
import { createStripeClient } from "./stripe-client.ts";
import { computePriceUsd, type BillingCycle, type BudgetBand } from "./pricing.ts";

// Commerce routes — build plan §7 Phase 7 / §9 economics. Untestable
// against the real Stripe API from this sandbox (docs/capability-gaps.md,
// 2026-07-27 — api.stripe.com is network-blocked here regardless of the
// key Jeremy supplied). Webhook signature verification IS tested for
// real, since it's pure cryptographic verification with no network call
// — see scripts/test-stripe-webhook-verification.ts.

interface OrgRow {
  id: string;
  name: string;
  stripe_customer_id: string | null;
}

async function getOrg(env: Env, orgId: string): Promise<OrgRow | null> {
  const row = await env.DB.prepare(`SELECT id, name, stripe_customer_id FROM organization WHERE id = ?1`)
    .bind(orgId)
    .first<OrgRow>();
  return row ?? null;
}

interface CreateCheckoutBody {
  band: BudgetBand;
  cycle: BillingCycle;
  successUrl: string;
  cancelUrl: string;
}

async function handleCreateCheckout(request: Request, env: Env, orgId: string): Promise<Response> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return Response.json({ error: "STRIPE_SECRET_KEY not configured" }, { status: 503 });

  const org = await getOrg(env, orgId);
  if (!org) return Response.json({ error: "org not found" }, { status: 404 });

  const body = (await request.json()) as CreateCheckoutBody;
  const priceUsd = computePriceUsd(body.band, body.cycle, false);
  if (priceUsd === null) {
    return Response.json({ error: "this budget band requires a manual quote — Tier 3, Jeremy handles directly" }, { status: 422 });
  }

  const stripe = createStripeClient(secretKey);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: org.stripe_customer_id ?? undefined,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(priceUsd * 100),
          recurring: { interval: body.cycle === "annual" ? "year" : "month" },
          product_data: { name: `Groundwork — ${body.band} (${body.cycle})` },
        },
        quantity: 1,
      },
    ],
    // Value-based trial (§9): covers setup + first two Lab 1 segments, not
    // a time window. Enforced by TRIAL_SEGMENT_LIMIT against real program
    // progress elsewhere, not by Stripe's trial_period_days here.
    success_url: body.successUrl,
    cancel_url: body.cancelUrl,
    metadata: { org_id: orgId, budget_band: body.band },
  });

  return Response.json({ checkoutUrl: session.url, sessionId: session.id });
}

async function handleBillingPortal(request: Request, env: Env, orgId: string): Promise<Response> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return Response.json({ error: "STRIPE_SECRET_KEY not configured" }, { status: 503 });

  const org = await getOrg(env, orgId);
  if (!org?.stripe_customer_id) {
    return Response.json({ error: "org has no Stripe customer yet — complete checkout first" }, { status: 409 });
  }

  const body = (await request.json()) as { returnUrl: string };
  const stripe = createStripeClient(secretKey);
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: body.returnUrl,
  });

  return Response.json({ portalUrl: portalSession.url });
}

/** Pure verification, no network call — testable without live Stripe
 * access. Rejects a tampered payload even if the signature header claims
 * to be valid, because constructEvent recomputes the HMAC itself. */
export function verifyStripeWebhook(stripe: Stripe, payload: string, signature: string, webhookSecret: string): Stripe.Event {
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return Response.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "missing stripe-signature header" }, { status: 400 });

  const payload = await request.text();
  const stripe = createStripeClient(secretKey);

  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(stripe, payload, signature, webhookSecret);
  } catch (err) {
    return Response.json({ error: "signature verification failed", message: String(err) }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orgId = session.metadata?.org_id;
    const band = session.metadata?.budget_band;
    if (orgId) {
      await env.DB.prepare(
        `UPDATE organization SET stripe_customer_id = ?1, subscription_tier = ?2 WHERE id = ?3`,
      )
        .bind(session.customer as string, band ?? null, orgId)
        .run();
    }
  }

  return Response.json({ received: true });
}

const CHECKOUT_ROUTE = /^\/org\/([A-Za-z0-9_-]+)\/checkout-session$/;
const PORTAL_ROUTE = /^\/org\/([A-Za-z0-9_-]+)\/billing-portal$/;

export async function handleCommerceRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
    return handleWebhook(request, env);
  }

  const checkoutMatch = url.pathname.match(CHECKOUT_ROUTE);
  if (checkoutMatch && request.method === "POST") {
    return handleCreateCheckout(request, env, checkoutMatch[1]);
  }

  const portalMatch = url.pathname.match(PORTAL_ROUTE);
  if (portalMatch && request.method === "POST") {
    return handleBillingPortal(request, env, portalMatch[1]);
  }

  return null;
}
