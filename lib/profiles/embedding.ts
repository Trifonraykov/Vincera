import "server-only"

import { asc, eq } from "drizzle-orm"

import { embed, EmbeddingError, type EmbedDeps } from "@/lib/ai/embed"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, portfolioItems } from "@/lib/db/schema"
import { reportError } from "@/lib/observability"
import { currentEmbeddingModel, type EmbeddingOutcome } from "@/lib/social/derived"

import { PRODUCT_FORMAT_LABELS } from "./fields"

/**
 * The builder profile embedding (§5 `builder_profiles.embedding`, §8 `semantic`). Creators are
 * embedded by lib/social/derived.ts (their text includes the audience summary); builders from what
 * they build: skills, stack, bio and portfolio. No names or handles. Phase 2's
 * `embeddings/refresh` job should reuse `builderProfileEmbeddingText`.
 */

type BuilderEmbeddingInput = {
  bio: string | null
  skills: readonly string[]
  stack: readonly string[]
  portfolio: readonly {
    title: string
    description: string | null
    format: keyof typeof PRODUCT_FORMAT_LABELS | null
    isShipped: boolean
  }[]
}

export function builderProfileEmbeddingText(input: BuilderEmbeddingInput): string {
  const lines = [
    input.skills.length > 0 ? `Skills: ${input.skills.join(", ")}` : null,
    input.stack.length > 0 ? `Stack: ${input.stack.join(", ")}` : null,
    input.bio ? `About: ${input.bio}` : null,
    ...input.portfolio.map((item) => {
      const kind = item.format ? `${PRODUCT_FORMAT_LABELS[item.format]}, ` : ""
      const status = item.isShipped ? "shipped" : "in progress"
      const description = item.description ? `: ${item.description}` : ""
      return `Built: ${item.title} (${kind}${status})${description}`
    }),
  ]
  return lines.filter((line): line is string => line !== null).join("\n")
}

/** Re-embed the builder profile. Never throws for embedding failures: they are reported. */
export async function refreshBuilderEmbedding(
  database: DbOrTx,
  userId: string,
  deps: EmbedDeps = {},
): Promise<EmbeddingOutcome> {
  const [profile] = await database
    .select({
      id: builderProfiles.id,
      bio: builderProfiles.bio,
      skills: builderProfiles.skills,
      stack: builderProfiles.stack,
    })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .limit(1)
  if (!profile) return "skipped"
  const portfolio = await database
    .select({
      title: portfolioItems.title,
      description: portfolioItems.description,
      format: portfolioItems.format,
      isShipped: portfolioItems.isShipped,
    })
    .from(portfolioItems)
    .where(eq(portfolioItems.builderProfileId, profile.id))
    .orderBy(asc(portfolioItems.createdAt))

  const text = builderProfileEmbeddingText({ ...profile, portfolio })
  if (!text.trim()) return "skipped"
  try {
    const [vector] = await embed([text], "document", deps)
    if (!vector) return "failed"
    await database
      .update(builderProfiles)
      .set({ embedding: vector, embeddingModel: currentEmbeddingModel() })
      .where(eq(builderProfiles.id, profile.id))
    return "updated"
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error
    reportError(error, { tags: { area: "profiles", step: "builder_embedding" } })
    return "failed"
  }
}
