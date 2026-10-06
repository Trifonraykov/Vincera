import "server-only"

import { eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { launches } from "@/lib/db/schema"
import { accessPath } from "@/lib/delivery/token"
import { reportError } from "@/lib/observability"
import { findOrderBySession, orderReference } from "@/lib/orders/queries"
import type { CheckoutGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"

import { isFulfillable } from "@/lib/orders/license-keys"

/**
 * What `/p/<slug>/success?session_id=…` shows (§12; CLAUDE.md §19.31 "Access", §19.34). Stripe
 * sends the buyer's own browser here right after paying, so the page may show that order's access
 * link; it never shows anything about other orders.
 *
 * - `paid`: the order exists (the webhook landed): "check your email" plus the access link while
 *   the grant works;
 * - `finishing`: Stripe says paid but the webhook has not landed yet (the page refreshes itself);
 * - `processing`: a delayed method (e.g. SEPA debit) is still settling: we email when it clears;
 * - `failed`: the delayed payment failed; `unpaid`: the checkout was left open; `expired`;
 * - `not_found`: a malformed id, an unknown session, or a session of another product.
 *
 * Stripe is only asked when no order exists for the session yet, and at most
 * `SUCCESS_STRIPE_LOOKUPS` times per minute per IP (the page is public; CLAUDE.md §19.37).
 */

/** Stripe reads by the success page, per client IP (bucket `checkout-success`). */
export const SUCCESS_STRIPE_LOOKUPS = { limit: 30, window: "1 m" } as const

export type SuccessState =
  | {
      kind: "paid"
      launchTitle: string
      reference: string
      accessHref: string | null
      refunded: boolean
    }
  | { kind: "finishing" | "processing" | "failed" | "expired"; launchTitle: string }
  | { kind: "unpaid"; launchTitle: string; resumeUrl: string | null }
  | { kind: "not_found" }

const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,250}$/

export async function loadSuccessState(
  database: DbOrTx,
  gateway: Pick<
    CheckoutGateway,
    "retrieveCheckoutSession" | "retrievePaymentIntentWithBalanceTransaction"
  >,
  input: { slug: string; sessionId: string | null | undefined },
  options: {
    /**
     * Asked before any Stripe read (the page is public: CLAUDE.md §19.37). False = over the
     * per-IP limit: no Stripe call, the page shows `finishing` and refreshes. Default: allowed.
     */
    allowStripeLookup?: () => Promise<boolean>
  } = {},
): Promise<SuccessState> {
  const sessionId = input.sessionId
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return { kind: "not_found" }
  const [launch] = await database
    .select({ id: launches.id, title: launches.title })
    .from(launches)
    .where(eq(launches.slug, input.slug))
  if (!launch) return { kind: "not_found" }

  const order = await findOrderBySession(database, sessionId)
  if (order) {
    if (order.launchId !== launch.id) return { kind: "not_found" }
    return {
      kind: "paid",
      launchTitle: order.launchTitle,
      reference: orderReference(order.id),
      accessHref: order.accessToken ? accessPath(order.accessToken) : null,
      refunded: order.status === "refunded",
    }
  }

  // Only ids that look like a real session and name a real launch get this far; still, every
  // Stripe read costs the platform's API budget, so they are rate-limited per IP.
  if (options.allowStripeLookup && !(await options.allowStripeLookup())) {
    return { kind: "finishing", launchTitle: launch.title }
  }

  let session
  try {
    session = await gateway.retrieveCheckoutSession(sessionId)
  } catch (error) {
    if (error instanceof StripeGatewayError && error.code === "resource_missing") {
      return { kind: "not_found" }
    }
    reportError(error, { tags: { area: "checkout", page: "success" } })
    // Stripe is unreachable: assume the usual case (paid, webhook on its way) and keep refreshing.
    return { kind: "finishing", launchTitle: launch.title }
  }
  if (session.metadata?.launch_id !== launch.id) return { kind: "not_found" }

  if (session.status === "expired") return { kind: "expired", launchTitle: launch.title }
  if (session.status === "open") {
    return { kind: "unpaid", launchTitle: launch.title, resumeUrl: session.url ?? null }
  }
  if (isFulfillable(session.payment_status)) return { kind: "finishing", launchTitle: launch.title }

  // Completed but unpaid: a delayed method. A failed one leaves the PaymentIntent needing a method.
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id
  if (paymentIntentId) {
    try {
      const paymentIntent =
        await gateway.retrievePaymentIntentWithBalanceTransaction(paymentIntentId)
      if (
        paymentIntent.status === "requires_payment_method" ||
        paymentIntent.status === "canceled"
      ) {
        return { kind: "failed", launchTitle: launch.title }
      }
    } catch (error) {
      reportError(error, { tags: { area: "checkout", page: "success" } })
    }
  }
  return { kind: "processing", launchTitle: launch.title }
}
