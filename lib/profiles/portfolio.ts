import "server-only"

import { and, asc, count, desc, eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { builderProfiles, portfolioItems } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

import { PORTFOLIO_MAX_ITEMS, type PortfolioItemForm, type ProfileFormSource } from "./fields"

/**
 * Portfolio items on the builder profile (§5 `portfolio_items`; `format` and `is_shipped` feed
 * matching's `format_fit`, §8). Every change emits `builder_profile.updated` with
 * `fields: ["portfolio_items"]` (there is no portfolio event in §11; the builder profile is what
 * changed for matching and embeddings).
 */

export type PortfolioItemRow = typeof portfolioItems.$inferSelect

export class BuilderProfileMissingError extends ActionError {
  constructor() {
    super("Create your builder profile first.")
    this.name = "BuilderProfileMissingError"
  }
}

async function lockBuilderProfile(tx: DbOrTx, userId: string): Promise<{ id: string }> {
  const [profile] = await tx
    .select({ id: builderProfiles.id })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .for("update")
  if (!profile) throw new BuilderProfileMissingError()
  return profile
}

async function trackPortfolioChange(
  tx: DbOrTx,
  userId: string,
  profileId: string,
  source: ProfileFormSource,
): Promise<void> {
  await track(
    "builder_profile.updated",
    {
      actorUserId: userId,
      subjectType: "builder_profile",
      subjectId: profileId,
      properties: { fields: ["portfolio_items"], source },
    },
    tx,
  )
}

/** The user's portfolio, shipped work first, then oldest first (the order on public profiles). */
export async function listPortfolioItems(
  database: DbOrTx,
  userId: string,
): Promise<PortfolioItemRow[]> {
  return database
    .select({ item: portfolioItems })
    .from(portfolioItems)
    .innerJoin(builderProfiles, eq(builderProfiles.id, portfolioItems.builderProfileId))
    .where(eq(builderProfiles.userId, userId))
    .orderBy(desc(portfolioItems.isShipped), asc(portfolioItems.createdAt))
    .then((rows) => rows.map((row) => row.item))
}

/** The user who owns a portfolio item (for `canManagePortfolioItem`), or null if it is gone. */
export async function findPortfolioItemOwner(
  database: DbOrTx,
  itemId: string,
): Promise<{ ownerUserId: string } | null> {
  const [row] = await database
    .select({ ownerUserId: builderProfiles.userId })
    .from(portfolioItems)
    .innerJoin(builderProfiles, eq(builderProfiles.id, portfolioItems.builderProfileId))
    .where(eq(portfolioItems.id, itemId))
    .limit(1)
  return row ?? null
}

function itemValues(form: PortfolioItemForm) {
  return {
    title: form.title,
    url: form.url,
    description: form.description,
    format: form.format,
    isShipped: form.isShipped,
  }
}

export async function addPortfolioItem(
  database: DbOrTx,
  input: { userId: string; form: PortfolioItemForm; source: ProfileFormSource },
): Promise<{ itemId: string }> {
  return withTransaction(async (tx) => {
    const profile = await lockBuilderProfile(tx, input.userId)
    const [existing] = await tx
      .select({ total: count() })
      .from(portfolioItems)
      .where(eq(portfolioItems.builderProfileId, profile.id))
    if ((existing?.total ?? 0) >= PORTFOLIO_MAX_ITEMS) {
      throw new ActionError(
        `You can show up to ${PORTFOLIO_MAX_ITEMS} projects. Remove one to add another.`,
      )
    }
    const [item] = await tx
      .insert(portfolioItems)
      .values({ builderProfileId: profile.id, ...itemValues(input.form) })
      .returning({ id: portfolioItems.id })
    if (!item) throw new Error("addPortfolioItem: no row returned")
    await trackPortfolioChange(tx, input.userId, profile.id, input.source)
    return { itemId: item.id }
  }, database)
}

/** Update one of the user's own items; false when it does not exist (or is not theirs). */
export async function updatePortfolioItem(
  database: DbOrTx,
  input: { userId: string; itemId: string; form: PortfolioItemForm; source: ProfileFormSource },
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const profile = await lockBuilderProfile(tx, input.userId)
    const updated = await tx
      .update(portfolioItems)
      .set(itemValues(input.form))
      .where(
        and(eq(portfolioItems.id, input.itemId), eq(portfolioItems.builderProfileId, profile.id)),
      )
      .returning({ id: portfolioItems.id })
    if (updated.length === 0) return false
    await trackPortfolioChange(tx, input.userId, profile.id, input.source)
    return true
  }, database)
}

/** Delete one of the user's own items; false when it was already gone. */
export async function deletePortfolioItem(
  database: DbOrTx,
  input: { userId: string; itemId: string; source: ProfileFormSource },
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const profile = await lockBuilderProfile(tx, input.userId)
    const deleted = await tx
      .delete(portfolioItems)
      .where(
        and(eq(portfolioItems.id, input.itemId), eq(portfolioItems.builderProfileId, profile.id)),
      )
      .returning({ id: portfolioItems.id })
    if (deleted.length === 0) return false
    await trackPortfolioChange(tx, input.userId, profile.id, input.source)
    return true
  }, database)
}
