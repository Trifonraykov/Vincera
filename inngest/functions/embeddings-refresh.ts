import { getDb } from "@/lib/db/client"
import { refreshEmbedding, requestMatchingAfterEmbedding } from "@/lib/embeddings/refresh"

import { defineJob } from "../define"

/**
 * `embeddings/refresh` (§13): re-embed one creator profile, builder profile, idea or product when
 * its text changed, then ask matching to recompute (lib/embeddings/refresh.ts; CLAUDE.md §19.24,
 * §19.25). Debounced 10 minutes per entity, so a burst of edits embeds once; one run per entity at
 * a time. The embedding step never fails for provider errors (reported, old vector kept), so a
 * retry only repeats work that actually broke (the database, the matching enqueue).
 */
export const embeddingsRefresh = defineJob({
  id: "embeddings-refresh",
  event: "embeddings/refresh.requested",
  retries: 3,
  concurrency: { limit: 1, key: "event.data.subjectType + ':' + event.data.subjectId" },
  debounce: { period: "10m", key: "event.data.subjectType + ':' + event.data.subjectId" },
  handler: async ({ data, step }) => {
    const entity = { type: data.subjectType, id: data.subjectId }
    const result = await step.run("embed", () => refreshEmbedding(getDb(), entity))
    const ownerUserId = result.ownerUserId
    if (ownerUserId) {
      await step.run("request-matching", () => requestMatchingAfterEmbedding(entity, ownerUserId))
    }
    return { ...entity, ...result }
  },
})
