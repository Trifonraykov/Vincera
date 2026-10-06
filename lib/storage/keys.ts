import { MAX_SIGNED_URL_SECONDS, StorageError } from "./types"

/**
 * Object keys and download headers, shared by the R2 and local implementations.
 *
 * Keys are `/`-separated paths built by the app (never taken raw from user input), e.g.
 * `launches/<launchId>/files/<uuid>-<sanitized-filename>`. The rules keep them portable across
 * S3/R2 and safe as relative paths on disk for the local fake.
 */

const MAX_KEY_LENGTH = 512
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!_.*'()/-]*$/

export function isValidKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false
  if (!KEY_PATTERN.test(key) || key.endsWith("/")) return false
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

export function assertValidKey(key: string): void {
  if (!isValidKey(key)) throw new StorageError(`Invalid storage key: ${JSON.stringify(key)}`)
}

/** Join path segments into a key, validating the result. */
export function storageKey(...segments: string[]): string {
  const key = segments.join("/")
  assertValidKey(key)
  return key
}

/**
 * A user-supplied file name made safe for a key segment: ASCII letters, digits, `.`, `_`, `-`;
 * everything else collapses to `-`. Keeps the extension and at most 100 characters.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const cleaned = base
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // drop accents split off by NFKD: "é" → "e"
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  const dot = cleaned.lastIndexOf(".")
  const ext = dot > 0 ? cleaned.slice(dot).slice(0, 16) : ""
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned)
    .replace(/[-.]+$/, "")
    .slice(0, 100 - ext.length)
  return stem ? `${stem}${ext}` : `file${ext}`
}

/** `Content-Disposition: attachment` with an ASCII fallback plus the RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(filename)}`
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Encode a key for use in a URL path, segment by segment. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/")
}

export function assertExpiry(expiresInSeconds: number): void {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > MAX_SIGNED_URL_SECONDS
  ) {
    throw new StorageError(
      `expiresInSeconds must be an integer between 1 and ${MAX_SIGNED_URL_SECONDS}`,
    )
  }
}
