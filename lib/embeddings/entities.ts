import "server-only"

import { asc, eq, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  creatorProfiles,
  ideas,
  portfolioItems,
  products,
  type ProductFormat,
  type ProductStage,
} from "@/lib/db/schema"
import { builderProfileEmbeddingText } from "@/lib/profiles/embedding"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import { creatorProfileEmbeddingText } from "@/lib/social/derived"

import type { EmbeddingEntity, EmbeddingSubjectType } from "./request"

/**
 * What each embedded entity is embedded from (CLAUDE.md §19.24 "Embeddings"): the text, who owns
 * it, and what is stored now. Texts never contain names, handles or emails: they describe what
 * someone makes, wants or needs, which is what `semantic` (§8) compares.
 */

export type EmbeddingSource = {
  type: EmbeddingSubjectType
  id: string
  /** The user who owns the profile, idea or product (matching works per user). */
  ownerUserId: string
  text: string
  storedHash: string | null
  storedModel: string | null
  hasVector: boolean
}

const STAGE_LABELS: Record<ProductStage, string> = {
  idea: "idea (not built yet)",
  prototype: "prototype",
  beta: "beta",
  live: "live",
}

function lines(entries: (string | null)[]): string {
  return entries.filter((line): line is string => line !== null).join("\n")
}

/** An idea: title, problem, audience evidence, format and topics. */
export function ideaEmbeddingText(idea: {
  title: string
  problem: string | null
  audienceEvidence: string | null
  format: ProductFormat
  topics: readonly string[]
}): string {
  return lines([
    `Idea: ${idea.title}`,
    idea.problem ? `Problem: ${idea.problem}` : null,
    idea.audienceEvidence ? `Audience evidence: ${idea.audienceEvidence}` : null,
    `Format: ${PRODUCT_FORMAT_LABELS[idea.format]}`,
    idea.topics.length > 0 ? `Topics: ${idea.topics.join(", ")}` : null,
  ])
}

/** A product: title, description, target user, stage, format and topics. */
export function productEmbeddingText(product: {
  title: string
  description: string | null
  targetUser: string | null
  stage: ProductStage
  format: ProductFormat
  topics: readonly string[]
}): string {
  return lines([
    `Product: ${product.title}`,
    product.description ? `Description: ${product.description}` : null,
    product.targetUser ? `For: ${product.targetUser}` : null,
    `Stage: ${STAGE_LABELS[product.stage]}`,
    `Format: ${PRODUCT_FORMAT_LABELS[product.format]}`,
    product.topics.length > 0 ? `Topics: ${product.topics.join(", ")}` : null,
  ])
}

/**
 * Load the entity's current text and stored embedding bookkeeping, or null when it no longer
 * exists. With `lock`, the entity's row is locked (`FOR UPDATE`) for the rest of the transaction,
 * so the text cannot change between this read and the write that follows it.
 */
export async function loadEmbeddingSource(
  database: DbOrTx,
  entity: EmbeddingEntity,
  options: { lock?: boolean } = {},
): Promise<EmbeddingSource | null> {
  switch (entity.type) {
    case "idea": {
      const query = database
        .select({
          idea: {
            title: ideas.title,
            problem: ideas.problem,
            audienceEvidence: ideas.audienceEvidence,
            format: ideas.format,
            topics: ideas.topics,
            embeddingTextHash: ideas.embeddingTextHash,
            embeddingModel: ideas.embeddingModel,
          },
          hasVector: sql<boolean>`${ideas.embedding} IS NOT NULL`,
          ownerUserId: creatorProfiles.userId,
        })
        .from(ideas)
        .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
        .where(eq(ideas.id, entity.id))
      const [row] = options.lock ? await query.for("update", { of: ideas }) : await query
      if (!row) return null
      return {
        ...entity,
        ownerUserId: row.ownerUserId,
        text: ideaEmbeddingText(row.idea),
        storedHash: row.idea.embeddingTextHash,
        storedModel: row.idea.embeddingModel,
        hasVector: row.hasVector,
      }
    }
    case "product": {
      const query = database
        .select({
          product: {
            title: products.title,
            description: products.description,
            targetUser: products.targetUser,
            stage: products.stage,
            format: products.format,
            topics: products.topics,
            embeddingTextHash: products.embeddingTextHash,
            embeddingModel: products.embeddingModel,
          },
          hasVector: sql<boolean>`${products.embedding} IS NOT NULL`,
          ownerUserId: builderProfiles.userId,
        })
        .from(products)
        .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
        .where(eq(products.id, entity.id))
      const [row] = options.lock ? await query.for("update", { of: products }) : await query
      if (!row) return null
      return {
        ...entity,
        ownerUserId: row.ownerUserId,
        text: productEmbeddingText(row.product),
        storedHash: row.product.embeddingTextHash,
        storedModel: row.product.embeddingModel,
        hasVector: row.hasVector,
      }
    }
    case "creator_profile": {
      const query = database
        .select({
          profile: {
            userId: creatorProfiles.userId,
            niche: creatorProfiles.niche,
            bio: creatorProfiles.bio,
            topics: creatorProfiles.topics,
            languages: creatorProfiles.languages,
            country: creatorProfiles.country,
            audienceSummary: creatorProfiles.audienceSummary,
            embeddingTextHash: creatorProfiles.embeddingTextHash,
            embeddingModel: creatorProfiles.embeddingModel,
          },
          hasVector: sql<boolean>`${creatorProfiles.embedding} IS NOT NULL`,
        })
        .from(creatorProfiles)
        .where(eq(creatorProfiles.id, entity.id))
      const [row] = options.lock ? await query.for("update") : await query
      if (!row) return null
      return {
        ...entity,
        ownerUserId: row.profile.userId,
        text: creatorProfileEmbeddingText(row.profile),
        storedHash: row.profile.embeddingTextHash,
        storedModel: row.profile.embeddingModel,
        hasVector: row.hasVector,
      }
    }
    case "builder_profile": {
      const query = database
        .select({
          profile: {
            userId: builderProfiles.userId,
            bio: builderProfiles.bio,
            skills: builderProfiles.skills,
            stack: builderProfiles.stack,
            embeddingTextHash: builderProfiles.embeddingTextHash,
            embeddingModel: builderProfiles.embeddingModel,
          },
          hasVector: sql<boolean>`${builderProfiles.embedding} IS NOT NULL`,
        })
        .from(builderProfiles)
        .where(eq(builderProfiles.id, entity.id))
      const [row] = options.lock ? await query.for("update") : await query
      if (!row) return null
      const portfolio = await database
        .select({
          title: portfolioItems.title,
          description: portfolioItems.description,
          format: portfolioItems.format,
          isShipped: portfolioItems.isShipped,
        })
        .from(portfolioItems)
        .where(eq(portfolioItems.builderProfileId, entity.id))
        .orderBy(asc(portfolioItems.createdAt), asc(portfolioItems.id))
      return {
        ...entity,
        ownerUserId: row.profile.userId,
        text: builderProfileEmbeddingText({ ...row.profile, portfolio }),
        storedHash: row.profile.embeddingTextHash,
        storedModel: row.profile.embeddingModel,
        hasVector: row.hasVector,
      }
    }
  }
}

/** The id of the user's creator or builder profile, or null when they have none. */
export async function findProfileId(
  database: DbOrTx,
  userId: string,
  role: "creator" | "builder",
): Promise<string | null> {
  const [row] =
    role === "creator"
      ? await database
          .select({ id: creatorProfiles.id })
          .from(creatorProfiles)
          .where(eq(creatorProfiles.userId, userId))
          .limit(1)
      : await database
          .select({ id: builderProfiles.id })
          .from(builderProfiles)
          .where(eq(builderProfiles.userId, userId))
          .limit(1)
  return row?.id ?? null
}
