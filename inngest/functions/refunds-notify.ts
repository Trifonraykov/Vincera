import { getDb } from "@/lib/db/client"
import { sendRefundNotices } from "@/lib/refunds/notify"

import { defineJob } from "../define"

/**
 * `refunds/succeeded` (Phase 5; CLAUDE.md §19.31, §19.35): the buyer's refund confirmation
 * (`refund-confirmation.tsx`, required, idempotency key `refund-confirmation:<refundId>`) and
 * `order.refunded` to both members (required email, dedupe `order.refunded:<refundId>:<userId>`),
 * one step each (lib/refunds/notify.ts).
 */
export const refundsNotify = defineJob({
  id: "refunds-notify",
  event: "refunds/succeeded.requested",
  retries: 5,
  handler: async ({ data, step }) => sendRefundNotices(getDb(), data.refundId, step),
})
