import "server-only"

import { like, sql } from "drizzle-orm"

import { writeAdminAudit } from "@/lib/admin/audit"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { matchingConfig } from "@/lib/db/schema"
import type { MatchingMetrics } from "@/lib/db/schema/types"
import { track } from "@/lib/events/track"

import { MatchingConfigError, V0_MODEL_VERSION } from "../config"
import { matchWeightsSchema } from "../score"
import { buildDataset, loadMatchOutcomes } from "./dataset"
import { trainV1, type V1Metrics } from "./train-core"

/**
 * Train matching v1 and store it **inactive** (CLAUDE.md §19.38 "Storage"): `pnpm matching:train`
 * and the `matching-train` job call this. Reads v0's shown rows and their outcomes, fits the
 * models, evaluates them against v0 on the hold-out, and inserts a `logistic` `matching_config`
 * row named `v1-<YYYY-MM-DD>` (UTC day of the training clock; `-2`, `-3` … when taken) in one
 * transaction with `matching.model_trained` and, when an admin started it, the audit row.
 * Throws `InsufficientTrainingDataError` (plain message) when there is too little history.
 */

export type TrainedModel = {
  modelVersion: string
  configId: string
  metrics: V1Metrics
}

/** `v1-2026-10-06`, or the next free `-n` suffix among `taken` (pure). */
export function nextV1Version(day: string, taken: readonly string[]): string {
  const base = `v1-${day}`
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
}

export async function trainMatchingModel(
  database: DbOrTx,
  options: { requestedByUserId: string | null; l2?: number; sourceVersion?: string } = {
    requestedByUserId: null,
  },
): Promise<TrainedModel> {
  const sourceVersion = options.sourceVersion ?? V0_MODEL_VERSION
  const trainedAt = now()
  const [v0] = await database
    .select({ weights: matchingConfig.weights })
    .from(matchingConfig)
    .where(sql`${matchingConfig.modelVersion} = ${V0_MODEL_VERSION}`)
  const v0Weights = matchWeightsSchema.safeParse(v0?.weights)
  if (!v0Weights.success) throw new MatchingConfigError("matching_config v0 is missing or invalid")

  const outcomes = await loadMatchOutcomes(database, sourceVersion)
  const dataset = buildDataset(outcomes, { sourceVersion, v0Weights: v0Weights.data })
  const result = trainV1(dataset, {
    trainedAt,
    l2: options.l2,
    fallbackWeights: v0Weights.data,
  })

  return withTransaction(async (tx) => {
    // One trainer at a time picks a version name.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('matching-train', 0))`)
    const day = trainedAt.toISOString().slice(0, 10)
    const taken = await tx
      .select({ modelVersion: matchingConfig.modelVersion })
      .from(matchingConfig)
      .where(like(matchingConfig.modelVersion, `v1-${day}%`))
    const modelVersion = nextV1Version(
      day,
      taken.map((row) => row.modelVersion),
    )
    const [row] = await tx
      .insert(matchingConfig)
      .values({
        modelVersion,
        kind: "logistic",
        weights: result.weights,
        model: result.model,
        metrics: result.metrics as unknown as MatchingMetrics,
        trainedAt,
        active: false,
        notes: `Trained on ${result.metrics.rows.training} ${sourceVersion} matches; evaluated on ${result.metrics.rows.holdout} held out.`,
      })
      .returning({ id: matchingConfig.id })
    if (!row) throw new Error("trainMatchingModel: no row returned")
    await track(
      "matching.model_trained",
      {
        actorUserId: options.requestedByUserId,
        subjectType: "matching_config",
        subjectId: row.id,
        properties: {
          model_version: modelVersion,
          training_rows: result.metrics.rows.training,
          holdout_rows: result.metrics.rows.holdout,
          positives_accepted: result.metrics.targets.accepted.training.positives,
          positives_sale: result.metrics.targets.sale.training.positives,
        },
      },
      tx,
    )
    if (options.requestedByUserId) {
      await writeAdminAudit(tx, {
        adminUserId: options.requestedByUserId,
        action: "matching.model_trained",
        targetType: "matching_config",
        targetId: row.id,
        before: null,
        after: {
          model_version: modelVersion,
          training_rows: result.metrics.rows.training,
          holdout_rows: result.metrics.rows.holdout,
          auc_accepted_v1: result.metrics.targets.accepted.v1?.auc ?? null,
          auc_accepted_v0: result.metrics.targets.accepted.v0.auc,
        },
      })
    }
    return { modelVersion, configId: row.id, metrics: result.metrics }
  }, database)
}
