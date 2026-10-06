import { getDb } from "@/lib/db/client"
import { runPayoutBatch } from "@/lib/payouts/release"
import { getStripeGateway } from "@/lib/stripe/gateway"

import { defineJob } from "../define"

/**
 * `payouts/release` (§9 "Daily payout job", §13; daily 06:00 UTC; CLAUDE.md §19.31, §19.35): one
 * payout batch (lib/payouts/release.ts). A batch is keyed by its run key (`daily:<UTC day>` by
 * default, `manual:<uuid>` for an admin run), so a retried or repeated run resumes it and pays
 * nobody twice: each transfer is created at Stripe with the idempotency key
 * `payout:<batchId>:<userId>`, and the entries it pays are marked with its id first.
 */
export const payoutsRelease = defineJob({
  id: "payouts-release",
  event: "payouts/release.requested",
  cron: { schedule: "0 6 * * *", data: {} },
  retries: 3,
  concurrency: { limit: 1 },
  handler: async ({ data, step }) =>
    runPayoutBatch({ db: getDb(), gateway: getStripeGateway(), step }, { runKey: data.runKey }),
})
