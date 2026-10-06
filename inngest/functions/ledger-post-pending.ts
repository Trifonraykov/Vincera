import { getDb } from "@/lib/db/client"
import { postPendingOrders } from "@/lib/ledger/pending"
import { getStripeGateway } from "@/lib/stripe/gateway"

import { defineJob } from "../define"

/**
 * `ledger/post-pending` (Phase 5, CLAUDE.md §19.31, §19.33), hourly at :20: orders paid more than
 * an hour ago with `ledger_posted_at IS NULL` get their PaymentIntent retrieved with the balance
 * transaction and `postOrderLedger` run (lib/ledger/pending.ts); orders whose fee is still pending
 * wait for the next run. Posting is idempotent, so a retried step or an overlapping
 * `charge.updated` changes nothing. A failing order is reported and skipped; the step then throws,
 * so Inngest retries it and only what is still unposted runs again.
 */
export const ledgerPostPending = defineJob({
  id: "ledger-post-pending",
  event: "ledger/post-pending.requested",
  cron: { schedule: "20 * * * *", data: {} },
  retries: 2,
  concurrency: { limit: 1 },
  handler: async ({ step }) =>
    step.run("post-pending-orders", async () => {
      const result = await postPendingOrders(getDb(), { gateway: getStripeGateway() })
      if (result.failed > 0) {
        throw new Error(`ledger-post-pending: ${result.failed} order(s) failed to post`)
      }
      return result
    }),
})
