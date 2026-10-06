import "server-only"

import { eq } from "drizzle-orm"

import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { creatorProfiles, type SizeTier } from "@/lib/db/schema"

import { listUserConnections } from "./queries"
import { computeSizeTier } from "./size-tier"
import { CREATOR_SOCIAL_PROVIDERS, type SocialProviderId } from "./types"
import { hasPendingSync, toConnectionView, type ConnectionView } from "./view"

/**
 * Everything the creator's own audience pages show (/app/audience, /onboarding/creator/review):
 * the profile's derived fields and every creator connection with its newest snapshot. Only the
 * signed-in creator's own data; callers authorize first (lib/social/authz.ts).
 */

/** How long after a new snapshot a missing/older summary counts as "still being written". */
const SUMMARY_GRACE_MS = 2 * 60 * 1000

export type AudienceProfile = {
  id: string
  handle: string
  displayName: string
  sizeTier: SizeTier | null
  audienceSummary: string | null
  topics: string[]
  summaryPromptVersion: string | null
  summaryGeneratedAt: Date | null
  summaryEditedAt: Date | null
}

export type AudienceOverview = {
  profile: AudienceProfile | null
  /** YouTube, Instagram and TikTok connections (not GitHub), in provider order. */
  connections: ConnectionView[]
  /** The stored tier and whether it rests on verified numbers. */
  tier: { tier: SizeTier | null; verified: boolean }
  /** A connection is waiting for its first sync. */
  syncPending: boolean
  /** New data arrived and the AI summary for it is still being written. */
  summaryPending: boolean
  /** Latest snapshot time across connections. */
  lastSyncedAt: Date | null
}

const CREATOR_PROVIDERS: readonly SocialProviderId[] = CREATOR_SOCIAL_PROVIDERS

export async function loadAudienceOverview(
  database: DbOrTx,
  userId: string,
): Promise<AudienceOverview> {
  const [profileRow] = await database
    .select({
      id: creatorProfiles.id,
      handle: creatorProfiles.handle,
      displayName: creatorProfiles.displayName,
      sizeTier: creatorProfiles.sizeTier,
      audienceSummary: creatorProfiles.audienceSummary,
      topics: creatorProfiles.topics,
      summaryPromptVersion: creatorProfiles.audienceSummaryPromptVersion,
      summaryGeneratedAt: creatorProfiles.audienceSummaryGeneratedAt,
      summaryEditedAt: creatorProfiles.audienceSummaryEditedAt,
    })
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
    .limit(1)
  const profile = profileRow ?? null

  const connections = (await listUserConnections(database, userId))
    .map(toConnectionView)
    .filter((view) => CREATOR_PROVIDERS.includes(view.provider) && view.status !== "revoked")

  const computed = computeSizeTier(
    connections.map((view) => ({
      status: view.status,
      verified: view.verified,
      followers: view.latest?.followers ?? null,
    })),
  )

  const snapshotTimes = connections.flatMap((view) => (view.latest ? [view.latest.takenAt] : []))
  const lastSyncedAt =
    snapshotTimes.length > 0
      ? new Date(Math.max(...snapshotTimes.map((date) => date.getTime())))
      : null
  const syncPending = hasPendingSync(connections, now())
  const summaryStale =
    profile !== null &&
    profile.summaryEditedAt === null &&
    lastSyncedAt !== null &&
    (profile.summaryGeneratedAt === null || profile.summaryGeneratedAt < lastSyncedAt) &&
    now().getTime() - lastSyncedAt.getTime() < SUMMARY_GRACE_MS

  return {
    profile,
    connections,
    tier: { tier: profile?.sizeTier ?? computed.tier, verified: computed.verified },
    syncPending,
    summaryPending: syncPending || summaryStale,
    lastSyncedAt,
  }
}
