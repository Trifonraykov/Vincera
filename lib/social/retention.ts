import "server-only"

import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import { allowGdprErasure } from "@/lib/db/append-only"
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client"
import { audienceSnapshots, socialConnections } from "@/lib/db/schema"
import { env } from "@/lib/env"

import { DAY_MS } from "./metrics"

/**
 * YouTube data retention (§19.10, pending confirmation). Google's policy limits storing YouTube
 * statistics to 30 days unless the platform accepts the derived-metrics policy. While
 * `YOUTUBE_LONG_RETENTION` is false, the daily `social/youtube-retention` job deletes
 * YouTube-sourced `audience_snapshots` older than 30 days, through the GDPR erasure hatch
 * (`allowGdprErasure`). Each connection's newest snapshot is kept, and so are the derived profile
 * fields (`size_tier`, `audience_summary`, `embedding`), which live on `creator_profiles`.
 */

export const YOUTUBE_RETENTION_DAYS = 30

export type RetentionResult =
  | { skipped: true; reason: "long_retention_enabled" }
  | { skipped: false; cutoff: string; deleted: number }

export async function purgeExpiredYouTubeSnapshots(
  database: DbOrTx = getDb(),
  options: { longRetention?: boolean } = {},
): Promise<RetentionResult> {
  if (options.longRetention ?? env.YOUTUBE_LONG_RETENTION) {
    return { skipped: true, reason: "long_retention_enabled" }
  }
  const cutoff = new Date(now().getTime() - YOUTUBE_RETENTION_DAYS * DAY_MS)

  const deleted = await withTransaction(async (tx) => {
    await allowGdprErasure(tx)
    // The newest snapshot of each YouTube connection stays (it backs the profile's numbers).
    const newest = tx
      .selectDistinctOn([audienceSnapshots.socialConnectionId], { id: audienceSnapshots.id })
      .from(audienceSnapshots)
      .innerJoin(socialConnections, eq(socialConnections.id, audienceSnapshots.socialConnectionId))
      .where(eq(socialConnections.provider, "youtube"))
      .orderBy(
        audienceSnapshots.socialConnectionId,
        sql`${audienceSnapshots.takenAt} desc`,
        sql`${audienceSnapshots.id} desc`,
      )
    const youtubeConnections = tx
      .select({ id: socialConnections.id })
      .from(socialConnections)
      .where(eq(socialConnections.provider, "youtube"))
    const rows = await tx
      .delete(audienceSnapshots)
      .where(
        and(
          inArray(audienceSnapshots.socialConnectionId, youtubeConnections),
          lt(audienceSnapshots.takenAt, cutoff),
          notInArray(audienceSnapshots.id, newest),
        ),
      )
      .returning({ id: audienceSnapshots.id })
    return rows.length
  }, database)

  return { skipped: false, cutoff: cutoff.toISOString(), deleted }
}
