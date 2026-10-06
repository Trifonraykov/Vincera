import "server-only"

import { createHash } from "node:crypto"

import { safeFetch, type NetTransport } from "@/lib/net/safe-fetch"
import { reportError } from "@/lib/observability"
import { getStorage } from "@/lib/storage/r2"
import { storageKey } from "@/lib/storage/keys"
import { UPLOAD_LIMITS } from "@/lib/storage/limits"
import type { ObjectStorage } from "@/lib/storage/types"

import { sniffImage } from "./image-sniff"
import type { ProductMediaItem, RemoteImage } from "./types"

/**
 * Listing images are **copied into our storage** (CLAUDE.md §19.45), never hotlinked: a page that
 * showed a URL the builder (or the page they imported) chose would let anyone track every viewer or
 * swap the picture after review. Each image is fetched with `safeFetch` (the SSRF rules; App Store
 * images only from Apple's CDN), capped at 5 MB, sniffed from its bytes (PNG, JPEG, GIF or WebP;
 * the image upload allow-list, §14) and stored at `product-media/<productId>/<hash>.<ext>`, where
 * `hash` is the first 16 hex characters of sha256(source URL). A re-sync reuses images whose URL it
 * already copied and fetches only new ones. Pages serve them from `/api/products/<id>/media/<hash>`.
 */

export const LISTING_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const LISTING_IMAGE_PREFIX = "product-media"

export function imageHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16)
}

export function mediaKey(productId: string, hash: string, extension: string): string {
  return storageKey(LISTING_IMAGE_PREFIX, productId, `${hash}.${extension}`)
}

/** Whether `key` is one of this product's media keys (route and cleanup checks). */
export function isOwnMediaKey(productId: string, key: string): boolean {
  return new RegExp(`^${LISTING_IMAGE_PREFIX}/${productId}/[0-9a-f]{16}\\.(png|jpg|gif|webp)$`).test(key)
}

export type CopyImagesResult = {
  media: ProductMediaItem[]
  /** Newly written keys (deleted again if the caller's transaction fails). */
  created: string[]
}

/**
 * Copy the draft's images for `productId`, reusing `existing` items with the same source hash.
 * Failures (unreachable, too large, not an image) skip that image: a listing never fails because
 * one screenshot did. Four fetches at a time.
 */
export async function copyListingImages(input: {
  productId: string
  images: readonly RemoteImage[]
  existing: readonly ProductMediaItem[]
  transport: NetTransport
  allowHost?: (hostname: string) => boolean
  storage?: ObjectStorage
}): Promise<CopyImagesResult> {
  const storage = input.storage ?? getStorage()
  const byHash = new Map(input.existing.map((item) => [item.hash, item]))
  const results: (ProductMediaItem | null)[] = new Array(input.images.length).fill(null)
  const created: string[] = []

  let next = 0
  async function worker(): Promise<void> {
    while (next < input.images.length) {
      const index = next
      next += 1
      const image = input.images[index]!
      const hash = imageHash(image.url)
      const reused = byHash.get(hash)
      if (reused) {
        results[index] = { ...reused, kind: image.kind }
        continue
      }
      try {
        const fetched = await safeFetch(
          image.url,
          {
            accept: [...UPLOAD_LIMITS.image.mimeTypes, "application/octet-stream", "binary/octet-stream"],
            acceptHeader: "image/png, image/jpeg, image/webp, image/gif",
            maxBytes: LISTING_IMAGE_MAX_BYTES,
            timeoutMs: 8_000,
            allowHost: input.allowHost,
          },
          input.transport,
        )
        const sniffed = sniffImage(fetched.body)
        if (!sniffed) continue
        const key = mediaKey(input.productId, hash, sniffed.extension)
        await storage.putObject(key, fetched.body, sniffed.contentType)
        created.push(key)
        results[index] = {
          kind: image.kind,
          key,
          hash,
          contentType: sniffed.contentType,
          width: sniffed.width,
          height: sniffed.height,
        }
      } catch {
        // Skipped: unreachable, blocked, too large or not an image.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, input.images.length) }, () => worker()))

  const media: ProductMediaItem[] = []
  const seen = new Set<string>()
  for (const item of results) {
    if (!item || seen.has(item.hash)) continue
    seen.add(item.hash)
    media.push(item)
  }
  return { media, created }
}

/** Best-effort deletion of keys no listing uses any more. */
export async function deleteMediaKeys(keys: readonly string[], storage?: ObjectStorage): Promise<void> {
  if (keys.length === 0) return
  const store = storage ?? getStorage()
  await Promise.all(
    keys.map((key) =>
      store.deleteObject(key).catch((error: unknown) => {
        reportError(error, { tags: { area: "listings", step: "delete-media" } })
      }),
    ),
  )
}
