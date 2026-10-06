import "server-only"

import type { DbOrTx } from "@/lib/db/client"
import type { JsonObject } from "@/lib/db/schema"
import { newId } from "@/lib/ids"
import { CHECKOUT_SESSION_TTL_SECONDS, DEFAULT_TAX_CODES } from "@/lib/stripe/checkout-shared"
import { createFakeEvent, unixSeconds, type FakeStripeStore } from "@/lib/stripe/fake"
import {
  completeFakeCheckoutSession,
  settleFakeChargeFee,
  settleFakeDelayedPayment,
  type FakePaymentMethod,
} from "@/lib/stripe/fake-checkout"
import type { CheckoutGateway } from "@/lib/stripe/gateway"
import { stripeEventSchema } from "@/lib/stripe/schemas"
import { processStripeEvent } from "@/lib/stripe/webhooks"
import type Stripe from "stripe"

/**
 * A whole fake purchase without a browser (CLAUDE.md §19.34): create the Checkout Session through
 * the gateway, pay it as the fake page would, and hand each Stripe event to `deliver`. Used by the
 * seed (`lib/seed/orders.ts`) and the integration tests, with `deliverDirectly(db)` running the
 * real webhook processing (`processStripeEvent`: the `stripe_events` record, the handlers, the
 * after-commit jobs) without HTTP. The fake page itself delivers over HTTP (lib/checkout/fake-page.ts).
 */

export type FakeEventDelivery = (event: JsonObject) => Promise<void>

/** Process a fake event in this process, exactly as the webhook route would. */
export function deliverDirectly(database: DbOrTx): FakeEventDelivery {
  return async (event) => {
    await processStripeEvent(database, stripeEventSchema.parse(event), event)
  }
}

export type FakePurchaseInput = {
  launch: {
    id: string
    slug: string
    title: string
    priceCents: number
    currency: string
    deliveryType: keyof typeof DEFAULT_TAX_CODES
  }
  appUrl: string
  email: string
  country?: string
  method?: FakePaymentMethod
  trackedLinkId?: string | null
  attribution?: "cookie" | "ref" | null
  promotionCodeId?: string | null
  /** A code typed on the fake page. */
  promotionCode?: string | null
}

export type FakePurchaseResult = {
  orderRef: string
  sessionId: string
  chargeId: string | null
  paymentIntentId: string | null
  /** The events delivered, in order. */
  events: JsonObject[]
}

export async function fakePurchase(
  store: FakeStripeStore,
  gateway: CheckoutGateway,
  input: FakePurchaseInput,
  deliver: FakeEventDelivery,
): Promise<FakePurchaseResult> {
  const orderRef = newId()
  const session = await gateway.createCheckoutSession(
    {
      orderRef,
      launchId: input.launch.id,
      trackedLinkId: input.trackedLinkId ?? null,
      attribution: input.trackedLinkId ? (input.attribution ?? "ref") : null,
      productName: input.launch.title,
      priceCents: input.launch.priceCents,
      currency: input.launch.currency,
      taxCode: DEFAULT_TAX_CODES[input.launch.deliveryType],
      successUrl: `${input.appUrl}/p/${input.launch.slug}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${input.appUrl}/p/${input.launch.slug}`,
      expiresAt: unixSeconds() + CHECKOUT_SESSION_TTL_SECONDS,
      promotionCodeId: input.promotionCodeId ?? null,
    },
    { idempotencyKey: `checkout:${orderRef}` },
  )
  const method = input.method ?? "card"
  const paid = await completeFakeCheckoutSession(store, session.id, {
    method,
    email: input.email,
    country: input.country ?? "ES",
    promotionCode: input.promotionCode ?? null,
  })
  if (!paid.ok) throw new Error(`Fake purchase failed: ${paid.reason}`)

  const events: JsonObject[] = []
  const send = async (type: Stripe.Event.Type, object: JsonObject) => {
    const event = await createFakeEvent(store, type, object)
    events.push(event)
    await deliver(event)
  }
  await send("checkout.session.completed", paid.session)
  if (method === "card_fee_pending" && paid.chargeId) {
    await send("charge.updated", await settleFakeChargeFee(store, paid.chargeId))
  }
  if (method === "delayed" || method === "delayed_fail") {
    const outcome = method === "delayed" ? "succeeded" : "failed"
    await send(
      outcome === "succeeded"
        ? "checkout.session.async_payment_succeeded"
        : "checkout.session.async_payment_failed",
      await settleFakeDelayedPayment(store, session.id, outcome),
    )
  }
  return {
    orderRef,
    sessionId: session.id,
    chargeId: paid.chargeId,
    paymentIntentId: paid.paymentIntentId,
    events,
  }
}
