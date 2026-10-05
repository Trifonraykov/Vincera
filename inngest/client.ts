import { Inngest } from "inngest"
import { z } from "zod"

/**
 * Inngest client and the typed catalogue of job events (§13).
 *
 * The client reads INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY (and INNGEST_DEV for a local Inngest
 * dev server) from the environment itself. Code never calls `inngest.send` directly: use
 * `enqueue()` from `lib/jobs/enqueue.ts`, which validates the payload and runs jobs inline when
 * the jobs service is fake (§19.3).
 *
 * Payloads carry ids only, never emails, tokens or message bodies (§11).
 */

export const INNGEST_APP_ID = "vincera-platform"

export const inngest = new Inngest({ id: INNGEST_APP_ID })

/**
 * Event name → payload schema. Names are `<area>/<thing>.<verb>`. Jobs that also run on a cron
 * declare the payload for scheduled runs in `defineJob({ cron: { schedule, data } })`.
 */
export const jobEventSchemas = {
  /** Health check; also exercises the inline runner in tests. */
  "system/ping": z.object({ note: z.string().max(200).optional() }),

  /** Pull a fresh audience snapshot for one social connection (§7.1). */
  "social/sync.requested": z.object({
    connectionId: z.uuid(),
    reason: z.enum(["connected", "scheduled", "manual"]),
  }),

  /** Daily fan-out (§7.1 "Re-sync daily"): enqueue `social/sync.requested` per active connection. */
  "social/daily-sync.requested": z.object({}),

  /**
   * Daily YouTube retention (§19.10): while YOUTUBE_LONG_RETENTION is false, delete YouTube
   * snapshots older than 30 days except each connection's newest (GDPR erasure hatch).
   */
  "social/youtube-retention.requested": z.object({}),

  /** Re-embed one profile, idea or product after it changed. */
  "embeddings/refresh.requested": z.object({
    subjectType: z.enum(["creator_profile", "builder_profile", "idea", "product"]),
    subjectId: z.uuid(),
  }),

  /** Recompute matches for one user (debounced per user), or everyone when userId is absent. */
  "matching/recompute.requested": z.object({
    userId: z.uuid().optional(),
    reason: z.enum(["profile_changed", "idea_changed", "product_changed", "nightly", "manual"]),
  }),
} as const satisfies Record<string, z.ZodObject>

export type JobEventName = keyof typeof jobEventSchemas
export type JobEventData<N extends JobEventName> = z.output<(typeof jobEventSchemas)[N]>

export const JOB_EVENT_NAMES = Object.keys(jobEventSchemas) as JobEventName[]

export function isJobEventName(value: string): value is JobEventName {
  return Object.hasOwn(jobEventSchemas, value)
}
