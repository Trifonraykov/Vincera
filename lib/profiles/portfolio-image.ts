import "server-only"

import { and, eq, isNotNull } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, portfolioItems, users } from "@/lib/db/schema"
import { newId } from "@/lib/ids"
import { reportError } from "@/lib/observability"
import { storageKey } from "@/lib/storage/keys"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import {
  checkPortfolioImage,
  isOwnPortfolioImageKey,
  isOwnPortfolioUploadKey,
  PORTFOLIO_IMAGE_EXTENSIONS,
  PORTFOLIO_IMAGE_POLICY,
  PORTFOLIO_IMAGE_PREFIX,
  PORTFOLIO_UPLOAD_PREFIX,
} from "./image-policy"

/**
 * Portfolio images in storage (§14: signed URLs, MIME allow-list, size limit; CLAUDE.md §19.17,
 * §19.19).
 *
 * Upload: the browser asks for a signed PUT URL (`createPortfolioImageUpload`) to an upload key
 * (`portfolio-uploads/<userId>/…`), uploads the file straight to storage, then saves the project
 * with that key. Saving promotes it (`promotePortfolioImage`): a server-side copy to a fresh
 * `portfolio-images/<userId>/…` key that was never presigned, then the type and size check on
 * that copy (an R2 presigned PUT cannot enforce a size limit, §19.7, and stays usable until it
 * expires). So the PUT URL can never change a saved image, and every project gets a key of its
 * own. The upload itself is deleted after every save, accepted or refused
 * (`discardPortfolioUpload`).
 *
 * Display: `/api/portfolio/<itemId>/image` redirects to a short-lived signed GET URL
 * (`portfolioImageUrl`). Portfolio images are public profile content, so anyone may load the image
 * of an existing item whose owner is active.
 */

const UPLOAD_URL_TTL_SECONDS = 10 * 60
/** Signed GET URLs behind the image route; the route lets browsers cache the redirect for less. */
export const PORTFOLIO_IMAGE_URL_TTL_SECONDS = 10 * 60

export type PortfolioImageUpload = {
  key: string
  uploadUrl: string
  contentType: string
  maxBytes: number
}

/** A signed PUT URL for a new project image of `userId`. */
export async function createPortfolioImageUpload(
  input: { userId: string; contentType: string; sizeBytes: number },
  storage: ObjectStorage = getStorage(),
): Promise<PortfolioImageUpload> {
  const check = checkPortfolioImage(input)
  if (!check.ok) throw new ActionError(check.message)
  const extension = PORTFOLIO_IMAGE_EXTENSIONS[check.contentType]
  const key = storageKey(PORTFOLIO_UPLOAD_PREFIX, input.userId, `${newId()}.${extension}`)
  const uploadUrl = await storage.signedPutUrl(key, {
    contentType: check.contentType,
    maxBytes: PORTFOLIO_IMAGE_POLICY.maxBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  })
  return {
    key,
    uploadUrl,
    contentType: check.contentType,
    maxBytes: PORTFOLIO_IMAGE_POLICY.maxBytes,
  }
}

/**
 * Accept an uploaded image for `userId`: copy the upload to a new image key, check the copy
 * (type, size, and the type the key's extension names) and return the new key, or throw a
 * plain-language `ActionError`. A refused copy is deleted; the upload is left for
 * `discardPortfolioUpload`. The caller stores the returned key, or deletes it with
 * `deletePortfolioImage` when the save does not go through.
 */
export async function promotePortfolioImage(
  userId: string,
  uploadKey: string,
  storage: ObjectStorage = getStorage(),
): Promise<string> {
  if (!isOwnPortfolioUploadKey(userId, uploadKey)) {
    throw new ActionError("Upload the image again, then save the project.")
  }
  const extension = uploadKey.slice(uploadKey.lastIndexOf(".") + 1)
  const imageKey = storageKey(PORTFOLIO_IMAGE_PREFIX, userId, `${newId()}.${extension}`)
  if (!(await storage.copyObject(uploadKey, imageKey))) {
    throw new ActionError("We didn't receive your image. Please upload it again.")
  }
  const info = await storage.statObject(imageKey)
  const check = info
    ? checkPortfolioImage({ contentType: info.contentType, sizeBytes: info.sizeBytes })
    : ({ ok: false, message: "We didn't receive your image. Please upload it again." } as const)
  if (!check.ok || PORTFOLIO_IMAGE_EXTENSIONS[check.contentType] !== extension) {
    await storage.deleteObject(imageKey)
    throw new ActionError(
      check.ok ? "Upload the image again, then save the project." : check.message,
    )
  }
  return imageKey
}

/**
 * Delete a save's upload once the save is over, accepted (it was copied) or refused, including
 * refusals before the save ran (invalid fields). Only the user's own upload keys; best effort.
 */
export async function discardPortfolioUpload(
  userId: string,
  uploadKey: unknown,
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  if (typeof uploadKey !== "string" || !isOwnPortfolioUploadKey(userId, uploadKey.trim())) return
  try {
    await storage.deleteObject(uploadKey.trim())
  } catch (error) {
    reportError(error, { tags: { area: "profiles", step: "discard_portfolio_upload" } })
  }
}

/**
 * Best-effort removal of an image no project uses any more (replaced, removed, deleted, or
 * promoted for a save that failed). Skipped while any project still points at the key: rows saved
 * before keys were per project (CLAUDE.md §19.19) may share one.
 */
export async function deletePortfolioImage(
  database: DbOrTx,
  key: string | null,
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  if (!key) return
  try {
    const [inUse] = await database
      .select({ id: portfolioItems.id })
      .from(portfolioItems)
      .where(eq(portfolioItems.imageUrl, key))
      .limit(1)
    if (!inUse) await storage.deleteObject(key)
  } catch (error) {
    reportError(error, { tags: { area: "profiles", step: "delete_portfolio_image" } })
  }
}

/**
 * A short-lived signed URL for an item's image, or null when the item does not exist, has no
 * image, or belongs to a suspended user (whose public profile answers 404 too).
 */
export async function portfolioImageUrl(
  database: DbOrTx,
  itemId: string,
  storage: ObjectStorage = getStorage(),
): Promise<string | null> {
  const [row] = await database
    .select({ key: portfolioItems.imageUrl, ownerUserId: builderProfiles.userId })
    .from(portfolioItems)
    .innerJoin(builderProfiles, eq(builderProfiles.id, portfolioItems.builderProfileId))
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(
      and(
        eq(portfolioItems.id, itemId),
        isNotNull(portfolioItems.imageUrl),
        eq(users.status, "active"),
      ),
    )
    .limit(1)
  if (!row?.key || !isOwnPortfolioImageKey(row.ownerUserId, row.key)) return null
  return storage.signedGetUrl(row.key, { expiresInSeconds: PORTFOLIO_IMAGE_URL_TTL_SECONDS })
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `GET /api/portfolio/<itemId>/image`: a redirect to the image's signed URL (302), cached by the
 * browser for less than the URL lives; 404 for anything else.
 */
export async function portfolioImageResponse(
  itemId: string,
  deps: { db: DbOrTx; storage?: ObjectStorage },
): Promise<Response> {
  const url = UUID_PATTERN.test(itemId)
    ? await portfolioImageUrl(deps.db, itemId, deps.storage ?? getStorage())
    : null
  if (!url) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } })
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": `private, max-age=${Math.floor(PORTFOLIO_IMAGE_URL_TTL_SECONDS / 2)}`,
    },
  })
}
