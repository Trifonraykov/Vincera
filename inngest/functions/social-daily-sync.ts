import { and, asc, eq, gt, isNull, lt, notInArray, or } from "drizzle-orm"

import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { socialConnections } from "@/lib/db/schema"
import { env } from "@/lib/env"
import { runJobsNow } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"

import { inngest, jobEventSchemas } from "../client"
import { defineJob, type JobStep } from "../define"

/** Connections synced more recently than this are skipped by the daily run. */
export const DAILY_SYNC_MIN_AGE_MS = 20 * 60 * 60 * 1000

/**
 * Connections per page. Under Inngest each page is one step (the query plus one batched send),
 * which keeps a run far below Inngest's limits on steps per run, step output size and events per
 * send, however many connections there are.
 */
export const DAILY_SYNC_PAGE_SIZE = 200

/**
 * Active OAuth connections not synced since `cutoff`, in id order after `afterId`. Providers whose
 * OAuth is switched off (SOCIAL_OAUTH_DISABLED) are left alone.
 */
async function dueConnectionIds(
  cutoff: Date,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const disabled = [...env.SOCIAL_OAUTH_DISABLED]
  const rows = await getDb()
    .select({ id: socialConnections.id })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.source, "oauth"),
        eq(socialConnections.status, "active"),
        or(isNull(socialConnections.lastSyncedAt), lt(socialConnections.lastSyncedAt, cutoff)),
        afterId ? gt(socialConnections.id, afterId) : undefined,
        disabled.length > 0 ? notInArray(socialConnections.provider, disabled) : undefined,
      ),
    )
    .orderBy(asc(socialConnections.id))
    .limit(limit)
  return rows.map((row) => row.id)
}

/**
 * One batched send of `social/sync.requested` events. Each event id is
 * `social-sync:<connection>:<day>`, so a retried step (or a second run the same day) is
 * deduplicated by Inngest. Only used under Inngest; inline mode runs the syncs itself.
 */
async function sendSyncEvents(connectionIds: readonly string[], day: string): Promise<void> {
  if (connectionIds.length === 0) return
  await inngest.send(
    connectionIds.map((connectionId) => ({
      name: "social/sync.requested" as const,
      id: `social-sync:${connectionId}:${day}`,
      data: jobEventSchemas["social/sync.requested"].parse({ connectionId, reason: "scheduled" }),
    })),
  )
}

/**
 * Daily re-sync (§7.1 "Re-sync daily", §13): one `social/sync.requested` per active OAuth
 * connection not synced in the last 20 hours, page by page (keyset on the id). Under Inngest each
 * page is sent as one batch and each event becomes its own sync run (retries and per-connection
 * concurrency apply). Inline (fake jobs: dev, e2e via /api/test/jobs/social-daily-sync) the syncs
 * run one after another before the job returns, so a test sees their results; one failing
 * connection never stops the others.
 */
export const socialDailySync = defineJob({
  id: "social-daily-sync",
  event: "social/daily-sync.requested",
  cron: { schedule: "15 4 * * *", data: {} },
  retries: 2,
  handler: ({ step, mode }) => dailySyncFanOut({ step, mode }),
})

export type DailySyncFanOutOptions = {
  step: JobStep
  mode: "inngest" | "inline"
  /** Tests use small pages. */
  pageSize?: number
  /** Tests record the batches instead of sending them to Inngest. */
  send?: (connectionIds: readonly string[], day: string) => Promise<void>
}

/** The daily fan-out (the job's handler), with its paging and sending injectable for tests. */
export async function dailySyncFanOut({
  step,
  mode,
  pageSize = DAILY_SYNC_PAGE_SIZE,
  send = sendSyncEvents,
}: DailySyncFanOutOptions): Promise<{ due: number; failed: number }> {
  // Fixed once (memoised under Inngest), so every page and retry uses the same cutoff and day.
  const syncWindow = await step.run("sync-window", () => {
    const at = now()
    return {
      day: at.toISOString().slice(0, 10),
      cutoff: new Date(at.getTime() - DAILY_SYNC_MIN_AGE_MS).toISOString(),
    }
  })
  const cutoff = new Date(syncWindow.cutoff)

  let afterId: string | null = null
  let due = 0
  let failed = 0
  for (let page = 0; ; page += 1) {
    const cursor: string | null = afterId
    let ids: string[]
    if (mode === "inline") {
      ids = await dueConnectionIds(cutoff, cursor, pageSize)
      for (const connectionId of ids) {
        try {
          await runJobsNow("social/sync.requested", { connectionId, reason: "scheduled" })
        } catch (error) {
          failed += 1
          reportError(error, { tags: { job: "social-daily-sync" } })
        }
      }
    } else {
      ids = await step.run(`enqueue-page-${page}`, async () => {
        const pageIds = await dueConnectionIds(cutoff, cursor, pageSize)
        if (pageIds.length > 0) await send(pageIds, syncWindow.day)
        return pageIds
      })
    }
    due += ids.length
    const last = ids.at(-1)
    if (ids.length < pageSize || last === undefined) break
    afterId = last
  }
  return { due, failed }
}
