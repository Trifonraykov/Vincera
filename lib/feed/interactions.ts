import "server-only"

import { and, eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { savedItems } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import {
  markMatchesShown,
  recordMatchClick,
  saveMatch,
  unsaveMatch,
} from "@/lib/matching/interactions"
import type { ListingSurface } from "@/lib/events/types"

import { feedMatchFor, findFeedListing } from "./queries"

/**
 * What a creator does in the feed (CLAUDE.md §19.45). Where matching scored the listing for them,
 * the existing match events are written (`match.shown`, `match.clicked`, `match.saved`,
 * `match.unsaved`: same rows, same rules as Discover); otherwise the feed's own events
 * (`listing.opened`, `listing.saved`, `listing.unsaved`), plus one `feed.viewed` per page.
 * Saving always uses `saved_items` (target `product`), so Discover's Saved tab lists feed saves too.
 */

export const FEED_MESSAGES = {
  notFound: "This listing is no longer available.",
} as const

async function requireVisible(database: DbOrTx, viewerId: string, productId: string) {
  const listing = await findFeedListing(database, { viewerId, productId })
  if (!listing) throw new ActionError(FEED_MESSAGES.notFound)
  return listing
}

export async function saveFeedListing(
  database: DbOrTx,
  input: { userId: string; productId: string; rank: number | null; surface?: ListingSurface },
): Promise<{ saved: true; changed: boolean }> {
  await requireVisible(database, input.userId, input.productId)
  const match = await feedMatchFor(database, { viewerId: input.userId, productId: input.productId })
  if (match) {
    const result = await saveMatch(database, {
      userId: input.userId,
      matchId: match.id,
      rank: input.rank,
    })
    return { saved: true, changed: result.changed }
  }
  return withTransaction(async (tx) => {
    const inserted = await tx
      .insert(savedItems)
      .values({ userId: input.userId, targetType: "product", targetId: input.productId })
      .onConflictDoNothing()
      .returning({ id: savedItems.id })
    if (inserted.length > 0) {
      await track(
        "listing.saved",
        {
          actorUserId: input.userId,
          subjectType: "product",
          subjectId: input.productId,
          properties: { surface: input.surface ?? "feed", rank: input.rank },
        },
        tx,
      )
    }
    return { saved: true as const, changed: inserted.length > 0 }
  }, database)
}

export async function unsaveFeedListing(
  database: DbOrTx,
  input: { userId: string; productId: string; rank: number | null; surface?: ListingSurface },
): Promise<{ saved: false; changed: boolean }> {
  const match = await feedMatchFor(database, { viewerId: input.userId, productId: input.productId })
  if (match) {
    const result = await unsaveMatch(database, {
      userId: input.userId,
      matchId: match.id,
      rank: input.rank,
    })
    return { saved: false, changed: result.changed }
  }
  return withTransaction(async (tx) => {
    const deleted = await tx
      .delete(savedItems)
      .where(
        and(
          eq(savedItems.userId, input.userId),
          eq(savedItems.targetType, "product"),
          eq(savedItems.targetId, input.productId),
        ),
      )
      .returning({ id: savedItems.id })
    if (deleted.length > 0) {
      await track(
        "listing.unsaved",
        {
          actorUserId: input.userId,
          subjectType: "product",
          subjectId: input.productId,
          properties: { surface: input.surface ?? "feed", rank: input.rank },
        },
        tx,
      )
    }
    return { saved: false as const, changed: deleted.length > 0 }
  }, database)
}

/** The listing was opened (detail page or sheet). */
export async function recordFeedOpen(
  database: DbOrTx,
  input: { userId: string; productId: string; rank: number | null; surface?: ListingSurface },
): Promise<void> {
  await requireVisible(database, input.userId, input.productId)
  const match = await feedMatchFor(database, { viewerId: input.userId, productId: input.productId })
  if (match) {
    await recordMatchClick(database, { userId: input.userId, matchId: match.id, rank: input.rank })
    return
  }
  await track(
    "listing.opened",
    {
      actorUserId: input.userId,
      subjectType: "product",
      subjectId: input.productId,
      properties: { surface: input.surface ?? "feed", rank: input.rank, matched: false },
    },
    database,
  )
}

/**
 * A feed page was on screen: `match.shown` once per match row (the rows the page showed, first
 * time only) and one `feed.viewed`. Only the viewer's own match rows are touched.
 */
export async function recordFeedShown(
  database: DbOrTx,
  input: {
    userId: string
    page: number
    items: readonly { productId: string; matchId: string | null; rank: number }[]
  },
): Promise<{ marked: number }> {
  const matched = input.items.filter(
    (item): item is { productId: string; matchId: string; rank: number } => item.matchId !== null,
  )
  const result = await markMatchesShown(database, {
    userId: input.userId,
    items: matched.map((item) => ({ matchId: item.matchId, rank: item.rank })),
  })
  await track(
    "feed.viewed",
    {
      actorUserId: input.userId,
      subjectType: "user",
      subjectId: input.userId,
      properties: { items: input.items.length, matched: matched.length, page: input.page },
    },
    database,
  )
  return result
}
