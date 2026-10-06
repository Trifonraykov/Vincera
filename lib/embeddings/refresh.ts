import "server-only"

import { eq, sql } from "drizzle-orm"

import { embed, EmbeddingError, type EmbedDeps } from "@/lib/ai/embed"
import { now } from "@/lib/clock"
import { sha256Hex } from "@/lib/crypto"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { builderProfiles, creatorProfiles, ideas, products } from "@/lib/db/schema"
import { requestMatchingRecompute, requestTargetRescore } from "@/lib/matching/request"
import { reportError } from "@/lib/observability"
import { currentEmbeddingModel } from "./model"

import { loadEmbeddingSource } from "./entities"
import type { EmbeddingEntity } from "./request"

/**
 * The `embeddings-refresh` job's work (§13; CLAUDE.md §19.24 "Embeddings", §19.25):
 *
 * 1. compose the entity's text (lib/embeddings/entities.ts);
 * 2. skip the API call when `sha256(text)` equals `embedding_text_hash`, the stored
 *    `embedding_model` is the current model and a vector exists (`unchanged`);
 * 3. otherwise embed it (`document`) and write `embedding`, `embedding_model`,
 *    `embedding_text_hash` and `embedded_at`, only if the row's text is still the one that was
 *    embedded (checked again under the row lock; a newer edit requested its own refresh, so this
 *    run gives way: `superseded`). The write leaves `updated_at` alone: a derived vector is not an
 *    edit;
 * 4. then, embedded or not (status and other features may have changed), ask matching to
 *    recompute (`requestMatchingAfterEmbedding`).
 *
 * An embedding failure (provider down, bad response) is reported and keeps the old vector
 * (`failed`); matching still runs on what is stored.
 */

export type EmbeddingRefreshOutcome =
  | "updated"
  | "unchanged"
  /** Nothing to embed yet (an empty profile). */
  | "skipped"
  | "failed"
  | "superseded"
  | "not_found"

export type EmbeddingRefreshResult = {
  outcome: EmbeddingRefreshOutcome
  /** Null when the entity no longer exists. */
  ownerUserId: string | null
}

async function writeEmbedding(
  tx: Tx,
  entity: EmbeddingEntity,
  values: { vector: number[]; model: string; hash: string },
): Promise<void> {
  const columns = {
    embedding: values.vector,
    embeddingModel: values.model,
    embeddingTextHash: values.hash,
    embeddedAt: now(),
  }
  switch (entity.type) {
    case "idea":
      await tx
        .update(ideas)
        .set({ ...columns, updatedAt: sql`${ideas.updatedAt}` })
        .where(eq(ideas.id, entity.id))
      return
    case "product":
      await tx
        .update(products)
        .set({ ...columns, updatedAt: sql`${products.updatedAt}` })
        .where(eq(products.id, entity.id))
      return
    case "creator_profile":
      await tx
        .update(creatorProfiles)
        .set({ ...columns, updatedAt: sql`${creatorProfiles.updatedAt}` })
        .where(eq(creatorProfiles.id, entity.id))
      return
    case "builder_profile":
      await tx
        .update(builderProfiles)
        .set({ ...columns, updatedAt: sql`${builderProfiles.updatedAt}` })
        .where(eq(builderProfiles.id, entity.id))
      return
  }
}

/** Re-embed one entity when its text changed. Never throws for embedding-provider failures. */
export async function refreshEmbedding(
  database: DbOrTx,
  entity: EmbeddingEntity,
  deps: EmbedDeps = {},
): Promise<EmbeddingRefreshResult> {
  const source = await loadEmbeddingSource(database, entity)
  if (!source) return { outcome: "not_found", ownerUserId: null }
  const ownerUserId = source.ownerUserId
  const text = source.text.trim()
  if (!text) return { outcome: "skipped", ownerUserId }

  const hash = sha256Hex(text)
  const model = currentEmbeddingModel()
  if (source.hasVector && source.storedHash === hash && source.storedModel === model) {
    return { outcome: "unchanged", ownerUserId }
  }

  let vectors: number[][]
  try {
    vectors = await embed([text], "document", deps)
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error
    reportError(error, { tags: { area: "embeddings", subject: entity.type } })
    return { outcome: "failed", ownerUserId }
  }
  const embedded = vectors[0]
  if (!embedded) return { outcome: "failed", ownerUserId }

  return withTransaction(async (tx) => {
    const current = await loadEmbeddingSource(tx, entity, { lock: true })
    if (!current) return { outcome: "not_found" as const, ownerUserId: null }
    if (sha256Hex(current.text.trim()) !== hash) {
      return { outcome: "superseded" as const, ownerUserId }
    }
    await writeEmbedding(tx, entity, { vector: embedded, model, hash })
    return { outcome: "updated" as const, ownerUserId }
  }, database)
}

/**
 * Tell matching that `entity` changed (§8 "on demand when a profile, idea, or product changes").
 * Both jobs are debounced 10 minutes by matching. Ideas and products are re-scored as targets and
 * their owner's own list is rebuilt; a profile rebuilds its user's list and re-scores the user as
 * a `creator` / `builder` target (target ids of people are user ids).
 */
export async function requestMatchingAfterEmbedding(
  entity: EmbeddingEntity,
  ownerUserId: string,
): Promise<void> {
  switch (entity.type) {
    case "idea":
      await requestTargetRescore({ targetType: "idea", targetId: entity.id })
      await requestMatchingRecompute({ userId: ownerUserId, reason: "idea_changed" })
      return
    case "product":
      await requestTargetRescore({ targetType: "product", targetId: entity.id })
      await requestMatchingRecompute({ userId: ownerUserId, reason: "product_changed" })
      return
    case "creator_profile":
      await requestMatchingRecompute({ userId: ownerUserId, reason: "profile_changed" })
      await requestTargetRescore({ targetType: "creator", targetId: ownerUserId })
      return
    case "builder_profile":
      await requestMatchingRecompute({ userId: ownerUserId, reason: "profile_changed" })
      await requestTargetRescore({ targetType: "builder", targetId: ownerUserId })
      return
  }
}
