import "server-only"

import { and, asc, count, desc, eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { builderProfiles, portfolioItems } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { PORTFOLIO_MAX_ITEMS, type PortfolioItemForm, type ProfileFormSource } from "./fields"
import {
  deletePortfolioImage,
  discardPortfolioUpload,
  promotePortfolioImage,
} from "./portfolio-image"

/**
 * Portfolio items on the builder profile (§5 `portfolio_items`; `format` and `is_shipped` feed
 * matching's `format_fit`, §8). Every change emits `builder_profile.updated` with
 * `fields: ["portfolio_items"]` (there is no portfolio event in §11; the builder profile is what
 * changed for matching and embeddings).
 *
 * Images: `image_url` holds the storage key of the project's image (./portfolio-image.ts). A form
 * only ever carries an upload key; before the transaction it is promoted to a new image key of
 * its own (copied and checked), so no two projects share an image and a key the user did not just
 * upload (another project's) is refused. When the save does not go through, the promoted copy is
 * deleted; the upload is deleted after every save. An image that is replaced or removed is
 * returned as `removedImageKey` so the caller deletes it after the commit.
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

/** What an update or delete did to the item's image: the key to delete after the commit. */
export type PortfolioChange = { itemId: string; removedImageKey: string | null }

type PortfolioInput = { userId: string; form: PortfolioItemForm; source: ProfileFormSource }

export async function addPortfolioItem(
  database: DbOrTx,
  input: PortfolioInput,
  storage: ObjectStorage = getStorage(),
): Promise<{ itemId: string }> {
  const uploadKey = input.form.removeImage ? null : input.form.imageKey
  try {
    const imageKey = uploadKey
      ? await promotePortfolioImage(input.userId, uploadKey, storage)
      : null
    try {
      return await withTransaction(async (tx) => {
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
          .values({ builderProfileId: profile.id, ...itemValues(input.form), imageUrl: imageKey })
          .returning({ id: portfolioItems.id })
        if (!item) throw new Error("addPortfolioItem: no row returned")
        await trackPortfolioChange(tx, input.userId, profile.id, input.source)
        return { itemId: item.id }
      }, database)
    } catch (error) {
      // Nothing points at the copy: the item was never stored.
      await deletePortfolioImage(database, imageKey, storage)
      throw error
    }
  } finally {
    await discardPortfolioUpload(input.userId, input.form.imageKey, storage)
  }
}

/**
 * Update one of the user's own items; null when it does not exist (or is not theirs). A new image
 * (an upload key) replaces the old one; the item's own current key keeps it; `removeImage` clears
 * it.
 */
export async function updatePortfolioItem(
  database: DbOrTx,
  input: PortfolioInput & { itemId: string },
  storage: ObjectStorage = getStorage(),
): Promise<PortfolioChange | null> {
  try {
    const current = await findOwnItem(database, input.userId, input.itemId)
    if (!current) return null
    const submitted = input.form.removeImage ? null : input.form.imageKey
    const newImageKey =
      submitted && submitted !== current.imageUrl
        ? await promotePortfolioImage(input.userId, submitted, storage)
        : null
    let change: PortfolioChange | null = null
    try {
      change = await withTransaction(async (tx) => {
        const profile = await lockBuilderProfile(tx, input.userId)
        const [existing] = await tx
          .select({ imageUrl: portfolioItems.imageUrl })
          .from(portfolioItems)
          .where(
            and(
              eq(portfolioItems.id, input.itemId),
              eq(portfolioItems.builderProfileId, profile.id),
            ),
          )
          .for("update")
        if (!existing) return null
        const imageUrl = input.form.removeImage ? null : (newImageKey ?? existing.imageUrl)
        await tx
          .update(portfolioItems)
          .set({ ...itemValues(input.form), imageUrl })
          .where(eq(portfolioItems.id, input.itemId))
        await trackPortfolioChange(tx, input.userId, profile.id, input.source)
        return {
          itemId: input.itemId,
          removedImageKey:
            existing.imageUrl && existing.imageUrl !== imageUrl ? existing.imageUrl : null,
        }
      }, database)
    } finally {
      // The item was removed meanwhile, or the save failed: nothing points at the copy.
      if (!change) await deletePortfolioImage(database, newImageKey, storage)
    }
    return change
  } finally {
    await discardPortfolioUpload(input.userId, input.form.imageKey, storage)
  }
}

/** Delete one of the user's own items; null when it was already gone. */
export async function deletePortfolioItem(
  database: DbOrTx,
  input: { userId: string; itemId: string; source: ProfileFormSource },
): Promise<PortfolioChange | null> {
  return withTransaction(async (tx) => {
    const profile = await lockBuilderProfile(tx, input.userId)
    const [deleted] = await tx
      .delete(portfolioItems)
      .where(
        and(eq(portfolioItems.id, input.itemId), eq(portfolioItems.builderProfileId, profile.id)),
      )
      .returning({ id: portfolioItems.id, imageUrl: portfolioItems.imageUrl })
    if (!deleted) return null
    await trackPortfolioChange(tx, input.userId, profile.id, input.source)
    return { itemId: deleted.id, removedImageKey: deleted.imageUrl }
  }, database)
}

async function findOwnItem(
  database: DbOrTx,
  userId: string,
  itemId: string,
): Promise<{ imageUrl: string | null } | null> {
  const [row] = await database
    .select({ imageUrl: portfolioItems.imageUrl })
    .from(portfolioItems)
    .innerJoin(builderProfiles, eq(builderProfiles.id, portfolioItems.builderProfileId))
    .where(and(eq(portfolioItems.id, itemId), eq(builderProfiles.userId, userId)))
    .limit(1)
  return row ?? null
}
