import type { AgeGender, CountryShare } from "@/lib/db/schema/types"

import { SOCIAL_PROVIDER_META } from "./catalog"
import { isSocialErrorCode, type SocialErrorCode } from "./errors"
import type { ConnectionWithSnapshot } from "./queries"
import { gitHubStatsFromRaw, type GitHubStats } from "./raw"
import { isVerifiedSource } from "./size-tier"
import type { AudienceBasis, SocialProviderId } from "./types"

/**
 * What the connection pages render for one connection: display data, health, and the newest
 * snapshot's numbers. Pure and client-safe (no tokens ever reach it: the queries do not select
 * them).
 */

export type ConnectionHealth =
  /** Synced and verified. */
  | "ok"
  /** Connected; the first sync has not finished yet. */
  | "syncing"
  /** The token expired or was revoked: reconnect. */
  | "expired"
  /** The last sync failed (rate limit, outage, ...); the old numbers are shown. */
  | "error"
  /** A manual entry nobody has verified yet. */
  | "unverified"

export type SnapshotView = {
  takenAt: Date
  followers: number | null
  avgViews: number | null
  engagementRate: number | null
  topCountries: CountryShare[]
  countriesBasis: AudienceBasis | null
  ageGender: AgeGender | null
  topTopics: string[]
}

export type ConnectionView = {
  id: string
  provider: SocialProviderId
  label: string
  source: "oauth" | "manual"
  status: "active" | "expired" | "revoked"
  /** Active and verified (§19.11): OAuth, or a manual entry an admin checked. */
  verified: boolean
  username: string | null
  displayName: string | null
  avatarUrl: string | null
  profileUrl: string | null
  lastSyncedAt: Date | null
  lastSyncError: SocialErrorCode | null
  health: ConnectionHealth
  /** Last change to the row (connect, reconnect, sync); bounds how long "syncing" is waited on. */
  updatedAt: Date
  latest: SnapshotView | null
  /** GitHub stars, repos, languages and contributions (GitHub connections only). */
  github: GitHubStats | null
}

export function healthOf(
  view: Pick<ConnectionView, "source" | "status" | "verified" | "lastSyncError"> & {
    hasSnapshot: boolean
  },
): ConnectionHealth {
  if (view.status !== "active") return "expired"
  if (view.source === "manual") return view.verified ? "ok" : "unverified"
  if (view.lastSyncError) return "error"
  if (!view.hasSnapshot) return "syncing"
  return "ok"
}

export function toConnectionView({ connection, latest }: ConnectionWithSnapshot): ConnectionView {
  const verified = isVerifiedSource(connection)
  const lastSyncError =
    connection.lastSyncError && isSocialErrorCode(connection.lastSyncError)
      ? connection.lastSyncError
      : connection.lastSyncError
        ? "provider_error"
        : null
  return {
    id: connection.id,
    provider: connection.provider,
    label: SOCIAL_PROVIDER_META[connection.provider].label,
    source: connection.source,
    status: connection.status,
    verified,
    username: connection.username,
    displayName: connection.displayName,
    avatarUrl: connection.avatarUrl,
    profileUrl: connection.profileUrl,
    lastSyncedAt: connection.lastSyncedAt,
    lastSyncError,
    updatedAt: connection.updatedAt,
    health: healthOf({
      source: connection.source,
      status: connection.status,
      verified,
      lastSyncError,
      hasSnapshot: latest !== null,
    }),
    latest: latest
      ? {
          takenAt: latest.takenAt,
          followers: latest.followers,
          avgViews: latest.avgViews,
          engagementRate: latest.engagementRate,
          topCountries: latest.topCountries ?? [],
          countriesBasis: latest.countriesBasis,
          ageGender: latest.ageGender,
          topTopics: latest.topTopics,
        }
      : null,
    github: connection.provider === "github" && latest ? gitHubStatsFromRaw(latest.raw) : null,
  }
}

/** How long pages wait (polling) for a new connection's first sync before giving up. */
export const FIRST_SYNC_WAIT_MS = 2 * 60 * 1000

/**
 * True while an OAuth connection made in the last couple of minutes is waiting for its first
 * snapshot (pages poll meanwhile). Older ones are shown as they are, so a lost job never leaves a
 * page waiting forever (the daily sync retries them).
 */
export function hasPendingSync(views: readonly ConnectionView[], at: Date): boolean {
  return views.some(
    (view) =>
      view.health === "syncing" && at.getTime() - view.updatedAt.getTime() < FIRST_SYNC_WAIT_MS,
  )
}
