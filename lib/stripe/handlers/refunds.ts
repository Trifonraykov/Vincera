import "server-only"

import { z } from "zod"

import { applyStripeRefund } from "@/lib/refunds/apply"

import { stripeChargeSchema } from "../checkout-shared"
import { stripeRefundSchema } from "../money-shared"
import { on, type StripeHandlerGroup } from "./define"

/**
 * Refunds webhook handlers (§9 "Refunds"; CLAUDE.md §19.31, §19.35; owner: payouts). Every refund
 * event goes through `applyStripeRefund` (lib/refunds/apply.ts), idempotent on the refund id:
 * `refund.created`, `refund.updated` and `refund.failed` carry the refund itself;
 * `charge.refunded` carries the charge, and its `refunds` list when Stripe includes it (it is no
 * longer expanded by default: without it the refund events do the work and this one changes
 * nothing).
 */

const chargeWithRefundsSchema = stripeChargeSchema.extend({
  refunds: z.object({ data: z.array(stripeRefundSchema) }).nullish(),
})

const onRefund = on(stripeRefundSchema, async (event, { tx, now, afterCommit }) => {
  await applyStripeRefund(tx, event.data.object, { now, afterCommit })
})

export const refundsHandlers = {
  "refund.created": onRefund,
  "refund.updated": onRefund,
  "refund.failed": onRefund,
  "charge.refunded": on(chargeWithRefundsSchema, async (event, { tx, now, afterCommit }) => {
    const charge = event.data.object
    for (const refund of charge.refunds?.data ?? []) {
      // A listed refund may omit its charge; it is this one.
      await applyStripeRefund(
        tx,
        { ...refund, charge: refund.charge ?? charge.id },
        {
          now,
          afterCommit,
        },
      )
    }
  }),
} satisfies StripeHandlerGroup
