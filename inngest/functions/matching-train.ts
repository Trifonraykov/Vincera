import { getDb } from "@/lib/db/client"
import { trainMatchingModel } from "@/lib/matching/v1/train"
import { InsufficientTrainingDataError } from "@/lib/matching/v1/train-core"

import { defineJob } from "../define"

/**
 * `matching-train` (matching-v1, CLAUDE.md §19.38, §19.42): fit the v1 logistic models on the
 * stored match feature vectors, evaluate them against v0 on the held-out split and store an
 * inactive `matching_config` row (`v1-<YYYY-MM-DD>`). `pnpm matching:train` and the admin's
 * "Train" button run the same code (`trainMatchingModel`). Too little history is a result, not a
 * failure (no retry would change it).
 */
export const matchingTrain = defineJob({
  id: "matching-train",
  event: "matching/train.requested",
  retries: 0,
  concurrency: { limit: 1 },
  handler: async ({ data, step }) =>
    step.run("train", async () => {
      try {
        const trained = await trainMatchingModel(getDb(), {
          requestedByUserId: data.requestedByUserId,
        })
        return {
          trained: true as const,
          modelVersion: trained.modelVersion,
          trainingRows: trained.metrics.rows.training,
          holdoutRows: trained.metrics.rows.holdout,
        }
      } catch (error) {
        if (error instanceof InsufficientTrainingDataError) {
          return { trained: false as const, reason: error.message }
        }
        throw error
      }
    }),
})
