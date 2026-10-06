import { getDb } from "@/lib/db/client"
import { explainMatches } from "@/lib/matching/explain"
import { rescoreTarget } from "@/lib/matching/recompute"

import { defineJob } from "../define"

/**
 * `matching/target-changed` (§8 "on demand when a profile, idea, or product changes"): re-score
 * one creator, builder, idea or product for the users who may see it and merge it into their
 * lists, or stale its rows when it stopped being a candidate (CLAUDE.md §19.24, §19.27). An idea
 * or product also re-scores its owner as a person. Debounced 10 minutes per target.
 */
export const matchingTargetChanged = defineJob({
  id: "matching-target-changed",
  event: "matching/target-changed.requested",
  retries: 2,
  concurrency: { limit: 1, key: "event.data.targetType + ':' + event.data.targetId" },
  debounce: { period: "10m", key: "event.data.targetType + ':' + event.data.targetId" },
  handler: async ({ data, step }) => {
    const results = await step.run("rescore", () => rescoreTarget(getDb(), data))
    const explained = await step.run("explain", () =>
      explainMatches(
        getDb(),
        results.flatMap((result) => result.pending),
      ),
    )
    return {
      targets: results.map(({ pending: _pending, ...result }) => result),
      explained,
    }
  },
})
