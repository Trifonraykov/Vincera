import "server-only"

import { sql } from "drizzle-orm"
import { z } from "zod"

import type { DbOrTx } from "@/lib/db/client"
import { MATCH_FEATURES, type MatchFeatures, type MatchWeights } from "@/lib/db/schema/types"

import { scoreFeatures } from "../score"
import { matchOutcomesCte } from "./outcomes"
import type { Dataset, DatasetRow } from "./train-core"

/**
 * The v1 training data (§8 "the stored vector is the training data"; CLAUDE.md §19.38): every
 * shown match row of a model version with its labels and **pre-outcome** features:
 *
 * - the earliest linked proposal's `match_snapshot.features` when it has one;
 * - else the row's stored vector when it was computed at or before that proposal was sent;
 * - else, for a positive, nothing: the row is left out (`excludedPositives`), because a vector
 *   recomputed after the proposal may already reflect its outcome (a collab raises reliability);
 * - rows without a linked proposal, and negatives, use the stored vector.
 *
 * The v0 baseline is v0's weighted score of the same features, so both models are compared on
 * exactly the same inputs.
 */

const featuresSchema = z.object(
  Object.fromEntries(
    MATCH_FEATURES.map((feature) => [feature, z.number().min(0).max(1)]),
  ) as Record<(typeof MATCH_FEATURES)[number], z.ZodNumber>,
)

const snapshotSchema = z.object({ features: featuresSchema })

const outcomeRowSchema = z.object({
  id: z.string(),
  features: z.unknown(),
  computed_at: z.coerce.date(),
  sent: z.boolean(),
  accepted: z.boolean(),
  live: z.boolean(),
  sale: z.boolean(),
  first_created_at: z.coerce.date().nullable(),
  first_snapshot: z.unknown().nullable(),
})

export type MatchOutcomeRow = {
  matchId: string
  storedFeatures: MatchFeatures
  computedAt: Date
  sent: boolean
  accepted: boolean
  live: boolean
  sale: boolean
  firstProposalAt: Date | null
  snapshotFeatures: MatchFeatures | null
}

/** Every shown row of `modelVersion` with its outcomes, in match id order. */
export async function loadMatchOutcomes(
  database: DbOrTx,
  modelVersion: string,
): Promise<MatchOutcomeRow[]> {
  const result = await database.execute(sql`
    WITH ${matchOutcomesCte(modelVersion)}
    SELECT id, features, computed_at, sent, accepted, live, sale, first_created_at, first_snapshot
    FROM outcomes
    ORDER BY id
  `)
  return result.rows.map((raw) => {
    const row = outcomeRowSchema.parse(raw)
    const snapshot = snapshotSchema.safeParse(row.first_snapshot)
    return {
      matchId: row.id,
      storedFeatures: featuresSchema.parse(row.features),
      computedAt: row.computed_at,
      sent: row.sent,
      accepted: row.accepted,
      live: row.live,
      sale: row.sale,
      firstProposalAt: row.first_created_at,
      snapshotFeatures: snapshot.success ? snapshot.data.features : null,
    }
  })
}

/** Pre-outcome features of a row, or null when a positive has none (pure). */
export function preOutcomeFeatures(row: MatchOutcomeRow): MatchFeatures | null {
  if (!row.firstProposalAt) return row.storedFeatures
  if (row.snapshotFeatures) return row.snapshotFeatures
  if (row.computedAt.getTime() <= row.firstProposalAt.getTime()) return row.storedFeatures
  return row.accepted ? null : row.storedFeatures
}

/** Turn outcome rows into the training dataset (pure). */
export function buildDataset(
  rows: readonly MatchOutcomeRow[],
  options: { sourceVersion: string; v0Weights: MatchWeights },
): Dataset {
  const dataset: DatasetRow[] = []
  let excludedPositives = 0
  for (const row of rows) {
    const features = preOutcomeFeatures(row)
    if (!features) {
      excludedPositives++
      continue
    }
    dataset.push({
      matchId: row.matchId,
      features,
      v0Score: scoreFeatures(features, options.v0Weights),
      accepted: row.accepted,
      sale: row.accepted && row.sale,
    })
  }
  return { sourceVersion: options.sourceVersion, rows: dataset, excludedPositives }
}
