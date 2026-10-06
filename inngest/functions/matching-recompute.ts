import { getDb } from "@/lib/db/client"
import { explainMatches } from "@/lib/matching/explain"
import { recomputeMatchesForUser } from "@/lib/matching/recompute"

import { defineJob } from "../define"

/**
 * `matching/recompute` (§8, §13): rebuild one user's match lists for the active model version
 * (CLAUDE.md §19.24 "Matching", §19.27). Debounced 10 minutes per user; one run per user at a
 * time. Two steps: the recompute (one transaction: candidates, features, score, the top 30 per
 * role upserted, the rest staled, `match.computed`), then the explanations of rows that need a new
 * sentence (model calls outside any transaction; a retry of this step never recomputes).
 */
export const matchingRecompute = defineJob({
  id: "matching-recompute",
  event: "matching/recompute.requested",
  retries: 2,
  concurrency: { limit: 1, key: "event.data.userId" },
  debounce: { period: "10m", key: "event.data.userId" },
  handler: async ({ data, step }) => {
    const result = await step.run("recompute", () =>
      recomputeMatchesForUser(getDb(), data.userId, { reason: data.reason }),
    )
    const explained = await step.run("explain", () => explainMatches(getDb(), result.pending))
    return {
      userId: result.userId,
      modelVersion: result.modelVersion,
      roles: result.roles,
      explained,
    }
  },
})
