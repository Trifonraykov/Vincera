import { and, asc, gt, isNotNull, eq, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { runJobsNow } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"

import { inngest, jobEventSchemas } from "../client"
import { defineJob, type JobStep } from "../define"

/** Users per page; under Inngest each page is one step (a query plus one batched send). */
export const MATCHING_NIGHTLY_PAGE_SIZE = 200

/** Users who can have matches: active, onboarded, with an app role (§19.24). */
async function eligibleUserIds(afterId: string | null, limit: number): Promise<string[]> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.status, "active"),
        isNotNull(users.onboardingCompletedAt),
        sql`${users.roles} && ARRAY['creator', 'builder']::text[]`,
        afterId ? gt(users.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(users.id))
    .limit(limit)
  return rows.map((row) => row.id)
}

/**
 * One batched send of `matching/recompute.requested` (reason `nightly`). Event ids are
 * `matching-nightly:<user>:<day>`, so a retried step or a second run the same day is deduplicated.
 */
async function sendRecomputeEvents(userIds: readonly string[], day: string): Promise<void> {
  if (userIds.length === 0) return
  await inngest.send(
    userIds.map((userId) => ({
      name: "matching/recompute.requested" as const,
      id: `matching-nightly:${userId}:${day}`,
      data: jobEventSchemas["matching/recompute.requested"].parse({ userId, reason: "nightly" }),
    })),
  )
}

/**
 * `matching/recompute` nightly (§8 "Recompute nightly"): one `matching/recompute.requested`
 * (reason `nightly`) per eligible user, after the daily social sync (04:15 UTC) refreshed
 * audiences. Paged and batched like `social-daily-sync` (CLAUDE.md §19.14). Inline (fake jobs,
 * `/api/test/jobs/matching-nightly`) the recomputes run one after another before it returns; a
 * failing user never stops the others.
 */
export const matchingNightly = defineJob({
  id: "matching-nightly",
  event: "matching/nightly.requested",
  cron: { schedule: "30 5 * * *", data: {} },
  retries: 2,
  concurrency: { limit: 1 },
  handler: ({ step, mode }) => matchingNightlyFanOut({ step, mode }),
})

export type MatchingNightlyOptions = {
  step: JobStep
  mode: "inngest" | "inline"
  pageSize?: number
  send?: (userIds: readonly string[], day: string) => Promise<void>
}

export async function matchingNightlyFanOut({
  step,
  mode,
  pageSize = MATCHING_NIGHTLY_PAGE_SIZE,
  send = sendRecomputeEvents,
}: MatchingNightlyOptions): Promise<{ users: number; failed: number }> {
  const day = await step.run("day", () => now().toISOString().slice(0, 10))
  let afterId: string | null = null
  let total = 0
  let failed = 0
  for (let page = 0; ; page += 1) {
    const cursor: string | null = afterId
    let ids: string[]
    if (mode === "inline") {
      ids = await eligibleUserIds(cursor, pageSize)
      for (const userId of ids) {
        try {
          await runJobsNow("matching/recompute.requested", { userId, reason: "nightly" })
        } catch (error) {
          failed += 1
          reportError(error, { tags: { job: "matching-nightly" } })
        }
      }
    } else {
      ids = await step.run(`enqueue-page-${page}`, async () => {
        const pageIds = await eligibleUserIds(cursor, pageSize)
        if (pageIds.length > 0) await send(pageIds, day)
        return pageIds
      })
    }
    total += ids.length
    const last = ids.at(-1)
    if (ids.length < pageSize || last === undefined) break
    afterId = last
  }
  return { users: total, failed }
}
