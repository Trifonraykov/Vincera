import { z } from "zod"

import type { SocialProviderId } from "./types"

/**
 * `audience_snapshots.raw` per provider (§5): the compact provider data worth keeping next to the
 * typed snapshot columns. Providers build `raw` with these schemas and readers parse it back with
 * them (jsonb is not validated by the database), so writer and reader cannot drift. Client-safe.
 *
 * Rules: JSON only (null, never undefined; ISO strings for dates), no tokens, no URLs carrying
 * credentials, no viewer personal data. `v` is bumped when a shape changes incompatibly; readers
 * return null for versions they do not know.
 *
 * GitHub (builders) has no audience in the creator sense: its snapshot's typed columns hold
 * followers and top languages (`top_topics`); stars, repositories, languages and contribution
 * counts live in `raw` and are read with `gitHubStatsFromRaw()`.
 */

const count = z.number().int().nonnegative()
const nullableCount = count.nullable()
const isoDateTime = z.iso.datetime({ offset: true })

export const youtubeRawSchema = z.object({
  provider: z.literal("youtube"),
  v: z.literal(1),
  channel: z.object({
    id: z.string(),
    title: z.string().nullable(),
    customUrl: z.string().nullable(),
    country: z.string().nullable(),
    publishedAt: isoDateTime.nullable(),
    /** Rounded by YouTube to 3 significant figures; null when hidden. */
    subscriberCount: nullableCount,
    hiddenSubscriberCount: z.boolean(),
    viewCount: nullableCount,
    videoCount: nullableCount,
  }),
  /** The videos avg_views and engagement_rate were computed from (newest first). */
  recentVideos: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      publishedAt: isoDateTime.nullable(),
      durationSeconds: nullableCount,
      views: count,
      likes: nullableCount,
      comments: nullableCount,
    }),
  ),
  analytics: z.discriminatedUnion("available", [
    z.object({
      available: z.literal(true),
      startDate: z.iso.date(),
      endDate: z.iso.date(),
      /** Channel totals over the window; `views` and `engagedViews` both kept (§19.10). */
      totals: z.object({
        views: nullableCount,
        engagedViews: nullableCount,
        estimatedMinutesWatched: nullableCount,
        averageViewDuration: nullableCount,
        likes: nullableCount,
        comments: nullableCount,
        shares: nullableCount,
        subscribersGained: nullableCount,
        subscribersLost: nullableCount,
      }),
    }),
    z.object({
      available: z.literal(false),
      reason: z.enum(["scope_not_granted", "forbidden"]),
    }),
  ]),
})
export type YouTubeRaw = z.infer<typeof youtubeRawSchema>

export const instagramRawSchema = z.object({
  provider: z.literal("instagram"),
  v: z.literal(1),
  account: z.object({
    userId: z.string(),
    username: z.string().nullable(),
    accountType: z.string().nullable(),
    followersCount: nullableCount,
    followsCount: nullableCount,
    mediaCount: nullableCount,
  }),
  /** Recent posts; insight fields are null when insights were unavailable for the post. */
  recentMedia: z.array(
    z.object({
      id: z.string(),
      mediaType: z.string().nullable(),
      productType: z.string().nullable(),
      timestamp: isoDateTime.nullable(),
      caption: z.string().nullable(),
      likes: nullableCount,
      comments: nullableCount,
      views: nullableCount,
      reach: nullableCount,
      shares: nullableCount,
      saved: nullableCount,
    }),
  ),
  insights: z.object({
    available: z.boolean(),
    /** Posts whose insights request failed (tolerated, §19.10). */
    failedMedia: count,
  }),
  demographics: z.discriminatedUnion("available", [
    z.object({ available: z.literal(true), totalFollowersCounted: count }),
    z.object({
      available: z.literal(false),
      reason: z.enum(["below_minimum", "scope_not_granted", "unavailable"]),
    }),
  ]),
})
export type InstagramRaw = z.infer<typeof instagramRawSchema>

export const tiktokRawSchema = z.object({
  provider: z.literal("tiktok"),
  v: z.literal(1),
  user: z.object({
    openId: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    isVerified: z.boolean().nullable(),
    followerCount: nullableCount,
    followingCount: nullableCount,
    likesCount: nullableCount,
    videoCount: nullableCount,
  }),
  recentVideos: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      createdAt: isoDateTime.nullable(),
      durationSeconds: nullableCount,
      views: nullableCount,
      likes: nullableCount,
      comments: nullableCount,
      shares: nullableCount,
    }),
  ),
  /** Scope-gated parts that were skipped because the user did not grant them. */
  missingScopes: z.array(z.string()),
})
export type TikTokRaw = z.infer<typeof tiktokRawSchema>

export const githubRawSchema = z.object({
  provider: z.literal("github"),
  v: z.literal(1),
  login: z.string(),
  /** Owned, public, non-fork repositories. */
  publicRepos: count,
  totalStars: count,
  totalForks: count,
  /** By bytes of code across the counted repositories, largest first (≤ 8). */
  topLanguages: z.array(
    z.object({ name: z.string(), bytes: count, share: z.number().min(0).max(1) }),
  ),
  /** Most-starred repositories (≤ 10). */
  topRepos: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      stars: count,
      forks: count,
      language: z.string().nullable(),
      pushedAt: isoDateTime.nullable(),
      archived: z.boolean(),
    }),
  ),
  /** `contributionsCollection` over the last 365 days. */
  contributions: z.object({
    from: isoDateTime,
    to: isoDateTime,
    total: count,
    commits: count,
    issues: count,
    pullRequests: count,
    reviews: count,
    repositories: count,
    /** Contributions to private repositories (counts only, no details). */
    restricted: count,
  }),
})
export type GitHubRaw = z.infer<typeof githubRawSchema>

export const snapshotRawSchemas = {
  youtube: youtubeRawSchema,
  instagram: instagramRawSchema,
  tiktok: tiktokRawSchema,
  github: githubRawSchema,
} as const satisfies Record<SocialProviderId, z.ZodType>

export type SnapshotRawByProvider = {
  youtube: YouTubeRaw
  instagram: InstagramRaw
  tiktok: TikTokRaw
  github: GitHubRaw
}

/** A snapshot's raw payload, typed; null when it is missing, malformed or of another version. */
export function parseSnapshotRaw<P extends SocialProviderId>(
  provider: P,
  raw: unknown,
): SnapshotRawByProvider[P] | null {
  const parsed = snapshotRawSchemas[provider].safeParse(raw)
  return parsed.success ? (parsed.data as SnapshotRawByProvider[P]) : null
}

/** Builder stats from a GitHub snapshot's raw payload (null when it is not a v1 GitHub payload). */
export type GitHubStats = Omit<GitHubRaw, "provider" | "v">

export function gitHubStatsFromRaw(raw: unknown): GitHubStats | null {
  const parsed = parseSnapshotRaw("github", raw)
  if (!parsed) return null
  const { provider: _provider, v: _v, ...stats } = parsed
  return stats
}

/**
 * Titles/captions of recent content, newest first, for the audience summary prompt. Public
 * content only; the prompt treats it as untrusted data.
 */
export function recentContentTitles(provider: SocialProviderId, raw: unknown, max = 10): string[] {
  switch (provider) {
    case "youtube":
      return (parseSnapshotRaw("youtube", raw)?.recentVideos ?? [])
        .flatMap((video) => (video.title ? [video.title] : []))
        .slice(0, max)
    case "instagram":
      return (parseSnapshotRaw("instagram", raw)?.recentMedia ?? [])
        .flatMap((media) => (media.caption ? [media.caption] : []))
        .slice(0, max)
    case "tiktok":
      return (parseSnapshotRaw("tiktok", raw)?.recentVideos ?? [])
        .flatMap((video) => (video.title ? [video.title] : []))
        .slice(0, max)
    case "github":
      return (parseSnapshotRaw("github", raw)?.topRepos ?? [])
        .map((repo) => repo.name)
        .slice(0, max)
  }
}
