import { isValidKey } from "@/lib/storage/keys"
import { getStorage } from "@/lib/storage/r2"

import { defineJob } from "../define"

/** Keys deleted per step, so a retry resumes after the batches that already finished. */
const BATCH_SIZE = 100

/**
 * `gdpr-cleanup` (trust, CLAUDE.md §19.38, §19.40): after an account deletion commits, delete the
 * collected storage objects (portfolio images, evidence screenshots, attachments the user sent).
 * Best effort per key and idempotent: a missing object is fine. One step per batch of keys.
 */
export const gdprCleanup = defineJob({
  id: "gdpr-cleanup",
  event: "gdpr/cleanup.requested",
  retries: 5,
  handler: async ({ data, step }) => {
    // A malformed key could never be deleted; skip it instead of retrying forever.
    const keys = [...new Set(data.storageKeys)].filter(isValidKey)
    let deleted = 0
    for (let start = 0; start < keys.length; start += BATCH_SIZE) {
      const batch = keys.slice(start, start + BATCH_SIZE)
      deleted += await step.run(`delete-${start / BATCH_SIZE}`, async () => {
        const storage = getStorage()
        for (const key of batch) await storage.deleteObject(key)
        return batch.length
      })
    }
    return { deleted }
  },
})
