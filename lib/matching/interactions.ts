import "server-only"

import { and, eq, inArray, isNull } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { builderProfiles, creatorProfiles, matches, savedItems } from "@/lib/db/schema"
import { track, trackMany } from "@/lib/events/track"

import type { MatchActionRow } from "./queries"

/**
 * What a person does with a match (§8, §11; CLAUDE.md §19.24 "Statuses"):
 * - Save → `saved` + a `saved_items` row + `match.saved`; Unsave → `shown`, the row deleted,
 *   `match.unsaved`; Dismiss → `dismissed` (and unsaved) + `match.dismissed`. A dismissed target
 *   is never a candidate again, under any model version.
 * - `match.shown` once per row (`shown_at`), batched per page view; `match.clicked` when a card is
 *   opened.
 *
 * Each change locks the row and is a no-op when it would change nothing (a double tap, two tabs),
 * so events are never duplicated. `rank` is the 1-based position in the list the person saw.
 * Callers authorize first (`canActOnMatch`); these functions also scope every write to the user.
 */

export const MATCH_MESSAGES = {
  notFound: "This match is no longer available.",
  dismissed: "You dismissed this match.",
} as const

async function lockOwnMatch(tx: Tx, userId: string, matchId: string): Promise<MatchActionRow> {
  const [row] = await tx
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
    .where(and(eq(matches.id, matchId), eq(matches.subjectUserId, userId)))
    .for("update")
  if (!row) throw new ActionError(MATCH_MESSAGES.notFound)
  return row
}

function interaction(row: MatchActionRow, rank: number | null) {
  return { model_version: row.modelVersion, target_type: row.targetType, rank }
}

export type MatchChange = { changed: boolean; status: MatchActionRow["status"] }

export async function saveMatch(
  database: DbOrTx,
  input: { userId: string; matchId: string; rank: number | null },
): Promise<MatchChange> {
  return withTransaction(async (tx) => {
    const row = await lockOwnMatch(tx, input.userId, input.matchId)
    if (row.status === "dismissed") throw new ActionError(MATCH_MESSAGES.dismissed)
    const inserted = await tx
      .insert(savedItems)
      .values({ userId: input.userId, targetType: row.targetType, targetId: row.targetId })
      .onConflictDoNothing()
      .returning({ id: savedItems.id })
    // `proposed` stays `proposed` (a proposal was sent); only a shown match becomes `saved`.
    const status = row.status === "shown" ? "saved" : row.status
    if (status !== row.status) {
      await tx.update(matches).set({ status }).where(eq(matches.id, row.id))
    }
    const changed = status !== row.status || inserted.length > 0
    if (changed) {
      await track(
        "match.saved",
        {
          actorUserId: input.userId,
          subjectType: "match",
          subjectId: row.id,
          properties: interaction(row, input.rank),
        },
        tx,
      )
    }
    return { changed, status }
  }, database)
}

export async function unsaveMatch(
  database: DbOrTx,
  input: { userId: string; matchId: string; rank: number | null },
): Promise<MatchChange> {
  return withTransaction(async (tx) => {
    const row = await lockOwnMatch(tx, input.userId, input.matchId)
    const deleted = await tx
      .delete(savedItems)
      .where(
        and(
          eq(savedItems.userId, input.userId),
          eq(savedItems.targetType, row.targetType),
          eq(savedItems.targetId, row.targetId),
        ),
      )
      .returning({ id: savedItems.id })
    // Rows of other model versions saved the same target; they follow.
    const reset = await tx
      .update(matches)
      .set({ status: "shown" })
      .where(
        and(
          eq(matches.subjectUserId, input.userId),
          eq(matches.targetType, row.targetType),
          eq(matches.targetId, row.targetId),
          eq(matches.status, "saved"),
        ),
      )
      .returning({ id: matches.id })
    const changed = deleted.length > 0 || reset.length > 0
    if (changed) {
      await track(
        "match.unsaved",
        {
          actorUserId: input.userId,
          subjectType: "match",
          subjectId: row.id,
          properties: interaction(row, input.rank),
        },
        tx,
      )
    }
    return { changed, status: row.status === "saved" ? "shown" : row.status }
  }, database)
}

export async function dismissMatch(
  database: DbOrTx,
  input: { userId: string; matchId: string; rank: number | null },
): Promise<MatchChange> {
  return withTransaction(async (tx) => {
    const row = await lockOwnMatch(tx, input.userId, input.matchId)
    if (row.status === "dismissed") return { changed: false, status: row.status }
    await tx.update(matches).set({ status: "dismissed" }).where(eq(matches.id, row.id))
    await tx
      .delete(savedItems)
      .where(
        and(
          eq(savedItems.userId, input.userId),
          eq(savedItems.targetType, row.targetType),
          eq(savedItems.targetId, row.targetId),
        ),
      )
    await track(
      "match.dismissed",
      {
        actorUserId: input.userId,
        subjectType: "match",
        subjectId: row.id,
        properties: interaction(row, input.rank),
      },
      tx,
    )
    return { changed: true, status: "dismissed" }
  }, database)
}

/**
 * `match.shown` for the rows a page showed, once per row: a conditional `shown_at` update decides
 * which are new. Only the user's own rows.
 */
export async function markMatchesShown(
  database: DbOrTx,
  input: { userId: string; items: readonly { matchId: string; rank: number }[] },
): Promise<{ marked: number }> {
  if (input.items.length === 0) return { marked: 0 }
  const ranks = new Map(input.items.map((item) => [item.matchId, item.rank]))
  return withTransaction(async (tx) => {
    const marked = await tx
      .update(matches)
      .set({ shownAt: now() })
      .where(
        and(
          inArray(matches.id, [...ranks.keys()]),
          eq(matches.subjectUserId, input.userId),
          isNull(matches.shownAt),
        ),
      )
      .returning({
        id: matches.id,
        targetType: matches.targetType,
        modelVersion: matches.modelVersion,
        score: matches.score,
      })
    await trackMany(
      marked.map((row) => ({
        type: "match.shown" as const,
        actorUserId: input.userId,
        subjectType: "match" as const,
        subjectId: row.id,
        properties: {
          model_version: row.modelVersion,
          target_type: row.targetType,
          rank: ranks.get(row.id) ?? null,
          score: row.score,
        },
      })),
      tx,
    )
    return { marked: marked.length }
  }, database)
}

/** Where a match's card leads: the idea or product page, or the person's public profile. */
export async function matchTargetHref(
  database: DbOrTx,
  row: Pick<MatchActionRow, "targetType" | "targetId">,
): Promise<string | null> {
  switch (row.targetType) {
    case "product":
      return `/app/products/${row.targetId}`
    case "idea":
      return `/app/ideas/${row.targetId}`
    case "builder": {
      const [profile] = await database
        .select({ handle: builderProfiles.handle })
        .from(builderProfiles)
        .where(eq(builderProfiles.userId, row.targetId))
      return profile ? `/b/${profile.handle}` : null
    }
    case "creator": {
      const [profile] = await database
        .select({ handle: creatorProfiles.handle })
        .from(creatorProfiles)
        .where(eq(creatorProfiles.userId, row.targetId))
      return profile ? `/c/${profile.handle}` : null
    }
  }
}

/** `match.clicked` for an opened card; returns where to go. */
export async function recordMatchClick(
  database: DbOrTx,
  input: { userId: string; matchId: string; rank: number | null },
): Promise<string> {
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
    .where(and(eq(matches.id, input.matchId), eq(matches.subjectUserId, input.userId)))
  if (!row) throw new ActionError(MATCH_MESSAGES.notFound)
  const href = await matchTargetHref(database, row)
  if (!href) throw new ActionError(MATCH_MESSAGES.notFound)
  await track(
    "match.clicked",
    {
      actorUserId: input.userId,
      subjectType: "match",
      subjectId: row.id,
      properties: interaction(row, input.rank),
    },
    database,
  )
  return href
}
