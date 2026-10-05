import { purgeExpiredYouTubeSnapshots } from "@/lib/social/retention"

import { defineJob } from "../define"

/**
 * Daily YouTube retention (§19.10): while YOUTUBE_LONG_RETENTION is false, delete YouTube
 * snapshots older than 30 days except each connection's newest (lib/social/retention.ts).
 * Idempotent: a second run the same day deletes nothing.
 */
export const socialYouTubeRetention = defineJob({
  id: "social-youtube-retention",
  event: "social/youtube-retention.requested",
  cron: { schedule: "45 3 * * *", data: {} },
  retries: 2,
  handler: async ({ step }) =>
    step.run("purge-youtube-snapshots", () => purgeExpiredYouTubeSnapshots()),
})
