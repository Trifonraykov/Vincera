import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { requestEmbeddingRefresh } from "@/lib/embeddings/request"
import { dueAppStoreProfiles, syncAppStore } from "@/lib/listings/app-store/service"
import { reportError } from "@/lib/observability"

import { defineJob, type JobStep } from "../define"

/** Profiles synced more recently than this are skipped by the daily run. */
export const APP_STORE_SYNC_MIN_AGE_MS = 20 * 60 * 60 * 1000
const PAGE_SIZE = 100

/**
 * Daily App Store re-import (CLAUDE.md §19.45, like §7.1's daily social re-sync): each builder
 * with a connected developer account gets their apps imported again (new apps added, changes
 * followed unless the builder edited the text, apps gone from the store hidden). One step per
 * builder, so a retry repeats only the builder that failed; a failing builder never stops the
 * others (the error is recorded on the profile and reported).
 */
export const listingsAppStoreSync = defineJob({
  id: "listings-app-store-sync",
  event: "listings/app-store-daily.requested",
  cron: { schedule: "40 4 * * *", data: {} },
  retries: 2,
  handler: ({ step }) => appStoreDailySync({ step }),
})

export async function appStoreDailySync({
  step,
}: {
  step: JobStep
}): Promise<{ due: number; synced: number; failed: number }> {
  const window = await step.run("sync-window", () => ({
    cutoff: new Date(now().getTime() - APP_STORE_SYNC_MIN_AGE_MS).toISOString(),
  }))
  const cutoff = new Date(window.cutoff)
  let afterId: string | null = null
  let due = 0
  let synced = 0
  let failed = 0
  for (let page = 0; ; page += 1) {
    const cursor: string | null = afterId
    const ids: string[] = await step.run(`page-${page}`, (): Promise<string[]> =>
      dueAppStoreProfiles(getDb(), { cutoff, afterId: cursor, limit: PAGE_SIZE }),
    )
    due += ids.length
    for (const builderProfileId of ids) {
      const outcome = await step.run(`sync-${builderProfileId}`, async () => {
        try {
          const result = await syncAppStore(getDb(), {
            builderProfileId,
            actorUserId: null,
            trigger: "scheduled",
          })
          if ("error" in result) return result.error
          for (const listing of result.listings) {
            if (listing.action !== "unchanged") {
              await requestEmbeddingRefresh({ type: "product", id: listing.productId })
            }
          }
          return "synced"
        } catch (error) {
          reportError(error, { tags: { job: "listings-app-store-sync" } })
          return "failed"
        }
      })
      if (outcome === "synced") synced += 1
      else failed += 1
    }
    const last: string | undefined = ids.at(-1)
    if (ids.length < PAGE_SIZE || last === undefined) break
    afterId = last
  }
  return { due, synced, failed }
}
