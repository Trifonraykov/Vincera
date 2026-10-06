import { getDb } from "@/lib/db/client"
import { sendOrderEmails } from "@/lib/orders/emails"

import { defineJob } from "../define"

/**
 * `orders/paid.requested` (Phase 4; CLAUDE.md §19.31, §19.34): the buyer's receipt with the access
 * link (`buyer-receipt.tsx`, a required email with idempotency key `buyer-receipt:<orderId>`),
 * `sale.made` to both members (dedupe `sale.made:<orderId>:<userId>`, email `sale-made.tsx`), and
 * the license-key stock notice. Enqueued after the fulfilment commits (event id
 * `order:<orderId>`); retries until the receipt is sent (lib/orders/emails.ts).
 */
export const ordersFulfilled = defineJob({
  id: "orders-fulfilled",
  event: "orders/paid.requested",
  retries: 5,
  concurrency: { limit: 1, key: "event.data.orderId" },
  handler: async ({ data, step }) => sendOrderEmails(getDb(), data.orderId, step),
})
