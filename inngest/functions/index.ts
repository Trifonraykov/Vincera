import type { JobEventName } from "../client"
import type { Job } from "../define"

import { agreementsFinalize } from "./agreements-finalize"
import { embeddingsRefresh } from "./embeddings-refresh"
import { gdprCleanup } from "./gdpr-cleanup"
import { ledgerCheck } from "./ledger-check"
import { ledgerPostPending } from "./ledger-post-pending"
import { matchingNightly } from "./matching-nightly"
import { matchingRecompute } from "./matching-recompute"
import { matchingTargetChanged } from "./matching-target-changed"
import { matchingTrain } from "./matching-train"
import { ordersFulfilled } from "./orders-fulfilled"
import { payoutsRelease } from "./payouts-release"
import { payoutsReverse } from "./payouts-reverse"
import { proposalsExpire } from "./proposals-expire"
import { refundsNotify } from "./refunds-notify"
import { remindersStalled } from "./reminders-stalled"
import { socialDailySync } from "./social-daily-sync"
import { socialSync } from "./social-sync"
import { socialYouTubeRetention } from "./social-youtube-retention"
import { systemPing } from "./system-ping"

/**
 * Registry of every background job (§13). Add new jobs here: the list feeds both the Inngest
 * serve route and the inline runner used when jobs are fake.
 *
 * Phase 2–3 jobs are owned per area (CLAUDE.md §19.24), Phase 4–5 jobs too (§19.31), and
 * Phase 6–7 jobs (§19.38).
 */
export const jobs: readonly Job[] = [
  systemPing,
  socialSync,
  socialDailySync,
  socialYouTubeRetention,
  // Phase 2: supply, matching
  embeddingsRefresh,
  matchingRecompute,
  matchingTargetChanged,
  matchingNightly,
  // Phase 3: proposals, collabs
  proposalsExpire,
  remindersStalled,
  agreementsFinalize,
  // Phases 4–5: checkout, ledger, payouts (registered by the W3 prep)
  ordersFulfilled,
  ledgerPostPending,
  payoutsRelease,
  payoutsReverse,
  refundsNotify,
  ledgerCheck,
  // Phases 6–7: trust, matching v1 (registered by the W4 prep)
  gdprCleanup,
  matchingTrain,
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
