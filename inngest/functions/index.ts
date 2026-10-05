import type { JobEventName } from "../client"
import type { Job } from "../define"

import { socialDailySync } from "./social-daily-sync"
import { socialSync } from "./social-sync"
import { socialYouTubeRetention } from "./social-youtube-retention"
import { systemPing } from "./system-ping"

/**
 * Registry of every background job (§13). Add new jobs here: the list feeds both the Inngest
 * serve route and the inline runner used when jobs are fake.
 *
 * Planned: social/sync, embeddings/refresh, matching/recompute, proposals/expire,
 * payouts/release, reminders/stalled, ledger/check.
 */
export const jobs: readonly Job[] = [
  systemPing,
  socialSync,
  socialDailySync,
  socialYouTubeRetention,
]

/** Inngest functions for `serve()`. */
export const functions = jobs.map((job) => job.fn)

/** Jobs triggered by an event (several jobs may listen to the same event). */
export function jobsFor(event: JobEventName): Job[] {
  return jobs.filter((job) => job.event === event)
}

/** The job with this id (`defineJob({ id })`), e.g. for the test-only job route. */
export function findJob(id: string): Job | undefined {
  return jobs.find((job) => job.id === id)
}
