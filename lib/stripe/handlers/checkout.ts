import "server-only"

import { fulfilCheckoutSession, postLedgerForCharge } from "@/lib/orders/fulfil"

import { stripeChargeSchema, stripeCheckoutSessionSchema } from "../checkout-shared"
import { getStripeGateway } from "../gateway"

import { eventTime, on, type StripeHandlerGroup } from "./define"

/**
 * Checkout webhook handlers (§7.2, §9, §19.10; CLAUDE.md §19.31, §19.34):
 *
 * - `checkout.session.completed`: fulfil when `payment_status` is `paid` (or nothing was due); a
 *   delayed method completes `unpaid` and is fulfilled by `async_payment_succeeded` instead.
 * - `checkout.session.async_payment_succeeded`: fulfil.
 * - `checkout.session.async_payment_failed` / `checkout.session.expired`: nothing is recorded (no
 *   order exists; the buyer was never charged). Handled so they are acknowledged as processed.
 * - `charge.updated`: post the ledger once the charge's balance transaction exists.
 *
 * Everything is written with the event's transaction (lib/orders/fulfil.ts); the receipt and sale
 * emails are enqueued after the commit. Replays and duplicates are no-ops.
 */
export const checkoutHandlers = {
  "checkout.session.completed": on(
    stripeCheckoutSessionSchema,
    async (event, { tx, afterCommit }) => {
      await fulfilCheckoutSession(tx, event.data.object, {
        gateway: getStripeGateway(),
        eventTime: eventTime(event),
        afterCommit,
      })
    },
  ),

  "checkout.session.async_payment_succeeded": on(
    stripeCheckoutSessionSchema,
    async (event, { tx, afterCommit }) => {
      await fulfilCheckoutSession(tx, event.data.object, {
        gateway: getStripeGateway(),
        eventTime: eventTime(event),
        afterCommit,
      })
    },
  ),

  "checkout.session.async_payment_failed": on(stripeCheckoutSessionSchema, async () => {
    // The delayed payment failed: no order was created, nothing to undo.
  }),

  "checkout.session.expired": on(stripeCheckoutSessionSchema, async () => {
    // The buyer never paid: nothing was recorded for the session.
  }),

  "charge.updated": on(stripeChargeSchema, async (event, { tx }) => {
    await postLedgerForCharge(tx, event.data.object, { gateway: getStripeGateway() })
  }),
} satisfies StripeHandlerGroup
