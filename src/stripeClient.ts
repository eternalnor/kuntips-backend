// stripeClient.ts
// Shared Stripe client factory used by stripe.ts, stripewebhooks.ts, and payouts/payoutStripe.ts
import Stripe from "stripe";
import type { Env } from "./env";

export function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
  });
}
