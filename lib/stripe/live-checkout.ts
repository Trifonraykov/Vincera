import "server-only"

import Stripe from "stripe"

import {
  checkoutSessionParams,
  stripeChargeSchema,
  stripeCheckoutSessionSchema,
  stripePaymentIntentSchema,
} from "./checkout-shared"
import type { CheckoutGateway } from "./gateway"
import { StripeGatewayError } from "./shared"

/**
 * Live checkout (Phase 4, CLAUDE.md §19.31, §19.34): Checkout Sessions with
 * `checkoutSessionParams` (one tax-inclusive line, Stripe Tax, metadata on the session and the
 * PaymentIntent), and the PaymentIntent / charge reads the fulfilment needs for the Stripe fee
 * (`latest_charge.balance_transaction` expanded). Every response is parsed with the schemas in
 * `./checkout-shared.ts`. `resource_missing` becomes `StripeGatewayError`; an invalid request
 * (e.g. an inactive promotion code) becomes `invalid_request`; network, auth and rate-limit
 * errors pass through unchanged.
 */
export function createLiveCheckoutGateway(stripe: Stripe): CheckoutGateway {
  return {
    async createCheckoutSession(input, { idempotencyKey }) {
      return mapErrors(async () =>
        stripeCheckoutSessionSchema.parse(
          await stripe.checkout.sessions.create(checkoutSessionParams(input), { idempotencyKey }),
        ),
      )
    },

    async retrieveCheckoutSession(sessionId) {
      return mapErrors(async () =>
        stripeCheckoutSessionSchema.parse(await stripe.checkout.sessions.retrieve(sessionId)),
      )
    },

    async retrievePaymentIntentWithBalanceTransaction(paymentIntentId) {
      return mapErrors(async () =>
        stripePaymentIntentSchema.parse(
          await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ["latest_charge.balance_transaction"],
          }),
        ),
      )
    },

    async retrieveCharge(chargeId) {
      return mapErrors(async () =>
        stripeChargeSchema.parse(
          await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] }),
        ),
      )
    },
  }
}

async function mapErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      if (error.code === "resource_missing") {
        throw new StripeGatewayError("resource_missing", error.message)
      }
      if (error.type === "StripeInvalidRequestError") {
        throw new StripeGatewayError("invalid_request", error.message)
      }
    }
    throw error
  }
}
