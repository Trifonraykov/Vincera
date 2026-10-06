import { getDb } from "@/lib/db/client"
import { runReversals } from "@/lib/payouts/reverse"
import { getStripeGateway } from "@/lib/stripe/gateway"

import { defineJob } from "../define"

/**
 * `payouts/reverse` (Phase 5; CLAUDE.md §19.31, §19.35): after a refund succeeded or a chargeback
 * was lost, reverse the already transferred part of each member's share at Stripe
 * (`transfer_reversals`, idempotency key `reversal:<transferReversalId>`; lib/payouts/reverse.ts).
 * A refused reversal leaves the negative entries unpaid, so the next payouts net them (§19.10).
 */
export const payoutsReverse = defineJob({
  id: "payouts-reverse",
  event: "payouts/reverse.requested",
  retries: 3,
  concurrency: { limit: 1, key: "event.data.id" },
  handler: async ({ data, step }) =>
    runReversals({ db: getDb(), gateway: getStripeGateway(), step }, data),
})
