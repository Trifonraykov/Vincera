import "server-only"

import { eq } from "drizzle-orm"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { audienceSnapshots, socialConnections, stripeAccounts } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { upsertOAuthConnection } from "@/lib/social/connections"
import { recomputeSizeTier } from "@/lib/social/derived"
import { githubRawSchema, youtubeRawSchema } from "@/lib/social/raw"
import { deriveTopics } from "@/lib/social/topics"
import {
  audienceSnapshotInputSchema,
  type AudienceSnapshotInput,
  type SocialProviderId,
  type TokenSet,
} from "@/lib/social/types"

import type { SeedBuilder, SeedCreator } from "./data"

/**
 * Connected accounts and payouts for seeded people, written through the app's own functions:
 * `upsertOAuthConnection` (encrypted tokens, `social.connected`, size tier) and the same snapshot
 * write as a sync (`social.synced`, size tier). The snapshot payloads are built from the persona
 * and checked with the providers' own raw schemas.
 *
 * Seed connections hold a placeholder token no provider accepts and never expires: syncs are only
 * scheduled by the cron (never inline), and a "Resync" (or a live Inngest's daily sync) marks
 * the connection expired like any revoked token, which is the honest outcome for demo data.
 */

const DAY_MS = 24 * 60 * 60 * 1000

function seedTokens(provider: SocialProviderId, accountId: string): TokenSet {
  return {
    accessToken: `seed-${provider}-${accountId}`,
    refreshToken: null,
    expiresAt: null,
    refreshExpiresAt: null,
    scopes:
      provider === "youtube"
        ? [
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/auth/yt-analytics.readonly",
          ]
        : [],
    providerAccountId: accountId,
    obtainedAt: now(),
  }
}

/** A creator's YouTube snapshot: subscribers, views, viewer countries and ages, recent titles. */
export function youtubeSnapshot(persona: SeedCreator, channelId: string): AudienceSnapshotInput {
  const at = now()
  const recentVideos = persona.videoTitles.map((title, index) => {
    const views = Math.round(persona.avgViews * (1.25 - index * 0.15))
    return {
      id: `${channelId}-v${index + 1}`,
      title,
      publishedAt: new Date(at.getTime() - (index + 1) * 6 * DAY_MS).toISOString(),
      durationSeconds: 420 + index * 90,
      views,
      likes: Math.round(views * persona.engagementRate * 0.85),
      comments: Math.round(views * persona.engagementRate * 0.15),
    }
  })
  const end = new Date(at.getTime() - DAY_MS)
  const start = new Date(end.getTime() - 89 * DAY_MS)
  const raw = youtubeRawSchema.parse({
    provider: "youtube",
    v: 1,
    channel: {
      id: channelId,
      title: persona.name,
      customUrl: `@${persona.handle}`,
      country: persona.country,
      publishedAt: new Date(at.getTime() - 4 * 365 * DAY_MS).toISOString(),
      subscriberCount: persona.followers,
      hiddenSubscriberCount: false,
      viewCount: persona.avgViews * 220,
      videoCount: 180,
    },
    recentVideos,
    analytics: {
      available: true,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      totals: {
        views: persona.avgViews * 26,
        engagedViews: Math.round(persona.avgViews * 26 * 0.7),
        estimatedMinutesWatched: persona.avgViews * 26 * 4,
        averageViewDuration: 245,
        likes: Math.round(persona.avgViews * 26 * persona.engagementRate * 0.85),
        comments: Math.round(persona.avgViews * 26 * persona.engagementRate * 0.15),
        shares: Math.round(persona.avgViews * 26 * 0.004),
        subscribersGained: Math.round(persona.followers * 0.04),
        subscribersLost: Math.round(persona.followers * 0.008),
      },
    },
  })
  const ageGroups = ["18-24", "25-34", "35-44", "45-54"] as const
  const buckets = ageGroups.flatMap((ageGroup, index) => {
    const ageShare = persona.ages[index] ?? 0
    return [
      { ageGroup, gender: "female" as const, share: round4(ageShare * persona.femaleShare) },
      { ageGroup, gender: "male" as const, share: round4(ageShare * (1 - persona.femaleShare)) },
    ]
  })
  return audienceSnapshotInputSchema.parse({
    followers: persona.followers,
    avgViews: persona.avgViews,
    engagementRate: persona.engagementRate,
    topCountries: persona.countries,
    countriesBasis: "viewers",
    ageGender: { basis: "viewers", buckets },
    topTopics: deriveTopics(recentVideos.map((video) => ({ text: video.title }))),
    raw,
  })
}

/** A builder's GitHub snapshot: followers and top languages, plus repository stats in `raw`. */
export function githubSnapshot(persona: SeedBuilder): AudienceSnapshotInput {
  const at = now()
  const { github } = persona
  const totalBytes = 2_000_000
  const raw = githubRawSchema.parse({
    provider: "github",
    v: 1,
    login: github.login,
    publicRepos: github.publicRepos,
    totalStars: github.totalStars,
    totalForks: github.totalForks,
    topLanguages: github.languages.map((language) => ({
      name: language.name,
      bytes: Math.round(totalBytes * language.share),
      share: language.share,
    })),
    topRepos: persona.portfolio.map((item, index) => ({
      name: item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      url: `https://github.com/${github.login}/${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      stars: Math.round(github.totalStars / (index + 2)),
      forks: Math.round(github.totalForks / (index + 2)),
      language: github.languages[0]?.name ?? null,
      pushedAt: new Date(at.getTime() - (index + 1) * 9 * DAY_MS).toISOString(),
      archived: false,
    })),
    contributions: {
      from: new Date(at.getTime() - 365 * DAY_MS).toISOString(),
      to: at.toISOString(),
      total: github.contributions,
      commits: Math.round(github.contributions * 0.7),
      issues: Math.round(github.contributions * 0.08),
      pullRequests: Math.round(github.contributions * 0.12),
      reviews: Math.round(github.contributions * 0.06),
      repositories: Math.max(1, Math.round(github.publicRepos / 4)),
      restricted: Math.round(github.contributions * 0.04),
    },
  })
  return audienceSnapshotInputSchema.parse({
    followers: github.followers,
    avgViews: null,
    engagementRate: null,
    topCountries: [],
    countriesBasis: null,
    ageGender: null,
    topTopics: github.languages.map((language) => language.name.toLowerCase()),
    raw,
  })
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Connect a provider account for a seeded person and store one snapshot, like an OAuth callback
 * followed by a sync. Returns the connection id.
 */
export async function connectSeedAccount(
  database: DbOrTx,
  input: {
    userId: string
    provider: SocialProviderId
    accountId: string
    username: string
    displayName: string
    profileUrl: string
    snapshot: AudienceSnapshotInput
  },
): Promise<string> {
  const { connection } = await upsertOAuthConnection(database, {
    userId: input.userId,
    provider: input.provider,
    tokens: seedTokens(input.provider, input.accountId),
    profile: {
      providerAccountId: input.accountId,
      username: input.username,
      displayName: input.displayName,
      avatarUrl: null,
      profileUrl: input.profileUrl,
      followers: input.snapshot.followers,
      bio: null,
    },
  })
  await withTransaction(async (tx) => {
    const takenAt = now()
    const [snapshot] = await tx
      .insert(audienceSnapshots)
      .values({ socialConnectionId: connection.id, takenAt, ...input.snapshot })
      .returning({ id: audienceSnapshots.id })
    if (!snapshot) throw new Error("connectSeedAccount: no snapshot")
    await tx
      .update(socialConnections)
      .set({ lastSyncedAt: takenAt })
      .where(eq(socialConnections.id, connection.id))
    const tier = await recomputeSizeTier(tx, input.userId)
    await track(
      "social.synced",
      {
        actorUserId: null,
        subjectType: "social_connection",
        subjectId: connection.id,
        properties: {
          provider: input.provider,
          snapshot_id: snapshot.id,
          followers: input.snapshot.followers,
          size_tier: tier.profileId ? tier.tier : null,
        },
      },
      tx,
    )
  }, database)
  return connection.id
}

/**
 * A payouts-ready Stripe account row (a fake `acct_seed_…` id; the fake Stripe store has no file
 * for it, which pages tolerate: they only re-fetch accounts that are not ready yet).
 */
export async function seedPayoutsAccount(
  database: DbOrTx,
  input: { userId: string; accountId: string; country: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(stripeAccounts)
      .values({
        userId: input.userId,
        stripeAccountId: input.accountId,
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        transfersCapability: "active",
        country: input.country,
        updatedFromStripeAt: now(),
      })
      .onConflictDoNothing()
      .returning({ id: stripeAccounts.id, country: stripeAccounts.country })
    if (!row) return
    await track(
      "payouts.account_created",
      {
        actorUserId: input.userId,
        subjectType: "stripe_account",
        subjectId: row.id,
        properties: { country: row.country },
      },
      tx,
    )
  }, database)
}
