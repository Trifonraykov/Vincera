import "server-only"

import { env, isFake } from "@/lib/env"

/**
 * `embedding_model` for vectors made now (§19.5: stored next to every `embedding`, so a provider
 * or model switch re-embeds everything: the refresh job compares it with the stored value).
 */
export function currentEmbeddingModel(): string {
  return isFake("embeddings") ? "fake:hashed-bow-1024" : `voyage:${env.VOYAGE_MODEL}`
}
