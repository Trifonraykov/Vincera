import "server-only"

import { and, asc, count, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  audienceSnapshots,
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  disputes,
  ideas,
  portfolioItems,
  products,
  socialConnections,
  users,
  type ProductFormat,
} from "@/lib/db/schema"
import type { CountryShare } from "@/lib/db/schema/types"
import { CREATOR_SOCIAL_PROVIDERS } from "@/lib/social/types"

import type { BuilderFacts, CollabHistory, CreatorFacts, IdeaFacts, ProductFacts } from "./features"

/**
 * Batch loaders for the facts matching scores with (lib/matching/features.ts). Each takes a list
 * of user ids and returns a map, so a recompute or a target rescore loads a whole page of people
 * in a handful of queries. Only the inputs §8 names are read (CLAUDE.md §19.24 "Inputs"); vectors
 * stay in the database (the cosine is computed there).
 */

/** A person can be matched (as subject or target) only when this holds for the role (§19.24). */
export function eligiblePersonSql(role: "creator" | "builder") {
  return and(
    eq(users.status, "active"),
    isNotNull(users.onboardingCompletedAt),
    sql`${role} = ANY(${users.roles})`,
  )
}

/** "A verified connection" (§19.11): active, `verified_at` set, a creator platform. */
export function verifiedCreatorConnectionSql(userIdColumn: typeof creatorProfiles.userId) {
  return sql`EXISTS (
    SELECT 1 FROM ${socialConnections}
    WHERE ${socialConnections.userId} = ${userIdColumn}
      AND ${socialConnections.status} = 'active'
      AND ${socialConnections.verifiedAt} IS NOT NULL
      AND ${socialConnections.provider} IN (${sql.join(
        CREATOR_SOCIAL_PROVIDERS.map((provider) => sql`${provider}`),
        sql`, `,
      )})
  )`
}

function priceOf(cents: number | null, currency: string) {
  return cents === null ? null : { cents, currency }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const list = groups.get(id)
    if (list) list.push(row)
    else groups.set(id, [row])
  }
  return groups
}

/** Open ideas per creator (user id → ideas). */
async function openIdeasOf(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, IdeaFacts[]>> {
  const rows = await database
    .select({
      userId: creatorProfiles.userId,
      format: ideas.format,
      cents: ideas.targetPriceCents,
      currency: ideas.currency,
      topics: ideas.topics,
    })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(and(inArray(creatorProfiles.userId, [...userIds]), eq(ideas.status, "open")))
    .orderBy(asc(ideas.id))
  const grouped = groupBy(rows, (row) => row.userId)
  return new Map(
    [...grouped].map(([userId, list]) => [
      userId,
      list.map((row) => ({
        format: row.format,
        price: priceOf(row.cents, row.currency),
        topics: row.topics,
      })),
    ]),
  )
}

/** Seeking products per builder (user id → products). */
async function seekingProductsOf(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, ProductFacts[]>> {
  const rows = await database
    .select({
      userId: builderProfiles.userId,
      format: products.format,
      stage: products.stage,
      cents: products.targetPriceCents,
      currency: products.currency,
      topics: products.topics,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(and(inArray(builderProfiles.userId, [...userIds]), eq(products.status, "seeking")))
    .orderBy(asc(products.id))
  const grouped = groupBy(rows, (row) => row.userId)
  return new Map(
    [...grouped].map(([userId, list]) => [
      userId,
      list.map((row) => ({
        format: row.format,
        stage: row.stage,
        price: priceOf(row.cents, row.currency),
        topics: row.topics,
      })),
    ]),
  )
}

/**
 * The audience's countries per creator: the latest snapshot of their largest creator platform,
 * verified connections first (the size tier's rule, CLAUDE.md §19.14). Empty when unknown.
 */
async function audienceCountriesOf(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, CountryShare[]>> {
  const rows = await database
    .selectDistinctOn([socialConnections.id], {
      userId: socialConnections.userId,
      connectionId: socialConnections.id,
      verified: sql<boolean>`(${socialConnections.status} = 'active' AND ${socialConnections.verifiedAt} IS NOT NULL)`,
      followers: audienceSnapshots.followers,
      countries: audienceSnapshots.topCountries,
    })
    .from(socialConnections)
    .innerJoin(audienceSnapshots, eq(audienceSnapshots.socialConnectionId, socialConnections.id))
    .where(
      and(
        inArray(socialConnections.userId, [...userIds]),
        inArray(socialConnections.provider, [...CREATOR_SOCIAL_PROVIDERS]),
        ne(socialConnections.status, "revoked"),
      ),
    )
    .orderBy(asc(socialConnections.id), desc(audienceSnapshots.takenAt), desc(audienceSnapshots.id))

  const best = new Map<
    string,
    { verified: boolean; followers: number; countries: CountryShare[] }
  >()
  for (const row of rows) {
    const candidate = {
      verified: row.verified,
      followers: row.followers ?? -1,
      countries: row.countries ?? [],
    }
    const current = best.get(row.userId)
    if (
      !current ||
      (candidate.verified && !current.verified) ||
      (candidate.verified === current.verified && candidate.followers > current.followers)
    ) {
      best.set(row.userId, candidate)
    }
  }
  return new Map([...best].map(([userId, value]) => [userId, value.countries]))
}

export type CreatorFactsRow = CreatorFacts & {
  profileId: string
  /** Active, onboarded, has the role and the profile (§19.24). */
  eligible: boolean
  /** Has an active, verified creator connection (builders only see such creators, §8). */
  verified: boolean
}

/** Creator facts for the given users (only users with a creator profile appear). */
export async function loadCreatorFacts(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, CreatorFactsRow>> {
  if (userIds.length === 0) return new Map()
  const profiles = await database
    .select({
      userId: creatorProfiles.userId,
      profileId: creatorProfiles.id,
      topics: creatorProfiles.topics,
      languages: creatorProfiles.languages,
      sizeTier: creatorProfiles.sizeTier,
      eligible: sql<boolean>`(${eligiblePersonSql("creator")})`,
      verified: sql<boolean>`${verifiedCreatorConnectionSql(creatorProfiles.userId)}`,
    })
    .from(creatorProfiles)
    .innerJoin(users, eq(users.id, creatorProfiles.userId))
    .where(inArray(creatorProfiles.userId, [...userIds]))
  // One query at a time: `database` may be a transaction (one connection).
  const ideasByUser = await openIdeasOf(database, userIds)
  const countriesByUser = await audienceCountriesOf(database, userIds)
  return new Map(
    profiles.map((profile) => [
      profile.userId,
      {
        userId: profile.userId,
        profileId: profile.profileId,
        eligible: Boolean(profile.eligible),
        verified: Boolean(profile.verified),
        topics: profile.topics,
        languages: profile.languages,
        audienceCountries: countriesByUser.get(profile.userId) ?? [],
        sizeTier: profile.sizeTier,
        ideas: ideasByUser.get(profile.userId) ?? [],
      },
    ]),
  )
}

export type BuilderFactsRow = BuilderFacts & {
  profileId: string
  eligible: boolean
  /** `availability <> 'closed'` (creators only see such builders, §8). */
  available: boolean
}

/** Builder facts for the given users (only users with a builder profile appear). */
export async function loadBuilderFacts(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, BuilderFactsRow>> {
  if (userIds.length === 0) return new Map()
  const profiles = await database
    .select({
      userId: builderProfiles.userId,
      profileId: builderProfiles.id,
      skills: builderProfiles.skills,
      stack: builderProfiles.stack,
      availability: builderProfiles.availability,
      eligible: sql<boolean>`(${eligiblePersonSql("builder")})`,
      // Builder profiles have no languages or country; a builder who is also a creator has them.
      languages: creatorProfiles.languages,
      country: creatorProfiles.country,
    })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .leftJoin(creatorProfiles, eq(creatorProfiles.userId, builderProfiles.userId))
    .where(inArray(builderProfiles.userId, [...userIds]))
  const shipped = await database
    .selectDistinct({ userId: builderProfiles.userId, format: portfolioItems.format })
    .from(portfolioItems)
    .innerJoin(builderProfiles, eq(builderProfiles.id, portfolioItems.builderProfileId))
    .where(
      and(
        inArray(builderProfiles.userId, [...userIds]),
        eq(portfolioItems.isShipped, true),
        isNotNull(portfolioItems.format),
      ),
    )
  const productsByUser = await seekingProductsOf(database, userIds)
  const shippedByUser = groupBy(shipped, (row) => row.userId)
  return new Map(
    profiles.map((profile) => [
      profile.userId,
      {
        userId: profile.userId,
        profileId: profile.profileId,
        eligible: Boolean(profile.eligible),
        available: profile.availability !== "closed",
        skills: profile.skills,
        stack: profile.stack,
        shippedFormats: (shippedByUser.get(profile.userId) ?? []).flatMap((row) =>
          row.format ? [row.format as ProductFormat] : [],
        ),
        products: productsByUser.get(profile.userId) ?? [],
        languages: profile.languages ?? [],
        country: profile.country ?? null,
      },
    ]),
  )
}

/**
 * Collab history per user (§8 `reliability`): collabs that went live or ended `completed`, and
 * disputes raised against them by another member of the same collab.
 */
export async function loadCollabHistory(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, CollabHistory>> {
  const history = new Map<string, CollabHistory>(
    userIds.map((userId) => [userId, { completed: 0, disputes: 0 }]),
  )
  if (userIds.length === 0) return history
  const completed = await database
    .select({ userId: collabMembers.userId, total: count() })
    .from(collabMembers)
    .innerJoin(collabs, eq(collabs.id, collabMembers.collabId))
    .where(
      and(
        inArray(collabMembers.userId, [...userIds]),
        or(
          eq(collabs.stage, "live"),
          and(eq(collabs.stage, "ended"), eq(collabs.endedReason, "completed")),
        ),
      ),
    )
    .groupBy(collabMembers.userId)
  const disputed = await database
    .select({ userId: collabMembers.userId, total: count() })
    .from(disputes)
    .innerJoin(collabMembers, eq(collabMembers.collabId, disputes.collabId))
    .where(
      and(
        inArray(collabMembers.userId, [...userIds]),
        ne(disputes.raisedByUserId, collabMembers.userId),
      ),
    )
    .groupBy(collabMembers.userId)
  for (const row of completed) {
    const entry = history.get(row.userId)
    if (entry) entry.completed = row.total
  }
  for (const row of disputed) {
    const entry = history.get(row.userId)
    if (entry) entry.disputes = row.total
  }
  return history
}
