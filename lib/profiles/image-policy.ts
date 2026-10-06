import { formatBytes, normalizeMimeType, UPLOAD_LIMITS } from "@/lib/storage/limits"

/**
 * Portfolio project images (§5 portfolio_items.image_url, §14 MIME allow-list and size limits):
 * the `image` upload purpose (PNG, JPEG, WebP, GIF; 10 MB; never SVG, §19.7). Client-safe, so the
 * project dialog checks a file before asking for an upload URL; the server checks the request and
 * the stored object again (an R2 presigned PUT cannot cap the size).
 *
 * `portfolio_items.image_url` holds the image's storage key (`portfolio-images/<userId>/<id>.<ext>`),
 * not a URL: storage is private (§14 signed URLs). Pages use `portfolioImagePath()`, a stable app
 * route that redirects to a short-lived signed URL (CLAUDE.md §19.17).
 *
 * The browser uploads to a different key, `portfolio-uploads/<userId>/<id>.<ext>`. Saving the
 * project copies the upload to a fresh `portfolio-images/` key that was never presigned and checks
 * that copy, so the upload URL (valid for minutes, reusable) can no longer change a saved image
 * (CLAUDE.md §19.19).
 */

export const PORTFOLIO_IMAGE_POLICY = {
  mimeTypes: UPLOAD_LIMITS.image.mimeTypes,
  maxBytes: UPLOAD_LIMITS.image.maxBytes,
} as const

export type PortfolioImageType = (typeof PORTFOLIO_IMAGE_POLICY.mimeTypes)[number]

export const PORTFOLIO_IMAGE_EXTENSIONS: Record<PortfolioImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

/** The `accept` attribute of the file input. */
export const PORTFOLIO_IMAGE_ACCEPT = PORTFOLIO_IMAGE_POLICY.mimeTypes.join(",")

export const PORTFOLIO_IMAGE_PREFIX = "portfolio-images"
export const PORTFOLIO_UPLOAD_PREFIX = "portfolio-uploads"

export type PortfolioImageCheck =
  { ok: true; contentType: PortfolioImageType } | { ok: false; message: string }

function isPortfolioImageType(value: string): value is PortfolioImageType {
  return (PORTFOLIO_IMAGE_POLICY.mimeTypes as readonly string[]).includes(value)
}

/** Check a file (or a stored object) against the policy. Messages are plain language. */
export function checkPortfolioImage(file: {
  contentType: string
  sizeBytes: number
}): PortfolioImageCheck {
  const contentType = normalizeMimeType(file.contentType)
  if (!isPortfolioImageType(contentType)) {
    return { ok: false, message: "Upload a PNG, JPEG, WebP or GIF image." }
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    return { ok: false, message: "This image is empty." }
  }
  if (file.sizeBytes > PORTFOLIO_IMAGE_POLICY.maxBytes) {
    return {
      ok: false,
      message: `This image is too large. The limit is ${formatBytes(PORTFOLIO_IMAGE_POLICY.maxBytes)}.`,
    }
  }
  return { ok: true, contentType }
}

/** The storage prefix of a user's portfolio images; a key outside it is never accepted. */
export function portfolioImagePrefix(userId: string): string {
  return `${PORTFOLIO_IMAGE_PREFIX}/${userId}/`
}

/** The storage prefix of a user's pending uploads (signed PUT URLs point here only). */
export function portfolioUploadPrefix(userId: string): string {
  return `${PORTFOLIO_UPLOAD_PREFIX}/${userId}/`
}

function isKeyUnder(prefix: string, key: string): boolean {
  return (
    key.startsWith(prefix) &&
    /^[A-Za-z0-9-]+\.(png|jpg|webp|gif)$/.test(key.slice(prefix.length)) &&
    key.length <= 512
  )
}

/** True when `key` is one of `userId`'s saved portfolio image keys (what `image_url` holds). */
export function isOwnPortfolioImageKey(userId: string, key: string): boolean {
  return isKeyUnder(portfolioImagePrefix(userId), key)
}

/** True when `key` is one of `userId`'s uploads, the only image key a save accepts. */
export function isOwnPortfolioUploadKey(userId: string, key: string): boolean {
  return isKeyUnder(portfolioUploadPrefix(userId), key)
}

/**
 * Where a page loads an item's image from: an app route that redirects to a short-lived signed
 * URL. `v` changes with every upload (the key's file name), so browsers never show a replaced
 * image from cache.
 */
export function portfolioImagePath(itemId: string, imageKey: string | null): string | null {
  if (!imageKey) return null
  const version = imageKey.slice(imageKey.lastIndexOf("/") + 1).replace(/\.[a-z]+$/, "")
  return `/api/portfolio/${itemId}/image?v=${encodeURIComponent(version)}`
}
