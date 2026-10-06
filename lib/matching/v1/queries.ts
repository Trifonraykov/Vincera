import "server-only"

import { desc } from "drizzle-orm"
import { z } from "zod"

import type { DbOrTx } from "@/lib/db/client"
import { matchingConfig } from "@/lib/db/schema"
import { MATCHING_TARGETS, type MatchWeights } from "@/lib/db/schema/types"

import { matchWeightsSchema } from "../score"
import { matchingModelSchema } from "./model"
import type { V1Metrics } from "./train-core"

/** What `/admin/matching` reads (CLAUDE.md §19.38). */

const evaluationSchema = z.object({
  rows: z.number(),
  positives: z.number(),
  auc: z.number().nullable(),
  logLoss: z.number().nullable(),
  calibration: z.array(
    z.object({
      decile: z.number(),
      count: z.number(),
      positives: z.number(),
      meanPredicted: z.number(),
      observedRate: z.number(),
    }),
  ),
})

const targetMetricsSchema = z.object({
  fitted: z.boolean(),
  reason: z.string().nullable(),
  training: z.object({ rows: z.number(), positives: z.number() }),
  holdout: z.object({ rows: z.number(), positives: z.number() }),
  v1: evaluationSchema.nullable(),
  v0: evaluationSchema,
  iterations: z.number().nullable(),
  converged: z.boolean().nullable(),
})

export const v1MetricsSchema = z.object({
  v: z.literal(1),
  sourceVersion: z.string(),
  trainedAt: z.string(),
  l2: z.number(),
  scoreTarget: z.enum(MATCHING_TARGETS),
  holdoutRule: z.string(),
  rows: z.object({
    eligible: z.number(),
    training: z.number(),
    holdout: z.number(),
    excludedPositives: z.number(),
  }),
  v0Uncalibrated: z.literal(true),
  targets: z.object({ accepted: targetMetricsSchema, sale: targetMetricsSchema }),
}) satisfies z.ZodType<V1Metrics>

export type ModelVersionView = {
  id: string
  modelVersion: string
  kind: "weighted" | "logistic"
  active: boolean
  weights: MatchWeights | null
  metrics: V1Metrics | null
  /** The coefficients of the ranking model, per feature (logistic only). */
  coefficients: Record<string, number> | null
  trainedAt: Date | null
  activatedAt: Date | null
  createdAt: Date
}

/** Every model version, newest first (v0 last). Unparseable metrics show as missing. */
export async function listModelVersions(database: DbOrTx): Promise<ModelVersionView[]> {
  const rows = await database
    .select()
    .from(matchingConfig)
    .orderBy(desc(matchingConfig.createdAt), desc(matchingConfig.modelVersion))
  return rows.map((row) => {
    const weights = matchWeightsSchema.safeParse(row.weights)
    const metrics = v1MetricsSchema.safeParse(row.metrics)
    const model = matchingModelSchema.safeParse(row.model)
    const ranking = model.success ? model.data.targets[model.data.scoreTarget] : null
    return {
      id: row.id,
      modelVersion: row.modelVersion,
      kind: row.kind,
      active: row.active,
      weights: weights.success ? weights.data : null,
      metrics: metrics.success ? metrics.data : null,
      coefficients: ranking ? ranking.coefficients : null,
      trainedAt: row.trainedAt,
      activatedAt: row.activatedAt,
      createdAt: row.createdAt,
    }
  })
}
