import "server-only"

import type { JobEventData } from "@/inngest/client"
import { getDb, type DbOrTx } from "@/lib/db/client"
import { enqueue } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"

import { findProfileId } from "./entities"

/**
 * The entry point every area uses after a committed change that matters for matching (CLAUDE.md
 * §19.24 "Embeddings"): a profile, idea or product was created, edited, published, archived or
 * restored, or a creator's audience changed. Call it **after the transaction commits** (the job
 * reads the committed row). The job (`embeddings-refresh`, owned by "supply") is debounced 10
 * minutes per entity, re-embeds only when the composed text changed, and then asks matching to
 * recompute, so callers never call matching themselves.
 *
 * Inline (fake jobs) it runs after the response, without the debounce.
 */

export type EmbeddingSubjectType = JobEventData<"embeddings/refresh.requested">["subjectType"]

export type EmbeddingEntity = { type: EmbeddingSubjectType; id: string }

export async function requestEmbeddingRefresh(entity: EmbeddingEntity): Promise<void> {
  await enqueue("embeddings/refresh.requested", { subjectType: entity.type, subjectId: entity.id })
}

/**
 * `requestEmbeddingRefresh` for code that has already committed a user's change: a failure to
 * enqueue (Inngest unreachable) is reported, never thrown, so the user's save still succeeds.
 * The next change, or matching's nightly run, picks the entity up again.
 */
export async function requestEmbeddingRefreshAfterCommit(entity: EmbeddingEntity): Promise<void> {
  try {
    await requestEmbeddingRefresh(entity)
  } catch (error) {
    reportError(error, { tags: { area: "embeddings", step: "enqueue", subject: entity.type } })
  }
}

/**
 * For callers that know the user, not the profile: refresh the user's creator or builder
 * profile embedding (no-op when the profile does not exist). Never throws for enqueue failures.
 */
export async function requestProfileEmbeddingRefresh(
  userId: string,
  role: "creator" | "builder",
  database: DbOrTx = getDb(),
): Promise<void> {
  const profileId = await findProfileId(database, userId, role)
  if (!profileId) return
  await requestEmbeddingRefreshAfterCommit({
    type: role === "creator" ? "creator_profile" : "builder_profile",
    id: profileId,
  })
}
