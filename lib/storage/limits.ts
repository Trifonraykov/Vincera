/**
 * Upload policy (§14): allow-listed MIME types and size limits per upload purpose.
 *
 * Pure and client-safe, so forms can pre-check files before asking for a signed upload URL. The
 * server must check again when it issues the URL and after the upload (R2 cannot enforce a size
 * limit on a presigned PUT; see `ObjectStorage.statObject`).
 */

const MB = 1024 * 1024

export const UPLOAD_PURPOSES = ["deliverable", "attachment", "image"] as const
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number]

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const

const DOCUMENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const

const ARCHIVE_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-tar",
] as const

export const UPLOAD_LIMITS = {
  /** Files buyers download after purchase: templates, bundles, ebooks, media. */
  deliverable: {
    maxBytes: 200 * MB,
    mimeTypes: [
      ...ARCHIVE_TYPES,
      ...DOCUMENT_TYPES,
      ...IMAGE_TYPES,
      "application/epub+zip",
      "audio/mpeg",
      "audio/wav",
      "video/mp4",
      "video/quicktime",
      "font/ttf",
      "font/otf",
      "font/woff2",
    ],
  },
  /** Files shared in collab and proposal messages. */
  attachment: {
    maxBytes: 25 * MB,
    mimeTypes: [...IMAGE_TYPES, ...DOCUMENT_TYPES, "application/zip"],
  },
  /** Product media, avatars, follower-count screenshots (§7.1 fallback). */
  image: {
    maxBytes: 10 * MB,
    mimeTypes: [...IMAGE_TYPES],
  },
} as const satisfies Record<UploadPurpose, { maxBytes: number; mimeTypes: readonly string[] }>

/** "Image/PNG; charset=binary" → "image/png". */
export function normalizeMimeType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase()
}

export function isAllowedMimeType(purpose: UploadPurpose, contentType: string): boolean {
  const normalized = normalizeMimeType(contentType)
  return (UPLOAD_LIMITS[purpose].mimeTypes as readonly string[]).includes(normalized)
}

export function maxBytesFor(purpose: UploadPurpose): number {
  return UPLOAD_LIMITS[purpose].maxBytes
}

export type UploadCheck =
  | { ok: true; contentType: string }
  | { ok: false; reason: "type" | "size" | "empty"; message: string }

/** Check a proposed upload against the policy. Messages are plain language for the user. */
export function validateUpload(
  purpose: UploadPurpose,
  file: { contentType: string; sizeBytes: number },
): UploadCheck {
  const contentType = normalizeMimeType(file.contentType)
  if (!isAllowedMimeType(purpose, contentType)) {
    return { ok: false, reason: "type", message: "This file type is not supported." }
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    return { ok: false, reason: "empty", message: "This file is empty." }
  }
  const limit = maxBytesFor(purpose)
  if (file.sizeBytes > limit) {
    return {
      ok: false,
      reason: "size",
      message: `This file is too large. The limit is ${formatBytes(limit)}.`,
    }
  }
  return { ok: true, contentType }
}

/** Human-readable size, e.g. 26214400 → "25 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"] as const
  let value = bytes / 1024
  let unit: (typeof units)[number] = "KB"
  for (const next of units.slice(1)) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`
}
