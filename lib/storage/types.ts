/**
 * Object storage interface (§2: Cloudflare R2 with signed URLs; §19.3: local fake).
 * Implementations: `createR2Storage()` in `./r2.ts`, `createLocalStorage()` in `./local.ts`.
 * Get the configured one with `getStorage()` from `./r2.ts`.
 */

export type ObjectBody = Uint8Array | string

export type ObjectInfo = {
  contentType: string
  sizeBytes: number
}

export type StoredObject = ObjectInfo & {
  body: Uint8Array
}

export type SignedGetOptions = {
  expiresInSeconds: number
  /** When set, the download is served as an attachment with this file name. */
  filename?: string
}

export type SignedPutOptions = {
  /** The uploader must send exactly this `Content-Type` header. */
  contentType: string
  /**
   * Upper bound for the upload. The local fake rejects larger bodies; R2 presigned PUTs cannot
   * enforce it, so callers must `statObject()` after the upload and delete oversize objects.
   */
  maxBytes: number
  expiresInSeconds: number
}

export interface ObjectStorage {
  readonly kind: "r2" | "local"
  putObject(key: string, body: ObjectBody, contentType: string): Promise<void>
  /** The object, or null when the key does not exist. */
  getObject(key: string): Promise<StoredObject | null>
  /** Metadata only, or null when the key does not exist. */
  statObject(key: string): Promise<ObjectInfo | null>
  /** Idempotent: deleting a missing key succeeds. */
  deleteObject(key: string): Promise<void>
  /** Short-lived download URL (e.g. 5 minutes for buyer access, §12). */
  signedGetUrl(key: string, options: SignedGetOptions): Promise<string>
  /** Short-lived URL the browser PUTs the file to directly. */
  signedPutUrl(key: string, options: SignedPutOptions): Promise<string>
}

/** S3 / R2 presigned URLs are valid for at most 7 days. */
export const MAX_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "StorageError"
  }
}
