import type {
  ProductFormat,
  ProductMediaItem,
  ProductSource,
  ProductSourceMeta,
} from "@/lib/db/schema"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"

import { taglineOf } from "./text"
import { fallbackVisual, type FallbackVisual } from "./visual"

/**
 * What the feed, the builder profile grid and the native app show for a listing (CLAUDE.md
 * §19.45). Client-safe: rows from lib/feed/queries.ts and lib/listings/queries.ts are mapped here,
 * so every surface tells the same story with the same few things: a big picture, an icon, the
 * name, one line, one tag, a rating when the store has one.
 */

export type ListingImage = { url: string; width: number | null; height: number | null }

export type ListingCard = {
  id: string
  title: string
  /** The one line under the name. */
  hook: string | null
  /** A single subtle tag: the store genre, the site category, else the format. */
  tag: string
  format: ProductFormat
  source: ProductSource
  /** "App Store", the website's domain, or null for typed listings. */
  sourceLabel: string | null
  priceLabel: string | null
  rating: number | null
  ratingCount: number | null
  icon: ListingImage | null
  /** The big picture: the first screenshot or page image. */
  cover: ListingImage | null
  screenshots: ListingImage[]
  visual: FallbackVisual
  builder: { userId: string; handle: string; displayName: string }
  /** An App Store listing whose developer account the builder has not verified yet. */
  unverified: boolean
}

/** The app route that serves a listing image (a redirect to a short-lived signed URL). */
export function productMediaPath(productId: string, hash: string): string {
  return `/api/products/${productId}/media/${hash}`
}

export type ListingCardRow = {
  id: string
  title: string
  description: string | null
  tagline: string | null
  format: ProductFormat
  source: ProductSource
  sourceMeta: ProductSourceMeta | null
  media: ProductMediaItem[]
  builderUserId: string
  builderHandle: string
  builderDisplayName: string
  /** The builder's App Store account is verified (counts for App Store listings only). */
  builderAppStoreVerified: boolean
}

function image(productId: string, item: ProductMediaItem): ListingImage {
  return { url: productMediaPath(productId, item.hash), width: item.width, height: item.height }
}

export function toListingCard(row: ListingCardRow): ListingCard {
  const meta = row.sourceMeta
  const icon = row.media.find((item) => item.kind === "icon")
  const pictures = row.media.filter((item) => item.kind !== "icon")
  const screenshots = pictures.map((item) => image(row.id, item))
  const tag =
    meta?.kind === "app_store"
      ? (meta.genre ?? PRODUCT_FORMAT_LABELS[row.format])
      : meta?.kind === "web"
        ? (meta.category ?? PRODUCT_FORMAT_LABELS[row.format])
        : PRODUCT_FORMAT_LABELS[row.format]
  return {
    id: row.id,
    title: row.title,
    hook: row.tagline ?? taglineOf(row.description),
    tag,
    format: row.format,
    source: row.source,
    sourceLabel:
      meta?.kind === "app_store" ? "App Store" : meta?.kind === "web" ? meta.domain : null,
    priceLabel: meta?.priceLabel ?? null,
    rating: meta?.rating ?? null,
    ratingCount: meta?.ratingCount ?? null,
    icon: icon ? image(row.id, icon) : null,
    cover: screenshots[0] ?? null,
    screenshots,
    visual: fallbackVisual({ id: row.id, title: row.title }),
    builder: {
      userId: row.builderUserId,
      handle: row.builderHandle,
      displayName: row.builderDisplayName,
    },
    unverified: row.source === "app_store" && !row.builderAppStoreVerified,
  }
}

/** "4.7" / "18.3K ratings": short, for overlays. */
export function formatRating(rating: number): string {
  return (Math.round(rating * 10) / 10).toFixed(1)
}

export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`
  return String(count)
}
