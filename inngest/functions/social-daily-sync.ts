import { and, eq, isNull, lt, or } from "drizzle-orm"

import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { socialConnections } from "@/lib/db/schema"
import { enqueue, runJobsNow } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"

import { defineJob } from "../define"

/** Connections synced more recently than this are skipped by the daily run. */
export const DAILY_SYNC_MIN_AGE_MS = 20 * 60 * 60 * 1000

/**
 * Daily re-sync (§7.1 "Re-sync daily", §13): one `social/sync.requested` per active OAuth
 * connection not synced in the last 20 hours. Under Inngest each becomes its own run (retries and
 * per-connection concurrency apply), with an idempotency id per connection and day. Inline (fake
 * jobs: dev, e2e via /api/test/jobs/social-daily-sync) the syncs run one after another before the
 * job returns, so a test sees their results; one failing connection never stops the others.
 */
export const socialDailySync = defineJob({
  id: "social-daily-sync",
  event: "social/daily-sync.requested",
  cron: { schedule: "15 4 * * *", data: {} },
  retries: 2,
  handler: async ({ step, mode }) => {
    const due = await step.run("find-due-connections", async () => {
      const at = now()
      const rows = await getDb()
        .select({ id: socialConnections.id })
        .from(socialConnections)
        .where(
          and(
            eq(socialConnections.source, "oauth"),
            eq(socialConnections.status, "active"),
            or(
              isNull(socialConnections.lastSyncedAt),
              lt(socialConnections.lastSyncedAt, new Date(at.getTime() - DAILY_SYNC_MIN_AGE_MS)),
            ),
          ),
        )
      return { day: at.toISOString().slice(0, 10), ids: rows.map((row) => row.id) }
    })

    let failed = 0
    for (const connectionId of due.ids) {
      if (mode === "inline") {
        try {
          await runJobsNow("social/sync.requested", { connectionId, reason: "scheduled" })
        } catch (error) {
          failed += 1
          reportError(error, { tags: { job: "social-daily-sync" } })
        }
      } else {
        await step.run(`enqueue-${connectionId}`, () =>
          enqueue(
            "social/sync.requested",
            { connectionId, reason: "scheduled" },
            { id: `social-sync:${connectionId}:${due.day}` },
          ),
        )
      }
    }
    return { due: due.ids.length, failed }
  },
})
