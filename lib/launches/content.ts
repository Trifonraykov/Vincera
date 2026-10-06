import "server-only"

import { and, count, eq, isNull, max } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { AuthzUser } from "@/lib/auth/authz"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { launchFiles, licenseKeys, type LaunchMedia } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import { reportError } from "@/lib/observability"
import { storageKey } from "@/lib/storage/keys"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import {
  checkLaunchUpload,
  cleanAlt,
  cleanFilename,
  DELIVERABLE_POLICY,
  extensionFor,
  isOwnLaunchUploadKey,
  LAUNCH_FILE_PREFIX,
  LAUNCH_FILES_MAX,
  LAUNCH_MEDIA_MAX,
  LAUNCH_MEDIA_PREFIX,
  LAUNCH_UPLOAD_PREFIX,
  LICENSE_KEYS_PER_BATCH,
  MEDIA_POLICY,
  mediaName,
  parseLicenseKeys,
  parseMedia,
  type UploadKind,
} from "./fields"
import {
  LAUNCH_ERRORS,
  launchHasOrders,
  lockForEdit,
  lockLaunch,
  recordEdit,
  type LockedLaunch,
} from "./service"

/**
 * What buyers get and what the product page shows, beyond the setup form (CLAUDE.md §19.31
 * "Delivery types", §19.32): deliverable files (200 MB, allow-listed types, §14), product images
 * (10 MB images), and license keys.
 *
 * Uploads follow the §19.19 pattern: the browser PUTs to `launch-uploads/<userId>/<uuidv7>.<ext>`
 * through a signed URL; adding the file copies it on the server to a key that was never presigned
 * (`launch-files/<launchId>/…` or `launch-media/<launchId>/…`), checks the copy (type, size, the
 * type the extension names) and records it. The upload is deleted after every attempt, accepted or
 * refused. Files and images are launch content: adding or removing one resets approvals like a
 * save. License keys are stock, not content (decided here): members add and remove unassigned keys
 * in any status but `ended`, without resetting approvals, so a live launch can be restocked.
 */

const UPLOAD_URL_TTL_SECONDS = 10 * 60

export type LaunchUpload = { key: string; uploadUrl: string; contentType: string; maxBytes: number }

/** A signed PUT URL for a deliverable file or a product image the member is about to add. */
export async function createLaunchUpload(
  input: { userId: string; kind: UploadKind; contentType: string; sizeBytes: number },
  storage: ObjectStorage = getStorage(),
): Promise<LaunchUpload> {
  const check = checkLaunchUpload(input.kind, input)
  if (!check.ok) throw new ActionError(check.message)
  const extension = extensionFor(input.kind, check.contentType)
  if (!extension) throw new ActionError("This file type is not supported.")
  const maxBytes =
    input.kind === "deliverable" ? DELIVERABLE_POLICY.maxBytes : MEDIA_POLICY.maxBytes
  const key = storageKey(LAUNCH_UPLOAD_PREFIX, input.userId, `${newId()}.${extension}`)
  const uploadUrl = await storage.signedPutUrl(key, {
    contentType: check.contentType,
    maxBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  })
  return { key, uploadUrl, contentType: check.contentType, maxBytes }
}

/**
 * Copy an upload to its final key and check the copy; returns its type and size or throws a
 * plain-language `ActionError` (the refused copy is deleted).
 */
async function promoteUpload(
  userId: string,
  kind: UploadKind,
  uploadKey: string,
  finalKey: (extension: string) => string,
  storage: ObjectStorage,
): Promise<{ key: string; contentType: string; sizeBytes: number }> {
  if (!isOwnLaunchUploadKey(userId, uploadKey, kind)) {
    throw new ActionError("Upload the file again, then add it.")
  }
  const extension = uploadKey.slice(uploadKey.lastIndexOf(".") + 1)
  const key = finalKey(extension)
  if (!(await storage.copyObject(uploadKey, key))) {
    throw new ActionError("We didn't receive your file. Upload it again.")
  }
  const info = await storage.statObject(key)
  const check = info
    ? checkLaunchUpload(kind, { contentType: info.contentType, sizeBytes: info.sizeBytes })
    : ({ ok: false, message: "We didn't receive your file. Upload it again." } as const)
  if (!check.ok || extensionFor(kind, check.contentType) !== extension) {
    await deleteObjects([key], storage)
    throw new ActionError(check.ok ? "Upload the file again, then add it." : check.message)
  }
  return { key, contentType: check.contentType, sizeBytes: info?.sizeBytes ?? 0 }
}

/** Best-effort removal of stored objects (a refused add, a removed file or image). */
export async function deleteObjects(
  keys: readonly string[],
  storage: ObjectStorage = getStorage(),
) {
  for (const key of keys) {
    try {
      await storage.deleteObject(key)
    } catch (error) {
      reportError(error, { tags: { area: "launches", step: "delete_object" } })
    }
  }
}

/** Delete an upload once the add is over (own upload keys only; best effort). */
export async function discardLaunchUpload(
  userId: string,
  uploadKey: unknown,
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  if (typeof uploadKey !== "string") return
  const kinds: UploadKind[] = ["deliverable", "media"]
  if (!kinds.some((kind) => isOwnLaunchUploadKey(userId, uploadKey, kind))) return
  await deleteObjects([uploadKey], storage)
}

// --- Deliverable files ----------------------------------------------------------------------

export async function addLaunchFile(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string; uploadKey: string; filename: string },
  storage: ObjectStorage = getStorage(),
): Promise<{ fileId: string }> {
  // Checked before the copy, so a refusal costs no storage work; checked again under the lock.
  const pre = await withTransaction((tx) => lockForEdit(tx, user, input.launchId), database)
  if (pre.row.deliveryType !== "file") {
    throw new ActionError("Choose “Files” as the delivery and save, then add files.")
  }
  const stored = await promoteUpload(
    user.id,
    "deliverable",
    input.uploadKey,
    (extension) => storageKey(LAUNCH_FILE_PREFIX, input.launchId, `${newId()}.${extension}`),
    storage,
  )
  try {
    return await withTransaction(async (tx) => {
      const state = await lockForEdit(tx, user, input.launchId)
      const [existing] = await tx
        .select({ n: count(), last: max(launchFiles.position) })
        .from(launchFiles)
        .where(eq(launchFiles.launchId, state.row.id))
      if ((existing?.n ?? 0) >= LAUNCH_FILES_MAX) {
        throw new ActionError(`A launch can have up to ${LAUNCH_FILES_MAX} files.`)
      }
      const [file] = await tx
        .insert(launchFiles)
        .values({
          launchId: state.row.id,
          storageKey: stored.key,
          filename: cleanFilename(input.filename),
          sizeBytes: stored.sizeBytes,
          contentType: stored.contentType,
          position: existing?.last === null || existing?.last === undefined ? 0 : existing.last + 1,
        })
        .returning({ id: launchFiles.id })
      if (!file) throw new Error("addLaunchFile: no row")
      await recordEdit(tx, state, user, { fields: ["launch_files"] })
      return { fileId: file.id }
    }, database)
  } catch (error) {
    await deleteObjects([stored.key], storage)
    throw error
  }
}

export async function removeLaunchFile(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string; fileId: string },
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  const key = await withTransaction(async (tx) => {
    const state = await lockForEdit(tx, user, input.launchId)
    // Past buyers download these files from their access page (CLAUDE.md §19.37).
    if (await launchHasOrders(tx, state.row.id)) throw new ActionError(LAUNCH_ERRORS.fileSold)
    const [file] = await tx
      .delete(launchFiles)
      .where(and(eq(launchFiles.id, input.fileId), eq(launchFiles.launchId, state.row.id)))
      .returning({ key: launchFiles.storageKey })
    if (!file) throw new ActionError("That file is already gone.")
    await recordEdit(tx, state, user, { fields: ["launch_files"] })
    return file.key
  }, database)
  await deleteObjects([key], storage)
}

// --- Product images -------------------------------------------------------------------------

export async function addLaunchMedia(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string; uploadKey: string; alt: string | null },
  storage: ObjectStorage = getStorage(),
): Promise<{ name: string }> {
  const pre = await withTransaction((tx) => lockForEdit(tx, user, input.launchId), database)
  if (parseMedia(pre.row.media).length >= LAUNCH_MEDIA_MAX) {
    throw new ActionError(`A launch can show up to ${LAUNCH_MEDIA_MAX} images.`)
  }
  const stored = await promoteUpload(
    user.id,
    "media",
    input.uploadKey,
    (extension) => storageKey(LAUNCH_MEDIA_PREFIX, input.launchId, `${newId()}.${extension}`),
    storage,
  )
  try {
    return await withTransaction(async (tx) => {
      const state = await lockForEdit(tx, user, input.launchId)
      const media = parseMedia(state.row.media)
      if (media.length >= LAUNCH_MEDIA_MAX) {
        throw new ActionError(`A launch can show up to ${LAUNCH_MEDIA_MAX} images.`)
      }
      const entry: LaunchMedia = {
        kind: "image",
        url: stored.key,
        alt: cleanAlt(input.alt, `${state.row.title}, image ${media.length + 1}`),
      }
      await recordEdit(tx, state, user, { fields: ["media"], set: { media: [...media, entry] } })
      return { name: mediaName(stored.key) }
    }, database)
  } catch (error) {
    await deleteObjects([stored.key], storage)
    throw error
  }
}

export async function removeLaunchMedia(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string; name: string },
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  const key = await withTransaction(async (tx) => {
    const state = await lockForEdit(tx, user, input.launchId)
    const media = parseMedia(state.row.media)
    const entry = media.find((item) => mediaName(item.url) === input.name)
    if (!entry) throw new ActionError("That image is already gone.")
    await recordEdit(tx, state, user, {
      fields: ["media"],
      set: { media: media.filter((item) => item !== entry) },
    })
    return entry.url
  }, database)
  if (key.startsWith(`${LAUNCH_MEDIA_PREFIX}/${input.launchId}/`))
    await deleteObjects([key], storage)
}

/** The storage key of a launch image by its public name, or null. */
export function mediaKeyByName(media: unknown, launchId: string, name: string): string | null {
  const entry = parseMedia(media).find((item) => mediaName(item.url) === name)
  if (!entry || !entry.url.startsWith(`${LAUNCH_MEDIA_PREFIX}/${launchId}/`)) return null
  return entry.url
}

// --- License keys ---------------------------------------------------------------------------

/** Keys are stock: any member while neither the launch nor the collab has ended. */
async function lockForKeys(tx: Tx, user: AuthzUser, launchId: string): Promise<LockedLaunch> {
  const state = await lockLaunch(tx, launchId)
  if (!state || !state.access.memberUserIds.includes(user.id) || user.status !== "active") {
    throw new ActionError(LAUNCH_ERRORS.notFound)
  }
  if (state.row.status === "ended") throw new ActionError(LAUNCH_ERRORS.ended)
  if (state.collabStage === "ended") throw new ActionError(LAUNCH_ERRORS.collabEnded)
  return state
}

export type AddKeysResult = {
  added: number
  alreadyThere: number
  duplicates: number
  tooLong: number
}

/** Add pasted license keys (one per line); keys already on the launch are skipped. */
export async function addLicenseKeys(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string; text: string },
): Promise<AddKeysResult> {
  const parsed = parseLicenseKeys(input.text)
  if (parsed.keys.length === 0) {
    throw new ActionError(
      parsed.tooLong > 0
        ? "Keys can be at most 200 characters long."
        : "Paste at least one key, one per line.",
      { fieldErrors: { keys: ["Paste at least one key, one per line."] } },
    )
  }
  if (parsed.keys.length > LICENSE_KEYS_PER_BATCH) {
    const message = `Add at most ${LICENSE_KEYS_PER_BATCH.toLocaleString("en-US")} keys at a time.`
    throw new ActionError(message, { fieldErrors: { keys: [message] } })
  }
  return withTransaction(async (tx) => {
    const state = await lockForKeys(tx, user, input.launchId)
    const inserted = await tx
      .insert(licenseKeys)
      .values(parsed.keys.map((key) => ({ launchId: state.row.id, key })))
      .onConflictDoNothing({ target: [licenseKeys.launchId, licenseKeys.key] })
      .returning({ id: licenseKeys.id })
    if (inserted.length > 0) {
      await track(
        "launch.updated",
        {
          actorUserId: user.id,
          subjectType: "launch",
          subjectId: state.row.id,
          properties: {
            collab_id: state.row.collabId,
            fields: ["license_keys"],
            approvals_reset: false,
          },
        },
        tx,
      )
    }
    return {
      added: inserted.length,
      alreadyThere: parsed.keys.length - inserted.length,
      duplicates: parsed.duplicates,
      tooLong: parsed.tooLong,
    }
  }, database)
}

/** Remove every key nobody bought yet (e.g. a list pasted by mistake). */
export async function removeUnassignedKeys(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string },
): Promise<{ removed: number }> {
  return withTransaction(async (tx) => {
    const state = await lockForKeys(tx, user, input.launchId)
    const removed = await tx
      .delete(licenseKeys)
      .where(and(eq(licenseKeys.launchId, state.row.id), isNull(licenseKeys.orderId)))
      .returning({ id: licenseKeys.id })
    if (removed.length > 0) {
      await track(
        "launch.updated",
        {
          actorUserId: user.id,
          subjectType: "launch",
          subjectId: state.row.id,
          properties: {
            collab_id: state.row.collabId,
            fields: ["license_keys"],
            approvals_reset: false,
          },
        },
        tx,
      )
    }
    return { removed: removed.length }
  }, database)
}
