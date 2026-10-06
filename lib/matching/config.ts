import "server-only"

import { eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { matchingConfig } from "@/lib/db/schema"
import type { MatchWeights } from "@/lib/db/schema/types"

import { matchWeightsSchema } from "./score"

/** The model the platform ranks with (§8: weights live in `matching_config` with a version). */
export type ActiveMatchingConfig = { modelVersion: string; weights: MatchWeights }

export class MatchingConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MatchingConfigError"
  }
}

/**
 * The active `matching_config` row (at most one is active, a unique partial index guarantees it;
 * migration 0003 inserted v0). Its jsonb weights are Zod-checked: a broken config fails the job
 * loudly instead of storing nonsense scores.
 */
export async function loadActiveMatchingConfig(database: DbOrTx): Promise<ActiveMatchingConfig> {
  const [row] = await database
    .select({ modelVersion: matchingConfig.modelVersion, weights: matchingConfig.weights })
    .from(matchingConfig)
    .where(eq(matchingConfig.active, true))
    .limit(1)
  if (!row) throw new MatchingConfigError("No active matching_config row")
  const weights = matchWeightsSchema.safeParse(row.weights)
  if (!weights.success) {
    throw new MatchingConfigError(`matching_config ${row.modelVersion} has invalid weights`)
  }
  return { modelVersion: row.modelVersion, weights: weights.data }
}
