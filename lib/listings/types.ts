import type {
  ProductFormat,
  ProductMediaItem,
  ProductSource,
  ProductSourceMeta,
  ProductStage,
} from "@/lib/db/schema"

/**
 * An imported listing before it is stored (CLAUDE.md §19.45): what the App Store lookup or the web
 * page said, already cleaned (lib/listings/text.ts) and mapped onto product fields. Images are
 * still remote URLs; `importListings` copies them into our storage first.
 */
export type ListingDraft = {
  source: Exclude<ProductSource, "manual">
  sourceId: string
  sourceUrl: string | null
  title: string
  description: string
  format: ProductFormat
  stage: ProductStage
  topics: string[]
  targetPriceCents: number | null
  demoUrl: string | null
  meta: ProductSourceMeta
  images: RemoteImage[]
}

export type RemoteImage = { kind: ProductMediaItem["kind"]; url: string }

export type { ProductMediaItem, ProductSourceMeta }
