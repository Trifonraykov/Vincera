import { syncConnection } from "@/lib/social/sync"

import { defineJob } from "../define"

/**
 * `social/sync` (§13): pull a fresh audience snapshot for one connection and update the creator's
 * summary, embedding and size tier (lib/social/sync.ts). Triggered on connect, by the daily
 * fan-out and by the resync buttons. One sync per connection at a time (token refreshes must not
 * race; TikTok rotates refresh tokens). Rate limits and outages fail the step, so Inngest retries
 * it (a step that returned is memoised and would never run again); token failures and other
 * provider errors are final (the connection records why).
 */
export const socialSync = defineJob({
  id: "social-sync",
  event: "social/sync.requested",
  retries: 3,
  concurrency: { limit: 1, key: "event.data.connectionId" },
  handler: async ({ data, step }) =>
    step.run("sync-connection", async () => {
      const result = await syncConnection(data.connectionId)
      if (result.status === "failed" && result.retryable) {
        throw new Error(`social sync of ${result.provider} hit ${result.code}; retrying later`)
      }
      return result
    }),
})
