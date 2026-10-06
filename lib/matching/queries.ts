import "server-only"

import { and, asc, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  audienceSnapshots,
  builderProfiles,
  creatorProfiles,
  ideas,
  matches,
  products,
  savedItems,
  socialConnections,
  users,
  type Availability,
  type MatchFeatures,
  type MatchStatus,
  type ProductFormat,
  type ProductStage,
  type SizeTier,
  type TargetType,
} from "@/lib/db/schema"
import { CREATOR_SOCIAL_PROVIDERS, type SocialProviderId } from "@/lib/social/types"

import { loadActiveMatchingConfig, type ActiveMatchingConfig } from "./config"
import { explanationInput, templateExplanation, type ViewerRole } from "./explanation-text"
import { TARGET_TYPES_FOR_ROLE } from "./features"
import { MATCH_LIST_SIZE } from "./recompute"

/**
 * What Discover, Saved and the home page read (§12): a user's current matches with what each
 * target is, plus open briefs for builders. Targets are re-checked when read (a product archived
 * since the last recompute, a suspended owner), so a list never shows something its page would
 * refuse; the jobs stale such rows soon after anyway.
 */

type CardBase = { id: string; href: string; available: boolean }

export type ProductCard = CardBase & {
  type: "product"
  title: string
  format: ProductFormat
  stage: ProductStage
  priceCents: number | null
  currency: string
  topics: string[]
  ownerUserId: string
  ownerName: string
  ownerHandle: string
}

export type IdeaCard = CardBase & {
  type: "idea"
  title: string
  format: ProductFormat
  priceCents: number | null
  currency: string
  topics: string[]
  /** The start of the problem statement, as plain text. */
  excerpt: string | null
  ownerUserId: string
  ownerName: string
  ownerHandle: string
  sizeTier: SizeTier | null
  publishedAt: Date | null
}

export type BuilderCard = CardBase & {
  type: "builder"
  ownerUserId: string
  name: string
  handle: string
  bio: string | null
  skills: string[]
  stack: string[]
  availability: Availability
}

export type CreatorCard = CardBase & {
  type: "creator"
  ownerUserId: string
  name: string
  handle: string
  niche: string | null
  topics: string[]
  sizeTier: SizeTier | null
  /** The largest verified platform. */
  reach: { provider: SocialProviderId; followers: number } | null
}

export type TargetCard = ProductCard | IdeaCard | BuilderCard | CreatorCard

export type MatchView = {
  id: string
  status: MatchStatus
  score: number
  features: MatchFeatures
  /** The cached sentence, or the template for the same two features (never empty). */
  explanation: string
  modelVersion: string
  target: TargetCard
}

/** Plain text excerpt (Markdown markers and line breaks flattened). */
function excerpt(text: string | null, max = 180): string | null {
  if (!text) return null
  const plain = text
    .replace(/[#>*_`~[\]()!|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!plain) return null
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

export async function loadProductCards(
  database: DbOrTx,
  ids: readonly string[],
): Promise<Map<string, ProductCard>> {
  if (ids.length === 0) return new Map()
  const rows = await database
    .select({
      id: products.id,
      title: products.title,
      format: products.format,
      stage: products.stage,
      priceCents: products.targetPriceCents,
      currency: products.currency,
      topics: products.topics,
      status: products.status,
      ownerUserId: builderProfiles.userId,
      ownerName: builderProfiles.displayName,
      ownerHandle: builderProfiles.handle,
      ownerStatus: users.status,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(inArray(products.id, [...ids]))
  return new Map(
    rows.map(({ status, ownerStatus, ...row }) => [
      row.id,
      {
        ...row,
        type: "product" as const,
        href: `/app/products/${row.id}`,
        available: status === "seeking" && ownerStatus === "active",
      },
    ]),
  )
}

export async function loadIdeaCards(
  database: DbOrTx,
  ids: readonly string[],
): Promise<Map<string, IdeaCard>> {
  if (ids.length === 0) return new Map()
  const rows = await database
    .select({
      id: ideas.id,
      title: ideas.title,
      format: ideas.format,
      priceCents: ideas.targetPriceCents,
      currency: ideas.currency,
      topics: ideas.topics,
      problem: ideas.problem,
      status: ideas.status,
      publishedAt: ideas.publishedAt,
      ownerUserId: creatorProfiles.userId,
      ownerName: creatorProfiles.displayName,
      ownerHandle: creatorProfiles.handle,
      sizeTier: creatorProfiles.sizeTier,
      ownerStatus: users.status,
    })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .innerJoin(users, eq(users.id, creatorProfiles.userId))
    .where(inArray(ideas.id, [...ids]))
  return new Map(
    rows.map(({ status, ownerStatus, problem, ...row }) => [
      row.id,
      {
        ...row,
        type: "idea" as const,
        excerpt: excerpt(problem),
        href: `/app/ideas/${row.id}`,
        available: status === "open" && ownerStatus === "active",
      },
    ]),
  )
}

export async function loadBuilderCards(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, BuilderCard>> {
  if (userIds.length === 0) return new Map()
  const rows = await database
    .select({
      userId: builderProfiles.userId,
      name: builderProfiles.displayName,
      handle: builderProfiles.handle,
      bio: builderProfiles.bio,
      skills: builderProfiles.skills,
      stack: builderProfiles.stack,
      availability: builderProfiles.availability,
      status: users.status,
    })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(inArray(builderProfiles.userId, [...userIds]))
  return new Map(
    rows.map(({ status, userId, bio, ...row }) => [
      userId,
      {
        ...row,
        type: "builder" as const,
        id: userId,
        ownerUserId: userId,
        bio: excerpt(bio),
        href: `/b/${row.handle}`,
        available: status === "active" && row.availability !== "closed",
      },
    ]),
  )
}

export async function loadCreatorCards(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, CreatorCard>> {
  if (userIds.length === 0) return new Map()
  const [rows, reaches] = await Promise.all([
    database
      .select({
        userId: creatorProfiles.userId,
        name: creatorProfiles.displayName,
        handle: creatorProfiles.handle,
        niche: creatorProfiles.niche,
        topics: creatorProfiles.topics,
        sizeTier: creatorProfiles.sizeTier,
        status: users.status,
      })
      .from(creatorProfiles)
      .innerJoin(users, eq(users.id, creatorProfiles.userId))
      .where(inArray(creatorProfiles.userId, [...userIds])),
    database
      .selectDistinctOn([socialConnections.id], {
        userId: socialConnections.userId,
        provider: socialConnections.provider,
        followers: audienceSnapshots.followers,
      })
      .from(socialConnections)
      .innerJoin(audienceSnapshots, eq(audienceSnapshots.socialConnectionId, socialConnections.id))
      .where(
        and(
          inArray(socialConnections.userId, [...userIds]),
          inArray(socialConnections.provider, [...CREATOR_SOCIAL_PROVIDERS]),
          eq(socialConnections.status, "active"),
          sql`${socialConnections.verifiedAt} IS NOT NULL`,
        ),
      )
      .orderBy(
        asc(socialConnections.id),
        desc(audienceSnapshots.takenAt),
        desc(audienceSnapshots.id),
      ),
  ])
  const reachByUser = new Map<string, { provider: SocialProviderId; followers: number }>()
  for (const reach of reaches) {
    if (reach.followers === null) continue
    const current = reachByUser.get(reach.userId)
    if (!current || reach.followers > current.followers) {
      reachByUser.set(reach.userId, { provider: reach.provider, followers: reach.followers })
    }
  }
  return new Map(
    rows.map(({ status, userId, ...row }) => [
      userId,
      {
        ...row,
        type: "creator" as const,
        id: userId,
        ownerUserId: userId,
        href: `/c/${row.handle}`,
        reach: reachByUser.get(userId) ?? null,
        available: status === "active" && reachByUser.has(userId),
      },
    ]),
  )
}

/** Cards for mixed targets, keyed `<type>:<id>`. */
export async function loadTargetCards(
  database: DbOrTx,
  targets: readonly { targetType: TargetType; targetId: string }[],
): Promise<Map<string, TargetCard>> {
  const idsOf = (type: TargetType) =>
    targets.filter((target) => target.targetType === type).map((target) => target.targetId)
  const [productCards, ideaCards, builderCards, creatorCards] = await Promise.all([
    loadProductCards(database, idsOf("product")),
    loadIdeaCards(database, idsOf("idea")),
    loadBuilderCards(database, idsOf("builder")),
    loadCreatorCards(database, idsOf("creator")),
  ])
  const cards = new Map<string, TargetCard>()
  for (const [id, card] of productCards) cards.set(`product:${id}`, card)
  for (const [id, card] of ideaCards) cards.set(`idea:${id}`, card)
  for (const [id, card] of builderCards) cards.set(`builder:${id}`, card)
  for (const [id, card] of creatorCards) cards.set(`creator:${id}`, card)
  return cards
}

type MatchRow = {
  id: string
  targetType: TargetType
  targetId: string
  status: MatchStatus
  score: number
  features: MatchFeatures
  explanation: string | null
  modelVersion: string
}

function toViews(
  rows: readonly MatchRow[],
  cards: ReadonlyMap<string, TargetCard>,
  role: ViewerRole,
  config: ActiveMatchingConfig,
  options: { onlyAvailable: boolean },
): MatchView[] {
  const views: MatchView[] = []
  for (const row of rows) {
    const target = cards.get(`${row.targetType}:${row.targetId}`)
    if (!target) continue
    if (options.onlyAvailable && !target.available) continue
    views.push({
      id: row.id,
      status: row.status,
      score: row.score,
      features: row.features,
      modelVersion: row.modelVersion,
      explanation:
        row.explanation ??
        templateExplanation(explanationInput(role, row.targetType, row.features, config.weights)),
      target,
    })
  }
  return views
}

const matchColumns = {
  id: matches.id,
  targetType: matches.targetType,
  targetId: matches.targetId,
  status: matches.status,
  score: matches.score,
  features: matches.features,
  explanation: matches.explanation,
  modelVersion: matches.modelVersion,
}

/**
 * The user's current list for a role (or some of its target types), best first: rows of the
 * active model that are in the list (`stale_at IS NULL`) and shown or saved (§19.24), whose
 * target is still available.
 */
export async function listCurrentMatches(
  database: DbOrTx,
  userId: string,
  role: ViewerRole,
  options: {
    targetTypes?: readonly TargetType[]
    limit?: number
    config?: ActiveMatchingConfig
  } = {},
): Promise<MatchView[]> {
  const config = options.config ?? (await loadActiveMatchingConfig(database))
  const targetTypes = options.targetTypes ?? TARGET_TYPES_FOR_ROLE[role]
  const limit = options.limit ?? MATCH_LIST_SIZE * 2
  if (targetTypes.length === 0) return []
  const rows = await database
    .select(matchColumns)
    .from(matches)
    .where(
      and(
        eq(matches.subjectUserId, userId),
        eq(matches.modelVersion, config.modelVersion),
        inArray(matches.targetType, [...targetTypes]),
        isNull(matches.staleAt),
        inArray(matches.status, ["shown", "saved"]),
      ),
    )
    .orderBy(desc(matches.score), asc(matches.targetType), asc(matches.targetId))
    .limit(MATCH_LIST_SIZE * 2)
  const cards = await loadTargetCards(database, rows)
  return toViews(rows, cards, role, config, { onlyAvailable: true }).slice(0, limit)
}

/**
 * Saved items for a role (`saved_items`, newest first), each with its match row (the active
 * model's, else the newest) and its target; targets that are no longer open stay listed and say so.
 */
export async function listSavedMatches(
  database: DbOrTx,
  userId: string,
  role: ViewerRole,
  options: { config?: ActiveMatchingConfig } = {},
): Promise<MatchView[]> {
  const config = options.config ?? (await loadActiveMatchingConfig(database))
  const targetTypes = TARGET_TYPES_FOR_ROLE[role]
  const saved = await database
    .select({ targetType: savedItems.targetType, targetId: savedItems.targetId })
    .from(savedItems)
    .where(and(eq(savedItems.userId, userId), inArray(savedItems.targetType, [...targetTypes])))
    .orderBy(desc(savedItems.createdAt), desc(savedItems.id))
  if (saved.length === 0) return []
  const rows = await database
    .select({ ...matchColumns, computedAt: matches.computedAt })
    .from(matches)
    .where(
      and(
        eq(matches.subjectUserId, userId),
        inArray(
          matches.targetId,
          saved.map((item) => item.targetId),
        ),
        ne(matches.status, "dismissed"),
      ),
    )
  const best = new Map<string, MatchRow & { computedAt: Date }>()
  for (const row of rows) {
    const key = `${row.targetType}:${row.targetId}`
    const current = best.get(key)
    const better =
      !current ||
      (row.modelVersion === config.modelVersion && current.modelVersion !== config.modelVersion) ||
      ((row.modelVersion === config.modelVersion) ===
        (current.modelVersion === config.modelVersion) &&
        row.computedAt > current.computedAt)
    if (better) best.set(key, row)
  }
  const ordered = saved.flatMap((item) => {
    const row = best.get(`${item.targetType}:${item.targetId}`)
    return row ? [row] : []
  })
  const cards = await loadTargetCards(database, ordered)
  return toViews(ordered, cards, role, config, { onlyAvailable: false })
}

/** Open ideas a builder has no current match row for (Briefs "More open briefs"), newest first. */
export async function listOtherOpenBriefs(
  database: DbOrTx,
  builderUserId: string,
  options: { excludeIds?: readonly string[]; limit?: number; offset?: number } = {},
): Promise<{ items: IdeaCard[]; hasMore: boolean }> {
  const limit = options.limit ?? 20
  const exclude = options.excludeIds ?? []
  const rows = await database
    .select({ id: ideas.id })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .innerJoin(users, eq(users.id, creatorProfiles.userId))
    .where(
      and(
        eq(ideas.status, "open"),
        eq(users.status, "active"),
        ne(creatorProfiles.userId, builderUserId),
        exclude.length > 0
          ? sql`${ideas.id} NOT IN (${sql.join(
              exclude.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : undefined,
        notExists(
          database
            .select({ id: matches.id })
            .from(matches)
            .where(
              and(
                eq(matches.subjectUserId, builderUserId),
                eq(matches.targetType, "idea"),
                eq(matches.targetId, ideas.id),
                eq(matches.status, "dismissed"),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(ideas.publishedAt), desc(ideas.id))
    .limit(limit + 1)
    .offset(options.offset ?? 0)
  const cards = await loadIdeaCards(
    database,
    rows.slice(0, limit).map((row) => row.id),
  )
  const items = rows.slice(0, limit).flatMap((row) => {
    const card = cards.get(row.id)
    return card ? [card] : []
  })
  return { items, hasMore: rows.length > limit }
}

/** What the match actions need: who it belongs to and what it points at. */
export type MatchActionRow = {
  id: string
  subjectUserId: string
  targetType: TargetType
  targetId: string
  status: MatchStatus
  score: number
  modelVersion: string
}

export async function findMatchForAction(
  database: DbOrTx,
  matchId: string,
): Promise<MatchActionRow | null> {
  const [row] = await database
    .select({
      id: matches.id,
      subjectUserId: matches.subjectUserId,
      targetType: matches.targetType,
      targetId: matches.targetId,
      status: matches.status,
      score: matches.score,
      modelVersion: matches.modelVersion,
    })
    .from(matches)
    .where(eq(matches.id, matchId))
  return row ?? null
}

export async function findMatchesForAction(
  database: DbOrTx,
  matchIds: readonly string[],
): Promise<MatchActionRow[]> {
  if (matchIds.length === 0) return []
  return database
    .select({
      id: matches.id,
      subjectUserId: matches.subjectUserId,
      targetType: matches.targetType,
      targetId: matches.targetId,
      status: matches.status,
      score: matches.score,
      modelVersion: matches.modelVersion,
    })
    .from(matches)
    .where(inArray(matches.id, [...matchIds]))
}

/** Whether the user has any match row at all (to tell "not computed yet" from "nothing fits"). */
export async function hasAnyMatches(database: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.subjectUserId, userId))
    .limit(1)
  return row !== undefined
}
