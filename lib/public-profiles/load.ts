import "server-only"

import { and, asc, desc, eq, inArray } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  creatorProfiles,
  portfolioItems,
  socialConnections,
  users,
  type Availability,
  type DealPreference,
  type ProductFormat,
  type SizeTier,
} from "@/lib/db/schema"
import { HANDLE_REGEX } from "@/lib/db/schema/columns"
import { SOCIAL_PROVIDER_META } from "@/lib/social/catalog"
import { latestSnapshotsFor } from "@/lib/social/queries"
import { safeUrl } from "@/lib/social/metrics"
import { gitHubStatsFromRaw, type GitHubStats } from "@/lib/social/raw"
import { computeSizeTier } from "@/lib/social/size-tier"
import { CREATOR_SOCIAL_PROVIDERS, type SocialProviderId } from "@/lib/social/types"

/**
 * Public profiles, `/c/[handle]` and `/b/[handle]` (§6 "Public profile pages expose only fields
 * marked public"; CLAUDE.md §19.14). Each loader selects exactly the public fields listed below,
 * nothing else: no emails, user ids, tokens, raw provider payloads, demographics breakdowns,
 * evidence screenshots or unverified links. Suspended users' profiles are not found.
 *
 * Creator (public): handle, display name, bio, niche, topics, languages, country, size tier
 * (and whether it rests on verified numbers), audience summary, and per platform: followers,
 * average views, engagement, verified/unverified, last update, and the channel link when
 * verified.
 * Builder (public): handle, display name, bio, skills, stack, availability, deal preference,
 * portfolio items (title, link, description, shipped, format), and GitHub stats (login, profile
 * link, followers, public repos, stars, top languages, top repositories, contributions).
 */

export function isValidHandle(value: string): boolean {
  return HANDLE_REGEX.test(value)
}

export type PublicPlatform = {
  provider: SocialProviderId
  label: string
  verified: boolean
  /** Connection expired: the numbers are from the last successful update. */
  stale: boolean
  followers: number | null
  avgViews: number | null
  engagementRate: number | null
  updatedAt: Date
  /** The public channel/account link, only for verified connections. */
  profileUrl: string | null
}

export type PublicCreatorProfile = {
  handle: string
  displayName: string
  bio: string | null
  niche: string | null
  topics: string[]
  languages: string[]
  country: string | null
  sizeTier: SizeTier | null
  sizeTierVerified: boolean
  audienceSummary: string | null
  /** The creator profile itself was verified by an admin (`creator_profiles.verified_at`). */
  verified: boolean
  platforms: PublicPlatform[]
  /** Sum of verified platforms' followers (audiences overlap; shown as "combined reach"). */
  verifiedReach: number | null
  memberSince: Date
}

export async function loadPublicCreatorProfile(
  database: DbOrTx,
  handle: string,
): Promise<PublicCreatorProfile | null> {
  if (!isValidHandle(handle)) return null
  const [row] = await database
    .select({
      userId: creatorProfiles.userId,
      handle: creatorProfiles.handle,
      displayName: creatorProfiles.displayName,
      bio: creatorProfiles.bio,
      niche: creatorProfiles.niche,
      topics: creatorProfiles.topics,
      languages: creatorProfiles.languages,
      country: creatorProfiles.country,
      sizeTier: creatorProfiles.sizeTier,
      audienceSummary: creatorProfiles.audienceSummary,
      verifiedAt: creatorProfiles.verifiedAt,
      memberSince: creatorProfiles.createdAt,
    })
    .from(creatorProfiles)
    .innerJoin(users, eq(users.id, creatorProfiles.userId))
    .where(and(eq(creatorProfiles.handle, handle), eq(users.status, "active")))
    .limit(1)
  if (!row) return null

  const connections = await database
    .select({
      id: socialConnections.id,
      provider: socialConnections.provider,
      status: socialConnections.status,
      verifiedAt: socialConnections.verifiedAt,
      profileUrl: socialConnections.profileUrl,
    })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.userId, row.userId),
        inArray(socialConnections.provider, [...CREATOR_SOCIAL_PROVIDERS]),
      ),
    )
  const usable = connections.filter((connection) => connection.status !== "revoked")
  const latest = await latestSnapshotsFor(
    database,
    usable.map((connection) => connection.id),
  )

  const order = new Map<SocialProviderId, number>(
    CREATOR_SOCIAL_PROVIDERS.map((provider, index) => [provider, index]),
  )
  const platforms: PublicPlatform[] = usable
    .flatMap((connection) => {
      const snapshot = latest.get(connection.id)
      if (!snapshot) return []
      const verified = connection.status === "active" && connection.verifiedAt !== null
      return [
        {
          provider: connection.provider,
          label: SOCIAL_PROVIDER_META[connection.provider].label,
          verified,
          stale: connection.status === "expired",
          followers: snapshot.followers,
          avgViews: snapshot.avgViews,
          engagementRate: snapshot.engagementRate,
          updatedAt: snapshot.takenAt,
          profileUrl: verified ? safeUrl(connection.profileUrl) : null,
        },
      ]
    })
    .sort((a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0))

  const tier = computeSizeTier(
    platforms.map((platform) => ({
      status: platform.stale ? "expired" : "active",
      verified: platform.verified,
      followers: platform.followers,
    })),
  )
  const verifiedFollowers = platforms
    .filter((platform) => platform.verified && platform.followers !== null)
    .map((platform) => platform.followers ?? 0)

  return {
    handle: row.handle,
    displayName: row.displayName,
    bio: row.bio,
    niche: row.niche,
    topics: row.topics,
    languages: row.languages,
    country: row.country,
    sizeTier: row.sizeTier ?? tier.tier,
    sizeTierVerified: tier.verified,
    audienceSummary: row.audienceSummary,
    verified: row.verifiedAt !== null,
    platforms,
    verifiedReach:
      verifiedFollowers.length > 0
        ? verifiedFollowers.reduce((sum, value) => sum + value, 0)
        : null,
    memberSince: row.memberSince,
  }
}

export type PublicPortfolioItem = {
  title: string
  url: string | null
  description: string | null
  isShipped: boolean
  format: ProductFormat | null
}

export type PublicGitHub = {
  login: string | null
  profileUrl: string | null
  followers: number | null
  /** False when the connection expired: the stats are from the last successful update. */
  current: boolean
  updatedAt: Date
  stats: GitHubStats | null
}

export type PublicBuilderProfile = {
  handle: string
  displayName: string
  bio: string | null
  skills: string[]
  stack: string[]
  availability: Availability
  dealPreference: DealPreference
  verified: boolean
  portfolio: PublicPortfolioItem[]
  github: PublicGitHub | null
  memberSince: Date
}

export async function loadPublicBuilderProfile(
  database: DbOrTx,
  handle: string,
): Promise<PublicBuilderProfile | null> {
  if (!isValidHandle(handle)) return null
  const [row] = await database
    .select({
      id: builderProfiles.id,
      userId: builderProfiles.userId,
      handle: builderProfiles.handle,
      displayName: builderProfiles.displayName,
      bio: builderProfiles.bio,
      skills: builderProfiles.skills,
      stack: builderProfiles.stack,
      availability: builderProfiles.availability,
      dealPreference: builderProfiles.dealPreference,
      verifiedAt: builderProfiles.verifiedAt,
      memberSince: builderProfiles.createdAt,
    })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(and(eq(builderProfiles.handle, handle), eq(users.status, "active")))
    .limit(1)
  if (!row) return null

  const portfolio = await database
    .select({
      title: portfolioItems.title,
      url: portfolioItems.url,
      description: portfolioItems.description,
      isShipped: portfolioItems.isShipped,
      format: portfolioItems.format,
    })
    .from(portfolioItems)
    .where(eq(portfolioItems.builderProfileId, row.id))
    .orderBy(desc(portfolioItems.isShipped), asc(portfolioItems.createdAt))

  const [github] = await database
    .select({
      id: socialConnections.id,
      status: socialConnections.status,
      username: socialConnections.username,
      profileUrl: socialConnections.profileUrl,
    })
    .from(socialConnections)
    .where(and(eq(socialConnections.userId, row.userId), eq(socialConnections.provider, "github")))
    .limit(1)
  let publicGitHub: PublicGitHub | null = null
  if (github && github.status !== "revoked") {
    const snapshot = (await latestSnapshotsFor(database, [github.id])).get(github.id)
    if (snapshot) {
      publicGitHub = {
        login: github.username,
        profileUrl: safeUrl(github.profileUrl),
        followers: snapshot.followers,
        current: github.status === "active",
        updatedAt: snapshot.takenAt,
        stats: publicGitHubStats(gitHubStatsFromRaw(snapshot.raw)),
      }
    }
  }

  return {
    handle: row.handle,
    displayName: row.displayName,
    bio: row.bio,
    skills: row.skills,
    stack: row.stack,
    availability: row.availability,
    dealPreference: row.dealPreference,
    verified: row.verifiedAt !== null,
    // Links are user input: only http(s) ever reaches an href.
    portfolio: portfolio.map((item) => ({ ...item, url: safeUrl(item.url) })),
    github: publicGitHub,
    memberSince: row.memberSince,
  }
}

/** GitHub stats with only http(s) repository links (the payload is provider data, still checked). */
function publicGitHubStats(stats: GitHubStats | null): GitHubStats | null {
  if (!stats) return null
  return {
    ...stats,
    topRepos: stats.topRepos.flatMap((repo) => {
      const url = safeUrl(repo.url)
      return url ? [{ ...repo, url }] : []
    }),
  }
}
