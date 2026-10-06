import "server-only"

import { eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { launches } from "@/lib/db/schema"
import { checkoutMetadataSchema } from "@/lib/stripe/checkout-shared"
import type { CheckoutGateway } from "@/lib/stripe/gateway"
import { getStripeGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"

/**
 * A refund or dispute event for a payment of ours whose order is not recorded yet (CLAUDE.md
 * §19.37): `checkout.session.completed` failed or has not arrived. Thrown inside the webhook
 * transaction, so the event fails (500) and Stripe retries it until fulfilment has created the
 * order; acknowledging it would lose the refund or dispute for good (the order would then be
 * fulfilled as fully paid).
 */
export class OrderNotRecordedYetError extends Error {
  constructor(what: string) {
    super(`${what}: the payment is ours but its order is not recorded yet; retry later`)
    this.name = "OrderNotRecordedYetError"
  }
}

export type PaymentRefs = { chargeId: string | null; paymentIntentId: string | null }

/**
 * Whether a charge / PaymentIntent was made by our checkout: its PaymentIntent carries our
 * checkout metadata (§19.31 metadata on `payment_intent_data`) naming a launch in this database.
 * A payment of another integration on the same Stripe account, or of another environment sharing
 * test mode, is not ours (its launch is unknown here) and is acknowledged as before.
 */
export async function isOurCheckoutPayment(
  db: DbOrTx,
  refs: PaymentRefs,
  gateway: Pick<
    CheckoutGateway,
    "retrieveCharge" | "retrievePaymentIntentWithBalanceTransaction"
  > = getStripeGateway(),
): Promise<boolean> {
  try {
    let paymentIntentId = refs.paymentIntentId
    let metadata: unknown = null
    if (!paymentIntentId && refs.chargeId) {
      const charge = await gateway.retrieveCharge(refs.chargeId)
      metadata = charge.metadata ?? null
      const pi = charge.payment_intent
      paymentIntentId = typeof pi === "string" ? pi : (pi?.id ?? null)
    }
    if (!checkoutMetadataSchema.safeParse(metadata).success && paymentIntentId) {
      const intent = await gateway.retrievePaymentIntentWithBalanceTransaction(paymentIntentId)
      metadata = intent.metadata ?? null
    }
    const parsed = checkoutMetadataSchema.safeParse(metadata)
    if (!parsed.success) return false
    const [launch] = await db
      .select({ id: launches.id })
      .from(launches)
      .where(eq(launches.id, parsed.data.launch_id))
    return launch !== undefined
  } catch (error) {
    if (error instanceof StripeGatewayError && error.code === "resource_missing") return false
    throw error
  }
}
