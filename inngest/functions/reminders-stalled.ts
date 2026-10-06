import { now } from "@/lib/clock"
import {
  refinalizeSignedAgreements,
  remindStalledCollabs,
  remindUnsignedAgreements,
} from "@/lib/collabs/reminders"
import { getDb } from "@/lib/db/client"

import { defineJob } from "../define"

/**
 * `reminders/stalled` (§13, daily): `collab.stalled` to both members of collabs in `agreement` or
 * `building` whose `last_activity_at` is 7+ days old (dedupe key
 * `collab.stalled:<collabId>:<last_activity_at ms>`: once per quiet spell), and
 * `agreement.reminder` to each member who has not signed an `awaiting_signatures` agreement
 * created 3+ days ago (dedupe key `agreement.reminder:<agreementId>:<userId>`: once)
 * (CLAUDE.md §19.24 "Collabs", §19.28; lib/collabs/reminders.ts). It also re-enqueues
 * `agreements/finalize` for signed agreements still without a PDF.
 *
 * The run's time is fixed in the first step, so a retried step judges "7 days" against the same
 * moment. A failed notification is reported and skipped; the step then throws so Inngest retries
 * it (deduplicated notifications are not sent twice).
 */
export const remindersStalled = defineJob({
  id: "reminders-stalled",
  event: "reminders/stalled.requested",
  cron: { schedule: "50 8 * * *", data: {} },
  retries: 2,
  concurrency: { limit: 1 },
  handler: async ({ step }) => {
    const at = new Date(await step.run("now", () => now().toISOString()))
    const stalled = await step.run("collab-stalled", async () => {
      const result = await remindStalledCollabs(getDb(), at)
      if (result.failed > 0) throw new Error(`reminders-stalled: ${result.failed} notice(s) failed`)
      return result
    })
    const agreements = await step.run("agreement-reminders", async () => {
      const result = await remindUnsignedAgreements(getDb(), at)
      if (result.failed > 0) {
        throw new Error(`reminders-stalled: ${result.failed} agreement reminder(s) failed`)
      }
      return result
    })
    const finalizeRequested = await step.run("refinalize", () =>
      refinalizeSignedAgreements(getDb(), at),
    )
    return {
      stalledCollabs: stalled.stalledCollabs,
      stalledNotices: stalled.stalledNotices,
      agreementReminders: agreements.agreementReminders,
      finalizeRequested,
    }
  },
})
