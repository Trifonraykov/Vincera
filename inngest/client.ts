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

  // --- Phases 4–5 (declared by the W3 prep; contracts in CLAUDE.md §19.31) ----------------------

  /**
   * After an order commits (checkout): the buyer's receipt with the access link (a required
   * email) and `sale.made` to both members (job `orders-fulfilled`). Event id `order:<orderId>`.
   */
  "orders/paid.requested": z.object({ orderId: z.uuid() }),

  /**
   * Hourly safety net (ledger): orders whose ledger is still unposted an hour after payment are
   * posted once Stripe has the balance transaction (job `ledger-post-pending`).
   */
  "ledger/post-pending.requested": z.object({}),

  /**
   * Daily 06:00 UTC (§13 `payouts/release`): one payout batch (job `payouts-release`). Without
   * `runKey` the run is `daily:<YYYY-MM-DD>` of the job's clock; an admin run passes
   * `manual:<uuid>`.
   */
  "payouts/release.requested": z.object({
    runKey: z
      .string()
      .regex(/^(daily:\d{4}-\d{2}-\d{2}|manual:[0-9a-f-]{36})$/)
      .optional(),
  }),

  /**
   * After a refund succeeded or a chargeback was lost (payouts): reverse the transferred part of
   * the user shares at Stripe and record it (job `payouts-reverse`). Event id
   * `reverse:<cause>:<id>`.
   */
  "payouts/reverse.requested": z.object({
    cause: z.enum(["refund", "chargeback"]),
    id: z.uuid(),
  }),

  /**
   * After a refund succeeded (payouts): the buyer's refund confirmation (a required email) and
   * `order.refunded` to both members (job `refunds-notify`).
   */
  "refunds/succeeded.requested": z.object({ refundId: z.uuid() }),

  /** Daily (§13 `ledger/check`): reconciliation; a mismatch is reported to Sentry. */
  "ledger/check.requested": z.object({}),

  // --- Phases 6–7 (declared by the W4 prep; contracts in CLAUDE.md §19.38) ----------------------

  /**
   * After an account deletion commits (trust, §14): delete the user's private files from storage
   * (portfolio images, evidence screenshots, message attachments they sent, uploads) and revoke
   * social tokens it still could (job `gdpr-cleanup`). The keys are collected inside the deleting
   * transaction, because the rows that point at them are gone afterwards. Event id
   * `gdpr-cleanup:<userId>`.
   */
  "gdpr/cleanup.requested": z.object({
    userId: z.uuid(),
    storageKeys: z.array(z.string().min(1).max(512)).max(5000),
  }),

  /**
   * Train a matching v1 model on the stored feature vectors (matching-v1, §8 v1; job
   * `matching-train`). The new `matching_config` row is stored inactive. `requestedByUserId` is
   * the admin who pressed "Train" on /admin/matching (null from the CLI).
   */
  "matching/train.requested": z.object({ requestedByUserId: z.uuid().nullable() }),
} as const satisfies Record<string, z.ZodObject>

export type JobEventName = keyof typeof jobEventSchemas
export type JobEventData<N extends JobEventName> = z.output<(typeof jobEventSchemas)[N]>

export const JOB_EVENT_NAMES = Object.keys(jobEventSchemas) as JobEventName[]

export function isJobEventName(value: string): value is JobEventName {
  return Object.hasOwn(jobEventSchemas, value)
}
