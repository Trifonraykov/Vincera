import "server-only"

import Stripe from "stripe"

import { env, isFake } from "@/lib/env"

/**
 * Stripe client (§7.2). Checkout, Connect, transfers and webhooks are built in later phases
 * (`checkout.ts`, `connect.ts`, `transfers.ts`, `webhooks.ts` next to this file).
 *
 * In fake mode (§19.3) there is no Stripe client: those modules branch on `isStripeFake()` and
 * run their fake checkout / onboarding / transfer flows instead.
 */

/**
 * Pinned API version: the default of the installed SDK. The literal type comes from the SDK, so
 * upgrading `stripe` to a release with a newer version fails typecheck until this line is bumped
 * deliberately (and the account's webhook endpoint version is checked).
 */
export const STRIPE_API_VERSION = "2026-09-30.endive" satisfies Stripe.StripeConfig["apiVersion"]

export function isStripeFake(): boolean {
  return isFake("stripe")
}

let stripe: Stripe | undefined

/** The live Stripe client. Throws when Stripe is fake; check `isStripeFake()` first. */
export function getStripe(): Stripe {
  if (isStripeFake()) {
    throw new Error("Stripe is running as a fake (§19.3); use the fake flow instead of getStripe()")
  }
  const key = env.STRIPE_SECRET_KEY
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured")
  stripe ??= new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    maxNetworkRetries: 2,
    appInfo: { name: env.APP_NAME },
  })
  return stripe
}
