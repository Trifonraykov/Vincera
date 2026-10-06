import "server-only"

import { z } from "zod"

import { env, isFake } from "@/lib/env"

import { fakeEmbedding } from "./fake"

/**
 * Text embeddings behind a provider interface (§2). Vectors are 1024-dim to match the
 * `vector(1024)` columns. Live: Voyage AI (`EMBEDDINGS_PROVIDER=voyage`, model `VOYAGE_MODEL`).
 * Fake: deterministic hashed bag-of-words, L2-normalised (§19.3).
 *
 * `kind` matters for retrieval quality: embed stored profiles/ideas/products as `document` and
 * search text as `query`. Throws `EmbeddingError` on failure; embeddings are computed in
 * background jobs, which retry.
 */

export const EMBEDDING_DIMENSIONS = 1024
export type EmbedKind = "document" | "query"

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
/** Conservative batch size: Voyage caps both the list length and total tokens per request. */
const VOYAGE_BATCH_SIZE = 128
const VOYAGE_TIMEOUT_MS = 30_000

export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "EmbeddingError"
  }
}

export type EmbedDeps = {
  /** Override `fetch` (tests). */
  fetch?: typeof fetch
}

export async function embed(
  texts: readonly string[],
  kind: EmbedKind,
  deps: EmbedDeps = {},
): Promise<number[][]> {
  if (texts.length === 0) return []
  if (texts.some((text) => text.trim() === "")) {
    throw new EmbeddingError("Cannot embed empty text")
  }
  if (isFake("embeddings")) return texts.map((text) => fakeEmbedding(text, EMBEDDING_DIMENSIONS))

  const apiKey = env.VOYAGE_API_KEY
  if (!apiKey) throw new EmbeddingError("VOYAGE_API_KEY is not configured")

  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += VOYAGE_BATCH_SIZE) {
    const batch = texts.slice(start, start + VOYAGE_BATCH_SIZE)
    vectors.push(
      ...(await voyageBatch(batch, kind, { apiKey, model: env.VOYAGE_MODEL }, deps.fetch ?? fetch)),
    )
  }
  return vectors
}

const voyageResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
    }),
  ),
})

async function voyageBatch(
  texts: readonly string[],
  kind: EmbedKind,
  config: { apiKey: string; model: string },
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  let response: Response
  try {
    response = await fetchImpl(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: config.model,
        input_type: kind,
        output_dimension: EMBEDDING_DIMENSIONS,
        truncation: true,
      }),
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new EmbeddingError("Could not reach the embeddings provider", { cause: error })
  }

  if (!response.ok) {
    // The body may echo input text; keep only the status in the error.
    throw new EmbeddingError(`Embeddings provider returned HTTP ${response.status}`)
  }

  const parsed = voyageResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success || parsed.data.data.length !== texts.length) {
    throw new EmbeddingError("Unexpected response from the embeddings provider")
  }

  const vectors = new Array<number[]>(texts.length)
  for (const item of parsed.data.data) {
    if (item.index >= texts.length || vectors[item.index]) {
      throw new EmbeddingError("Unexpected response from the embeddings provider")
    }
    vectors[item.index] = item.embedding
  }
  return vectors
}
