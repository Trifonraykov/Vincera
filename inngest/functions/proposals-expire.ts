import { getDb } from "@/lib/db/client"
import { expireDueProposals } from "@/lib/proposals/expire"

import { defineJob } from "../define"

/**
 * `proposals/expire` (§13, hourly): open proposals (`pending`, `countered`) past `expires_at`
 * become `expired` with `closed_at`, `proposal.expired`, and a `proposal.expired` notification to
 * both parties (dedupe key `proposal.expired:<proposalId>`). Conditional updates, so a second run
 * or a racing answer changes nothing (CLAUDE.md §19.24 "Proposals"; lib/proposals/expire.ts).
 *
 * A proposal that fails is reported and skipped; the step then throws, so Inngest retries it and
 * only what is still due runs again.
 */
export const proposalsExpire = defineJob({
  id: "proposals-expire",
  event: "proposals/expire.requested",
  cron: { schedule: "5 * * * *", data: {} },
  retries: 2,
  concurrency: { limit: 1 },
  handler: async ({ step }) =>
    step.run("expire-due-proposals", async () => {
      const result = await expireDueProposals(getDb())
      if (result.failed > 0) {
        throw new Error(`proposals-expire: ${result.failed} proposal(s) failed to expire`)
      }
      return result
    }),
})
