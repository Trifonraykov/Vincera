import "server-only"

import { and, asc, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, matches, products, savedItems, users } from "@/lib/db/schema"
import { toListingCard, type ListingCard, type ListingCardRow } from "@/lib/listings/cards"
import { loadActiveMatchingConfig } from "@/lib/matching/config"

/**
 * The creator feed (CLAUDE.md §19.45): every open listing (`seeking`, still in its store, an
 * active builder, not the viewer's own, not dismissed by the viewer), best match first, then
 * newest. Ranked by the viewer's current match score where matching scored the listing (the
 * active model's row in the viewer's list), then by `published_at`; keyset pagination over
 * (rank score, published_at, id) so pages never repeat or skip while new listings arrive.
 */

export const FEED_PAGE_SIZE = 12

export type FeedItem = ListingCard & {
  saved: boolean
  /** The viewer's match row for this listing, when matching scored it. */
  matchId: string | null
  score: number | null
  publishedAt: string
}

export type FeedPage = { items: FeedItem[]; nextCursor: string | null }

type Cursor = { score: number; publishedAt: string; id: string }

export function encodeFeedCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.score, cursor.publishedAt, cursor.id])).toString(
    "base64url",
  )
}

export function decodeFeedCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 300) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(value) || value.length !== 3) return null
    const [score, publishedAt, id] = value as unknown[]
    if (typeof score !== "number" || !Number.isFinite(score)) return null
    if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) return null
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null
    return { score, publishedAt, id }
  } catch {
    return null
  }
}

/** Rank: the match score (0–1) when matching scored it, else −1 (after every scored one). */
function rankScore(): SQL<number> {
  return sql<number>`coalesce(${matches.score}, -1)::float8`
}

function feedSelection() {
  return {
    id: products.id,
    title: products.title,
    description: products.description,
    tagline: products.tagline,
    format: products.format,
    source: products.source,
    sourceMeta: products.sourceMeta,
    media: products.media,
    publishedAtText: sql<string>`to_char(${products.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    builderUserId: builderProfiles.userId,
    builderHandle: builderProfiles.handle,
    builderDisplayName: builderProfiles.displayName,
    builderAppStoreVerified: sql<boolean>`(${builderProfiles.appStoreVerifiedAt} IS NOT NULL)`,
    matchId: matches.id,
    score: matches.score,
    rank: rankScore(),
    saved: sql<boolean>`(${savedItems.id} IS NOT NULL)`,
  }
}

type FeedRow = Omit<ListingCardRow, "sourceMeta" | "media"> & {
  sourceMeta: ListingCardRow["sourceMeta"]
  media: ListingCardRow["media"]
  publishedAtText: string
  matchId: string | null
  score: number | null
  rank: number
  saved: boolean
}

function toFeedItem(row: FeedRow): FeedItem {
  return {
    ...toListingCard(row),
    saved: row.saved,
    matchId: row.matchId,
    score: row.score,
    publishedAt: row.publishedAtText,
  }
}

/** Listings a feed may show, as a WHERE clause. */
function visibleTo(viewerId: string): SQL {
  return and(
    eq(products.status, "seeking"),
    isNull(products.sourceRemovedAt),
    eq(users.status, "active"),
    isNull(users.deletedAt),
    ne(builderProfiles.userId, viewerId),
    sql`NOT EXISTS (
      SELECT 1 FROM ${matches} AS dismissed
      WHERE dismissed.subject_user_id = ${viewerId}
        AND dismissed.target_type = 'product'
        AND dismissed.target_id = ${products.id}
        AND dismissed.status = 'dismissed'
    )`,
  ) as SQL
}

function baseQuery(database: DbOrTx, viewerId: string, modelVersion: string) {
  return database
    .select(feedSelection())
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .leftJoin(
      matches,
      and(
        eq(matches.subjectUserId, viewerId),
        eq(matches.targetType, "product"),
        eq(matches.targetId, products.id),
        eq(matches.modelVersion, modelVersion),
        isNull(matches.staleAt),
        sql`${matches.status} IN ('shown', 'saved', 'proposed')`,
      ),
    )
    .leftJoin(
      savedItems,
      and(
        eq(savedItems.userId, viewerId),
        eq(savedItems.targetType, "product"),
        eq(savedItems.targetId, products.id),
      ),
    )
}

/** One page of the feed for `viewerId`. */
export async function listFeed(
  database: DbOrTx,
  input: { viewerId: string; cursor?: string | null; limit?: number },
): Promise<FeedPage> {
  const limit = Math.min(Math.max(input.limit ?? FEED_PAGE_SIZE, 1), 50)
  const config = await loadActiveMatchingConfig(database)
  const cursor = decodeFeedCursor(input.cursor)
  const after = cursor
    ? sql`(${rankScore()}, ${products.publishedAt}, ${products.id}) < (${cursor.score}::float8, ${cursor.publishedAt}::timestamptz, ${cursor.id}::uuid)`
    : undefined
  const rows = (await baseQuery(database, input.viewerId, config.modelVersion)
    .where(and(visibleTo(input.viewerId), after))
    .orderBy(desc(rankScore()), desc(products.publishedAt), desc(products.id))
    .limit(limit + 1)) as FeedRow[]
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(toFeedItem),
    nextCursor:
      rows.length > limit && last
        ? encodeFeedCursor({ score: last.rank, publishedAt: last.publishedAtText, id: last.id })
        : null,
  }
}

export type FeedListingDetail = FeedItem & {
  description: string | null
  demoUrl: string | null
  sourceUrl: string | null
  builder: FeedItem["builder"] & {
    bio: string | null
    skills: string[]
    listingCount: number
  }
}

/** One listing as the feed's detail view shows it, or null when the viewer may not see it. */
export async function findFeedListing(
  database: DbOrTx,
  input: { viewerId: string; productId: string },
): Promise<FeedListingDetail | null> {
  const config = await loadActiveMatchingConfig(database)
  const [row] = (await baseQuery(database, input.viewerId, config.modelVersion)
    .where(and(visibleTo(input.viewerId), eq(products.id, input.productId)))
    .limit(1)) as FeedRow[]
  if (!row) return null
  const [extra] = await database
    .select({
      description: products.description,
      demoUrl: products.demoUrl,
      sourceUrl: products.sourceUrl,
      bio: builderProfiles.bio,
      skills: builderProfiles.skills,
      listingCount: sql<number>`(
        SELECT count(*)::int FROM ${products} AS own
        WHERE own.builder_profile_id = ${builderProfiles.id}
          AND own.status = 'seeking' AND own.source_removed_at IS NULL
      )`,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(products.id, input.productId))
  if (!extra) return null
  const item = toFeedItem(row)
  return {
    ...item,
    description: extra.description,
    demoUrl: extra.demoUrl,
    sourceUrl: extra.sourceUrl,
    builder: {
      ...item.builder,
      bio: extra.bio,
      skills: extra.skills,
      listingCount: extra.listingCount,
    },
  }
}

/** The viewer's match row for a listing (any status but dismissed), for the feed's events. */
export async function feedMatchFor(
  database: DbOrTx,
  input: { viewerId: string; productId: string },
): Promise<{ id: string } | null> {
  const config = await loadActiveMatchingConfig(database)
  const [row] = await database
    .select({ id: matches.id })
    .from(matches)
    .where(
      and(
        eq(matches.subjectUserId, input.viewerId),
        eq(matches.targetType, "product"),
        eq(matches.targetId, input.productId),
        eq(matches.modelVersion, config.modelVersion),
        ne(matches.status, "dismissed"),
      ),
    )
    .orderBy(asc(matches.computedAt))
    .limit(1)
  return row ?? null
}
