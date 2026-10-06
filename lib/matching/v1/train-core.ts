import type {
  LogisticModelParams,
  MatchFeatures,
  MatchingModel,
  MatchingTarget,
  MatchWeights,
} from "@/lib/db/schema/types"

import { DEFAULT_L2, explanationWeights, fitLogistic, predict } from "./logistic"
import { evaluate, type EvaluationMetrics } from "./metrics"
import { HOLDOUT_BYTE_THRESHOLD, isHoldout } from "./split"

/**
 * Training and evaluation of matching v1, without the database (CLAUDE.md §19.38). Pure: the
 * dataset comes in (lib/matching/v1/dataset.ts builds it), the model, its explanation weights and
 * the held-out comparison against v0 come out.
 */

/** "accepted" needs this many positives and negatives in the training split. */
export const MIN_ACCEPTED_POSITIVES = 20
export const MIN_ACCEPTED_NEGATIVES = 20
/** "sale" needs this many positives in the training split, else its model is null. */
export const MIN_SALE_POSITIVES = 10
/** Ranking uses P(accepted) (decided by delegation; open question whether to rank by sale). */
export const SCORE_TARGET: MatchingTarget = "accepted"

export type DatasetRow = {
  matchId: string
  /** Pre-outcome features (the proposal's snapshot, or the row's stored vector). */
  features: MatchFeatures
  /** v0's stored score of the row (the baseline it is compared with). */
  v0Score: number
  accepted: boolean
  sale: boolean
}

export type Dataset = {
  sourceVersion: string
  rows: DatasetRow[]
  /** Positives left out: no pre-outcome feature vector (no snapshot, row recomputed since). */
  excludedPositives: number
}

export type TargetMetrics = {
  fitted: boolean
  /** Why the model was not fitted (too few positives), else null. */
  reason: string | null
  training: { rows: number; positives: number }
  holdout: { rows: number; positives: number }
  v1: EvaluationMetrics | null
  v0: EvaluationMetrics
  iterations: number | null
  converged: boolean | null
}

export type V1Metrics = {
  v: 1
  sourceVersion: string
  trainedAt: string
  l2: number
  scoreTarget: MatchingTarget
  holdoutRule: string
  rows: { eligible: number; training: number; holdout: number; excludedPositives: number }
  /** v0's score is not a probability; its log loss and calibration read it as one. */
  v0Uncalibrated: true
  targets: Record<MatchingTarget, TargetMetrics>
}

export type TrainingResult = {
  model: MatchingModel
  weights: MatchWeights
  metrics: V1Metrics
}

export class InsufficientTrainingDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InsufficientTrainingDataError"
  }
}

function labelOf(row: DatasetRow, target: MatchingTarget): boolean {
  return target === "accepted" ? row.accepted : row.sale
}

function stripFit(
  fit: LogisticModelParams & { iterations: number; converged: boolean },
): LogisticModelParams {
  return {
    intercept: fit.intercept,
    coefficients: fit.coefficients,
    means: fit.means,
    stds: fit.stds,
  }
}

export function trainV1(
  dataset: Dataset,
  options: { trainedAt: Date; l2?: number; fallbackWeights: MatchWeights },
): TrainingResult {
  const l2 = options.l2 ?? DEFAULT_L2
  const training = dataset.rows.filter((row) => !isHoldout(row.matchId))
  const holdout = dataset.rows.filter((row) => isHoldout(row.matchId))

  const acceptedPositives = training.filter((row) => row.accepted).length
  const acceptedNegatives = training.length - acceptedPositives
  if (acceptedPositives < MIN_ACCEPTED_POSITIVES || acceptedNegatives < MIN_ACCEPTED_NEGATIVES) {
    throw new InsufficientTrainingDataError(
      `Not enough history to train yet: the training data has ${acceptedPositives} accepted and ${acceptedNegatives} not accepted matches; at least ${MIN_ACCEPTED_POSITIVES} of each are needed.`,
    )
  }

  const targets = {} as Record<MatchingTarget, LogisticModelParams | null>
  const metrics = {} as Record<MatchingTarget, TargetMetrics>
  for (const target of ["accepted", "sale"] as const) {
    const positives = training.filter((row) => labelOf(row, target)).length
    const holdoutPositives = holdout.filter((row) => labelOf(row, target)).length
    const v0 = evaluate(holdout.map((row) => ({ score: row.v0Score, label: labelOf(row, target) })))
    const base = {
      training: { rows: training.length, positives },
      holdout: { rows: holdout.length, positives: holdoutPositives },
      v0,
    }
    if (target === "sale" && positives < MIN_SALE_POSITIVES) {
      targets[target] = null
      metrics[target] = {
        ...base,
        fitted: false,
        reason: `Only ${positives} matches led to a sale in the training data; at least ${MIN_SALE_POSITIVES} are needed.`,
        v1: null,
        iterations: null,
        converged: null,
      }
      continue
    }
    const fit = fitLogistic(
      training.map((row) => ({ features: row.features, label: labelOf(row, target) })),
      { l2 },
    )
    const params = stripFit(fit)
    targets[target] = params
    metrics[target] = {
      ...base,
      fitted: true,
      reason: null,
      v1: evaluate(
        holdout.map((row) => ({
          score: predict(params, row.features),
          label: labelOf(row, target),
        })),
      ),
      iterations: fit.iterations,
      converged: fit.converged,
    }
  }

  const ranking = targets[SCORE_TARGET]
  if (!ranking) throw new Error("trainV1: the ranking target was not fitted")
  return {
    model: { kind: "logistic", v: 1, scoreTarget: SCORE_TARGET, l2, targets },
    weights: explanationWeights(ranking) ?? options.fallbackWeights,
    metrics: {
      v: 1,
      sourceVersion: dataset.sourceVersion,
      trainedAt: options.trainedAt.toISOString(),
      l2,
      scoreTarget: SCORE_TARGET,
      holdoutRule: `first byte of sha256(match id) < ${HOLDOUT_BYTE_THRESHOLD}`,
      rows: {
        eligible: dataset.rows.length,
        training: training.length,
        holdout: holdout.length,
        excludedPositives: dataset.excludedPositives,
      },
      v0Uncalibrated: true,
      targets: metrics,
    },
  }
}

/** Whether v1 beats v0 on the held-out AUC of a target (null when either is unknown). */
export function v1BeatsV0(metrics: V1Metrics, target: MatchingTarget): boolean | null {
  const entry = metrics.targets[target]
  if (!entry.v1 || entry.v1.auc === null || entry.v0.auc === null) return null
  return entry.v1.auc > entry.v0.auc
}
