import "server-only"

import { applyStripeDispute } from "@/lib/chargebacks/apply"

import { stripeDisputeSchema } from "../money-shared"
import { on, type StripeHandlerGroup } from "./define"

/**
 * Disputes webhook handlers (§9 "Disputes (chargebacks)"; CLAUDE.md §19.31, §19.35; owner:
 * payouts). Every `charge.dispute.*` event goes through `applyStripeDispute`
 * (lib/chargebacks/apply.ts), idempotent on the dispute id: the first one seen opens the
 * chargeback (order `disputed`, notices), `closed` with `won` / `lost` settles it. The
 * `funds_withdrawn` / `funds_reinstated` events only refresh Stripe's status: the ledger books a
 * chargeback when it is lost, not when Stripe moves the funds.
 */
const onDispute = on(stripeDisputeSchema, async (event, { tx, now, afterCommit }) => {
  await applyStripeDispute(tx, event.data.object, { now, afterCommit })
})

export const disputesHandlers = {
  "charge.dispute.created": onDispute,
  "charge.dispute.updated": onDispute,
  "charge.dispute.closed": onDispute,
  "charge.dispute.funds_withdrawn": onDispute,
  "charge.dispute.funds_reinstated": onDispute,
} satisfies StripeHandlerGroup
