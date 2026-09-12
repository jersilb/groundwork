import Stripe from "stripe";

// Workers-compatible Stripe client — the Node SDK's default HTTP client
// uses Node's `https` module, which doesn't exist in the Workers runtime.
// Stripe's documented fix is its fetch-based HTTP client.
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: "2026-07-29.dahlia",
  });
}
