import { z } from "zod"

import { normalizeMimeType, UPLOAD_LIMITS, validateUpload } from "@/lib/storage/limits"

/**
 * Messages in proposal and collab threads (§5 messages; CLAUDE.md §19.24 "Threads and messages"):
 * limits, the attachment policy and the Zod schemas shared by the composer and the server.
 * Client-safe.
 *
 * Bodies are Markdown (≤ 5,000 characters), rendered only through `renderMarkdown` (lib/markdown.ts,
 * sanitized, §14). Attachments use the `attachment` upload purpose (25 MB, MIME allow-list; §14):
 * the browser uploads to `message-uploads/<userId>/<uuidv7>.<ext>` through a signed PUT URL, and
 * sending the message copies each upload to `message-attachments/<threadId>/<uuidv7>.<ext>`, a key
 * that was never presigned, then checks the copy (the §19.19 pattern).
 */

export const MESSAGE_BODY_MAX = 5000
export const MESSAGE_ATTACHMENTS_MAX = 5
/** Shown file names are cut to this length (the stored key never uses them). */
export const ATTACHMENT_FILENAME_MAX = 120

export const ATTACHMENT_POLICY = UPLOAD_LIMITS.attachment
export type AttachmentType = (typeof ATTACHMENT_POLICY.mimeTypes)[number]

/** One extension per allowed type: the stored key's extension names the type it was checked as. */
export const ATTACHMENT_EXTENSIONS: Record<AttachmentType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
}

/** The file input's `accept`: types and extensions (some phones only match extensions). */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_POLICY.mimeTypes,
  ...Object.values(ATTACHMENT_EXTENSIONS).map((extension) => `.${extension}`),
].join(",")

export const MESSAGE_UPLOAD_PREFIX = "message-uploads"
export const MESSAGE_ATTACHMENT_PREFIX = "message-attachments"

export function isAttachmentType(value: string): value is AttachmentType {
  return (ATTACHMENT_POLICY.mimeTypes as readonly string[]).includes(value)
}

export type AttachmentCheck =
  { ok: true; contentType: AttachmentType } | { ok: false; message: string }

/**
 * Browsers leave `File.type` empty for some files (e.g. Markdown on Windows); fall back to the
 * extension so those can still be sent.
 */
export function attachmentTypeOf(file: { name: string; type: string }): string {
  const type = normalizeMimeType(file.type)
  if (type) return type
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()
  const match = Object.entries(ATTACHMENT_EXTENSIONS).find(([, ext]) => ext === extension)
  return match?.[0] ?? ""
}

/** Check a file (or a stored object) against the attachment policy, in plain language. */
export function checkAttachment(file: { contentType: string; sizeBytes: number }): AttachmentCheck {
  const check = validateUpload("attachment", file)
  if (!check.ok) {
    return {
      ok: false,
      message:
        check.reason === "type"
          ? "You can attach images, PDFs, text, CSV, JSON, Office documents and ZIP files."
          : check.message,
    }
  }
  return isAttachmentType(check.contentType)
    ? { ok: true, contentType: check.contentType }
    : { ok: false, message: "This file type is not supported." }
}

/** The name people see for an attachment: no path, no control characters, at most 120 characters. */
export function displayFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]+/g, "").trim()
  if (!base) return "file"
  if (base.length <= ATTACHMENT_FILENAME_MAX) return base
  const dot = base.lastIndexOf(".")
  const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : ""
  return `${base.slice(0, ATTACHMENT_FILENAME_MAX - extension.length - 1)}…${extension}`
}

/** The storage prefix of a user's pending uploads (signed PUT URLs point here only). */
export function messageUploadPrefix(userId: string): string {
  return `${MESSAGE_UPLOAD_PREFIX}/${userId}/`
}

const UPLOAD_NAME = /^[A-Za-z0-9-]+\.([a-z]+)$/

/** A key the user may send as an attachment: their own upload, with an allowed extension. */
export function isOwnMessageUploadKey(userId: string, key: string): boolean {
  const prefix = messageUploadPrefix(userId)
  if (!key.startsWith(prefix)) return false
  const name = key.slice(prefix.length)
  const extension = UPLOAD_NAME.exec(name)?.[1]
  return extension !== undefined && Object.values(ATTACHMENT_EXTENSIONS).includes(extension)
}

/** Message text from a form: CRLF → LF, trimmed, required, ≤ 5,000 characters. */
export const messageBodySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : value),
  z
    .string({ error: "Write a message." })
    .min(1, "Write a message.")
    .max(
      MESSAGE_BODY_MAX,
      `Keep your message under ${MESSAGE_BODY_MAX.toLocaleString("en")} characters.`,
    ),
)

/** The attachments the composer sends: upload keys with the names the person picked. */
export const attachmentRefsSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === "") return []
    if (typeof value !== "string") return value
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  },
  z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        filename: z.string().min(1).max(512),
      }),
      { error: "Attach your files again." },
    )
    .max(
      MESSAGE_ATTACHMENTS_MAX,
      `You can attach up to ${MESSAGE_ATTACHMENTS_MAX} files to a message.`,
    ),
)

export type AttachmentRef = z.output<typeof attachmentRefsSchema>[number]
