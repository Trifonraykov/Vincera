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

  // --- Phases 2–3 (declared by the W2 prep; contracts in CLAUDE.md §19.24) ----------------------

  /**
   * Re-embed one profile, idea or product after it changed (job `embeddings-refresh`, debounced
   * 10 min per entity), then ask matching to recompute. Send it with `requestEmbeddingRefresh()`
   * (lib/embeddings/request.ts) after any committed change that matters for matching.
   */
  "embeddings/refresh.requested": z.object({
    subjectType: z.enum(["creator_profile", "builder_profile", "idea", "product"]),
    subjectId: z.uuid(),
  }),

  /**
   * Recompute one user's match list (job `matching-recompute`, debounced 10 min per user). Send it
   * with `requestMatchingRecompute()` (lib/matching/request.ts).
   */
  "matching/recompute.requested": z.object({
    userId: z.uuid(),
    reason: z.enum(["profile_changed", "idea_changed", "product_changed", "nightly", "manual"]),
  }),

  /**
   * Re-score one target (a creator, builder, idea or product) for the users who may see it (job
   * `matching-target-changed`, debounced 10 min per target). Send it with
   * `requestTargetRescore()` (lib/matching/request.ts).
   */
  "matching/target-changed.requested": z.object({
    targetType: z.enum(["creator", "builder", "idea", "product"]),
    targetId: z.uuid(),
  }),

  /** Nightly fan-out (§8): recompute every eligible user's matches (job `matching-nightly`). */
  "matching/nightly.requested": z.object({}),

  /** Hourly (§13): expire open proposals past `expires_at` (job `proposals-expire`). */
  "proposals/expire.requested": z.object({}),

  /**
   * Daily (§13): nudge collabs with no activity for 7 days and agreements unsigned after 3 days
   * (job `reminders-stalled`).
   */
  "reminders/stalled.requested": z.object({}),

  /**
   * After the last signature (§12): render the signed PDF, store it, set `pdf_storage_key` and
   * email it to both members (job `agreements-finalize`).
   */
  "agreements/finalize.requested": z.object({ agreementId: z.uuid() }),
} as const satisfies Record<string, z.ZodObject>

export type JobEventName = keyof typeof jobEventSchemas
export type JobEventData<N extends JobEventName> = z.output<(typeof jobEventSchemas)[N]>

export const JOB_EVENT_NAMES = Object.keys(jobEventSchemas) as JobEventName[]

export function isJobEventName(value: string): value is JobEventName {
  return Object.hasOwn(jobEventSchemas, value)
}
