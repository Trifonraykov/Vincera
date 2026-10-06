import "server-only"

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm"

import { generateListingHook } from "@/lib/ai/prompts/listing-hook"
import type { ClaudeDeps } from "@/lib/ai/claude"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { products, type ProductMediaItem, type ProductStatus } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import type { NetTransport } from "@/lib/net/safe-fetch"
import type { ObjectStorage } from "@/lib/storage/types"
import { SUPPLY_CURRENCY } from "@/lib/supply/fields"
import { eventTopics, sameList } from "@/lib/supply/save-helpers"

import { copyListingImages, deleteMediaKeys } from "./media"
import { taglineOf } from "./text"
import type { ListingDraft } from "./types"

/**
 * Writing imported listings (CLAUDE.md §19.45). One listing per (builder, source, source id): a
 * re-import updates the row it made before, never a second one (partial unique index
 * `products_builder_source_idx`).
 *
 * - **New listing:** published at once (`seeking`): an import is the builder saying "show this".
 *   Title, description, topics, format, stage, the euro price (when the store's currency is EUR),
 *   the demo link and the hook. Events `product.created`, `product.published`, `product.imported`.
 * - **Re-import:** refreshes the store data (`source_meta`, images, link). Title, description and
 *   topics follow the source only while the builder has not edited them (`source_edited_at`);
 *   everything else a builder can edit (price, format, stage, split, exclusivity, status) is never
 *   touched again. An archived listing stays archived. `product.updated { fields }` and
 *   `product.imported { updated | restored }` when something changed.
 * - **Images** are copied before the transaction (network); keys a failed transaction wrote are
 *   deleted, and keys a re-import no longer uses are deleted after the commit.
 * - **Hook:** written by the AI (`listing_hook@v1`, `ai.generated` with subject `product`) for new
 *   listings and when the source's description changed; its fallback is the description's first
 *   sentence. Never blocks the import.
 */

export type ListingWriteAction = "created" | "updated" | "unchanged"

export type ListingWriteResult = {
  productId: string
  sourceId: string
  title: string
  action: ListingWriteAction
}

export type SaveListingsInput = {
  builderProfileId: string
  /** Who started it (null for the daily sync). */
  actorUserId: string | null
  drafts: readonly ListingDraft[]
  transport: NetTransport
  /** Extra host rule for images (Apple's CDN only for App Store imports). */
  allowImageHost?: (hostname: string) => boolean
  storage?: ObjectStorage
  ai?: ClaudeDeps
}

const existingColumns = {
  id: products.id,
  status: products.status,
  title: products.title,
  description: products.description,
  topics: products.topics,
  tagline: products.tagline,
  media: products.media,
  sourceUrl: products.sourceUrl,
  sourceMeta: products.sourceMeta,
  sourceEditedAt: products.sourceEditedAt,
  sourceRemovedAt: products.sourceRemovedAt,
}

type Existing = {
  id: string
  status: ProductStatus
  title: string
  description: string | null
  topics: string[]
  tagline: string | null
  media: ProductMediaItem[]
  sourceUrl: string | null
  sourceMeta: unknown
  sourceEditedAt: Date | null
  sourceRemovedAt: Date | null
}

async function findExisting(
  database: DbOrTx,
  builderProfileId: string,
  draft: Pick<ListingDraft, "source" | "sourceId">,
): Promise<Existing | null> {
  const [row] = await database
    .select(existingColumns)
    .from(products)
    .where(
      and(
        eq(products.builderProfileId, builderProfileId),
        eq(products.source, draft.source),
        eq(products.sourceId, draft.sourceId),
      ),
    )
    .limit(1)
  return row ?? null
}

/** JSON with sorted keys (jsonb hands objects back in its own key order). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  )
}

function sameMedia(a: readonly ProductMediaItem[], b: readonly ProductMediaItem[]): boolean {
  return (
    a.length === b.length && a.every((item, i) => item.key === b[i]?.key && item.kind === b[i]?.kind)
  )
}

/** Write one draft; see the module comment. */
export async function saveListingDraft(
  database: DbOrTx,
  input: Omit<SaveListingsInput, "drafts"> & { draft: ListingDraft },
): Promise<ListingWriteResult> {
  const { draft } = input
  const existing = await findExisting(database, input.builderProfileId, draft)
  const productId = existing?.id ?? newId()
  const followsSource = !existing || existing.sourceEditedAt === null

  const copied = await copyListingImages({
    productId,
    images: draft.images,
    existing: existing?.media ?? [],
    transport: input.transport,
    allowHost: input.allowImageHost,
    storage: input.storage,
  })

  // The hook: for new listings, and when the source's description changed (while it is followed).
  const needsHook = !existing || (followsSource && existing.description !== draft.description)
  const hook = needsHook
    ? await generateListingHook({ title: draft.title, description: draft.description }, input.ai)
    : null
  const tagline = hook
    ? hook.ok
      ? hook.data.hook
      : taglineOf(draft.description)
    : (existing?.tagline ?? null)

  const at = now()
  try {
    const result = await withTransaction(async (tx): Promise<ListingWriteResult> => {
      const aiEvent = async (subjectId: string) => {
        if (!hook) return
        await track(
          "ai.generated",
          {
            actorUserId: input.actorUserId,
            subjectType: "product",
            subjectId,
            properties: {
              use: "listing_hook",
              prompt_version: hook.promptVersion,
              model: hook.model,
              latency_ms: hook.latencyMs,
              accepted_by_user: null,
              fallback: !hook.ok,
            },
          },
          tx,
        )
      }

      if (!existing) {
        const inserted = await tx
          .insert(products)
          .values({
            id: productId,
            builderProfileId: input.builderProfileId,
            title: draft.title,
            description: draft.description,
            stage: draft.stage,
            demoUrl: draft.demoUrl,
            format: draft.format,
            targetPriceCents: draft.targetPriceCents,
            currency: SUPPLY_CURRENCY,
            topics: draft.topics,
            status: "seeking",
            publishedAt: at,
            source: draft.source,
            sourceId: draft.sourceId,
            sourceUrl: draft.sourceUrl,
            sourceMeta: draft.meta,
            media: copied.media,
            sourceSyncedAt: at,
            tagline,
          })
          .onConflictDoNothing()
          .returning({ id: products.id })
        if (inserted.length === 0) {
          // Another import of the same listing won the race; it wrote its own images.
          return { productId, sourceId: draft.sourceId, title: draft.title, action: "unchanged" }
        }
        const subject = {
          actorUserId: input.actorUserId,
          subjectType: "product",
          subjectId: productId,
        } as const
        await track(
          "product.created",
          {
            ...subject,
            properties: {
              format: draft.format,
              stage: draft.stage,
              topics: eventTopics(draft.topics),
              target_price_cents: draft.targetPriceCents,
            },
          },
          tx,
        )
        await track("product.published", { ...subject, properties: {} }, tx)
        await track(
          "product.imported",
          {
            ...subject,
            properties: { source: draft.source, action: "created", image_count: copied.media.length },
          },
          tx,
        )
        await aiEvent(productId)
        return { productId, sourceId: draft.sourceId, title: draft.title, action: "created" }
      }

      // Re-import: lock, then change only what follows the source.
      const [locked] = await tx
        .select(existingColumns)
        .from(products)
        .where(eq(products.id, existing.id))
        .for("update")
      if (!locked) throw new Error("saveListingDraft: listing vanished")
      const follow = locked.sourceEditedAt === null
      const text = follow
        ? { title: draft.title, description: draft.description, topics: draft.topics, tagline }
        : {}
      const fields: string[] = []
      if (follow) {
        if (locked.title !== draft.title) fields.push("title")
        if (locked.description !== draft.description) fields.push("description")
        if (!sameList(locked.topics, draft.topics)) fields.push("topics")
      }
      if (!sameMedia(locked.media, copied.media)) fields.push("media")
      if (locked.sourceUrl !== draft.sourceUrl) fields.push("source_url")
      if (stableJson(locked.sourceMeta) !== stableJson(draft.meta)) {
        fields.push("source_meta")
      }
      const restored = locked.sourceRemovedAt !== null

      await tx
        .update(products)
        .set({
          ...text,
          sourceUrl: draft.sourceUrl,
          sourceMeta: draft.meta,
          media: copied.media,
          sourceSyncedAt: at,
          sourceRemovedAt: null,
          // A sync that changes nothing a person sees keeps updated_at (lists sort by it).
          ...(fields.length === 0 && !restored ? { updatedAt: sql`${products.updatedAt}` } : {}),
        })
        .where(eq(products.id, locked.id))

      if (fields.length === 0 && !restored) {
        return { productId, sourceId: draft.sourceId, title: draft.title, action: "unchanged" }
      }
      const subject = {
        actorUserId: input.actorUserId,
        subjectType: "product",
        subjectId: locked.id,
      } as const
      if (fields.length > 0) await track("product.updated", { ...subject, properties: { fields } }, tx)
      await track(
        "product.imported",
        {
          ...subject,
          properties: {
            source: draft.source,
            action: restored ? "restored" : "updated",
            image_count: copied.media.length,
          },
        },
        tx,
      )
      await aiEvent(locked.id)
      return { productId, sourceId: draft.sourceId, title: draft.title, action: "updated" }
    }, database)

    // Images the listing no longer shows.
    const kept = new Set(copied.media.map((item) => item.key))
    const dropped = (existing?.media ?? []).map((item) => item.key).filter((key) => !kept.has(key))
    if (result.action === "unchanged" && !existing) {
      await deleteMediaKeys(copied.created, input.storage)
    } else {
      await deleteMediaKeys(dropped, input.storage)
    }
    return result
  } catch (error) {
    await deleteMediaKeys(copied.created, input.storage)
    throw error
  }
}

/** Write every draft, one after another (each its own transaction). */
export async function saveListingDrafts(
  database: DbOrTx,
  input: SaveListingsInput,
): Promise<ListingWriteResult[]> {
  const results: ListingWriteResult[] = []
  for (const draft of input.drafts) {
    results.push(await saveListingDraft(database, { ...input, draft }))
  }
  return results
}

/**
 * App Store listings of this builder whose app is no longer in the store (not in `presentIds`):
 * `source_removed_at` is set (the feed hides them), with `product.imported { removed }`. The rows
 * stay, so proposals and collabs that name them keep working; the app coming back restores them.
 */
export async function markRemovedAppStoreListings(
  database: DbOrTx,
  input: { builderProfileId: string; presentIds: readonly string[]; actorUserId: string | null },
): Promise<string[]> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .update(products)
      .set({ sourceRemovedAt: now() })
      .where(
        and(
          eq(products.builderProfileId, input.builderProfileId),
          eq(products.source, "app_store"),
          isNull(products.sourceRemovedAt),
          input.presentIds.length > 0
            ? notInArray(products.sourceId, [...input.presentIds])
            : undefined,
        ),
      )
      .returning({ id: products.id, media: products.media })
    for (const row of rows) {
      await track(
        "product.imported",
        {
          actorUserId: input.actorUserId,
          subjectType: "product",
          subjectId: row.id,
          properties: { source: "app_store", action: "removed", image_count: row.media.length },
        },
        tx,
      )
    }
    return rows.map((row) => row.id)
  }, database)
}

/** Ids of this builder's listings imported from `source` (tests and the seed). */
export async function importedListingIds(
  database: DbOrTx,
  builderProfileId: string,
  source: ListingDraft["source"],
): Promise<string[]> {
  const rows = await database
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.builderProfileId, builderProfileId),
        inArray(products.source, [source]),
      ),
    )
  return rows.map((row) => row.id)
}
