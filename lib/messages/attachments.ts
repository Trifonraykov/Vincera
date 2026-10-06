import "server-only"

import { ActionError } from "@/lib/actions/errors"
import { newId } from "@/lib/ids"
import { reportError } from "@/lib/observability"
import { storageKey } from "@/lib/storage/keys"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"
import type { MessageAttachment } from "@/lib/db/schema"

import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_POLICY,
  checkAttachment,
  displayFilename,
  isOwnMessageUploadKey,
  MESSAGE_ATTACHMENT_PREFIX,
  MESSAGE_UPLOAD_PREFIX,
  type AttachmentRef,
} from "./fields"

/**
 * Message attachments in private storage (§14: signed URLs, 25 MB, MIME allow-list; CLAUDE.md
 * §19.24): a signed PUT to the user's upload prefix, then a server-side copy to a key under the
 * thread that was never presigned, checked after the copy (R2 cannot cap a presigned PUT). The
 * upload is deleted after every send, accepted or refused. Downloads go through
 * `/api/messages/<messageId>/attachments/<index>`, which checks the thread rule and redirects to
 * a 5-minute signed URL that downloads the file (`Content-Disposition: attachment`).
 */

const UPLOAD_URL_TTL_SECONDS = 10 * 60
export const ATTACHMENT_URL_TTL_SECONDS = 5 * 60

export type AttachmentUpload = {
  key: string
  uploadUrl: string
  contentType: string
  maxBytes: number
}

/** A signed PUT URL for one file the user is about to attach. */
export async function createAttachmentUpload(
  input: { userId: string; contentType: string; sizeBytes: number },
  storage: ObjectStorage = getStorage(),
): Promise<AttachmentUpload> {
  const check = checkAttachment(input)
  if (!check.ok) throw new ActionError(check.message)
  const extension = ATTACHMENT_EXTENSIONS[check.contentType]
  const key = storageKey(MESSAGE_UPLOAD_PREFIX, input.userId, `${newId()}.${extension}`)
  const uploadUrl = await storage.signedPutUrl(key, {
    contentType: check.contentType,
    maxBytes: ATTACHMENT_POLICY.maxBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  })
  return { key, uploadUrl, contentType: check.contentType, maxBytes: ATTACHMENT_POLICY.maxBytes }
}

/**
 * Copy the user's uploads into the thread and check the copies; returns what the message stores.
 * On any refusal, the copies made so far are deleted and a plain-language `ActionError` thrown;
 * the uploads are left for `discardMessageUploads`.
 */
export async function promoteAttachments(
  userId: string,
  threadId: string,
  refs: readonly AttachmentRef[],
  storage: ObjectStorage = getStorage(),
): Promise<MessageAttachment[]> {
  const promoted: MessageAttachment[] = []
  try {
    for (const ref of refs) {
      if (!isOwnMessageUploadKey(userId, ref.key)) {
        throw new ActionError("Attach your files again, then send.")
      }
      const extension = ref.key.slice(ref.key.lastIndexOf(".") + 1)
      const key = storageKey(MESSAGE_ATTACHMENT_PREFIX, threadId, `${newId()}.${extension}`)
      if (!(await storage.copyObject(ref.key, key))) {
        throw new ActionError(
          `We didn't receive “${displayFilename(ref.filename)}”. Attach it again.`,
        )
      }
      // Recorded before the check, so a refused copy is cleaned up below with the others.
      const entry: MessageAttachment = {
        storageKey: key,
        filename: displayFilename(ref.filename),
        contentType: "",
        sizeBytes: 0,
      }
      promoted.push(entry)
      const info = await storage.statObject(key)
      const check = info
        ? checkAttachment({ contentType: info.contentType, sizeBytes: info.sizeBytes })
        : ({ ok: false, message: "We didn't receive your file. Attach it again." } as const)
      if (!check.ok) throw new ActionError(check.message)
      if (ATTACHMENT_EXTENSIONS[check.contentType] !== extension) {
        throw new ActionError("Attach your files again, then send.")
      }
      entry.contentType = check.contentType
      entry.sizeBytes = info?.sizeBytes ?? 0
    }
  } catch (error) {
    await deleteAttachmentObjects(promoted, storage)
    throw error
  }
  return promoted
}

/** Best-effort removal of stored attachment copies (a send that failed after promoting them). */
export async function deleteAttachmentObjects(
  attachments: readonly Pick<MessageAttachment, "storageKey">[],
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  for (const attachment of attachments) {
    try {
      await storage.deleteObject(attachment.storageKey)
    } catch (error) {
      reportError(error, { tags: { area: "messages", step: "delete_attachment" } })
    }
  }
}

/**
 * Delete a send's uploads once the send is over, accepted (they were copied) or refused, including
 * refusals before it ran (invalid fields). Only the user's own upload keys; best effort.
 */
export async function discardMessageUploads(
  userId: string,
  refs: unknown,
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  if (!Array.isArray(refs)) return
  for (const ref of refs) {
    const key: unknown = typeof ref === "object" && ref !== null && "key" in ref ? ref.key : null
    if (typeof key !== "string" || !isOwnMessageUploadKey(userId, key)) continue
    try {
      await storage.deleteObject(key)
    } catch (error) {
      reportError(error, { tags: { area: "messages", step: "discard_upload" } })
    }
  }
}

/** A short-lived download URL for a stored attachment (the route checks access first). */
export async function attachmentDownloadUrl(
  attachment: Pick<MessageAttachment, "storageKey" | "filename">,
  storage: ObjectStorage = getStorage(),
): Promise<string> {
  return storage.signedGetUrl(attachment.storageKey, {
    expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    filename: attachment.filename,
  })
}
