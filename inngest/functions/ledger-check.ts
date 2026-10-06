import { getDb } from "@/lib/db/client"
import { runLedgerCheck } from "@/lib/payouts/ledger-check"
import { getStripeGateway } from "@/lib/stripe/gateway"

import { defineJob } from "../define"

/**
 * `ledger/check` (§13, daily 07:15 UTC, after the payout run; CLAUDE.md §19.31, §19.35): the
 * reconciliation (`checkLedger`, compared with Stripe's transfers). Each mismatch is reported to
 * Sentry with its kind and ids only; the run returns the counts.
 */
export const ledgerCheck = defineJob({
  id: "ledger-check",
  event: "ledger/check.requested",
  cron: { schedule: "15 7 * * *", data: {} },
  retries: 1,
  concurrency: { limit: 1 },
  handler: async ({ step }) =>
    step.run("check-ledger", () => runLedgerCheck(getDb(), { gateway: getStripeGateway() })),
})
