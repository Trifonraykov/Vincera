import {
  MATCH_FEATURES,
  type LogisticModelParams,
  type MatchFeature,
  type MatchFeatures,
} from "@/lib/db/schema/types"

/**
 * Matching v1's model (§8 Phase 7; CLAUDE.md §19.38): L2-regularised logistic regression over the
 * seven §8 features, in pure TypeScript and fully deterministic.
 *
 * - Features are standardised with the training means and (population) standard deviations; a
 *   feature whose std is ~0 carries no information and is ignored (std stored as 0, coefficient 0).
 * - Fitting minimises −log-likelihood + λ/2 · Σ coefficient² (the intercept is not penalised)
 *   with Newton's method (IRLS), starting from zeros, at most `MAX_ITERATIONS` steps, stopping
 *   when the largest step is below `TOLERANCE`. Same input, same model, bit for bit.
 *
 * Pure and client-safe (the admin page shows coefficients).
 */

export const DEFAULT_L2 = 1
const MAX_ITERATIONS = 100
const TOLERANCE = 1e-10
/** Below this a feature's std counts as zero. */
const MIN_STD = 1e-9

export type TrainingExample = { features: MatchFeatures; label: boolean }

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

function emptyRecord(value: number): Record<MatchFeature, number> {
  return Object.fromEntries(MATCH_FEATURES.map((feature) => [feature, value])) as Record<
    MatchFeature,
    number
  >
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** Means and population stds of the training features. */
export function standardisation(examples: readonly TrainingExample[]): {
  means: Record<MatchFeature, number>
  stds: Record<MatchFeature, number>
} {
  const means = emptyRecord(0)
  const stds = emptyRecord(0)
  const n = examples.length
  if (n === 0) return { means, stds }
  for (const feature of MATCH_FEATURES) {
    let sum = 0
    for (const example of examples) sum += finite(example.features[feature])
    const mean = sum / n
    let squares = 0
    for (const example of examples) squares += (finite(example.features[feature]) - mean) ** 2
    const std = Math.sqrt(squares / n)
    means[feature] = mean
    stds[feature] = std < MIN_STD ? 0 : std
  }
  return { means, stds }
}

/** The standardised feature row (ignored features are 0). */
function standardised(
  features: MatchFeatures,
  means: Record<MatchFeature, number>,
  stds: Record<MatchFeature, number>,
): number[] {
  return MATCH_FEATURES.map((feature) =>
    stds[feature] > 0 ? (finite(features[feature]) - means[feature]) / stds[feature] : 0,
  )
}

/** The linear predictor (log-odds) of a fitted model. */
export function logit(model: LogisticModelParams, features: MatchFeatures): number {
  const x = standardised(features, model.means, model.stds)
  let z = model.intercept
  MATCH_FEATURES.forEach((feature, index) => {
    z += (model.coefficients[feature] ?? 0) * (x[index] ?? 0)
  })
  return z
}

/** P(label) under a fitted model. */
export function predict(model: LogisticModelParams, features: MatchFeatures): number {
  return sigmoid(logit(model, features))
}

/** Solve A·x = b (A symmetric positive definite, small) by Gaussian elimination with pivoting. */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i] ?? 0])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row
    }
    if (Math.abs(m[pivot]![col]!) < 1e-14) throw new Error("solveLinear: singular matrix")
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot]!, m[col]!]
    const pivotRow = m[col]!
    for (let row = col + 1; row < n; row++) {
      const target = m[row]!
      const factor = target[col]! / pivotRow[col]!
      if (factor === 0) continue
      for (let k = col; k <= n; k++) target[k] = target[k]! - factor * pivotRow[k]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    const current = m[row]!
    let sum = current[n]!
    for (let k = row + 1; k < n; k++) sum -= current[k]! * x[k]!
    x[row] = sum / current[row]!
  }
  return x
}

/**
 * Fit P(label | features). Throws when there are no examples. With only one class the model is
 * still fitted (the penalty keeps it finite); callers enforce minimum counts.
 */
export function fitLogistic(
  examples: readonly TrainingExample[],
  options: { l2?: number } = {},
): LogisticModelParams & { iterations: number; converged: boolean } {
  if (examples.length === 0) throw new Error("fitLogistic: no examples")
  const l2 = options.l2 ?? DEFAULT_L2
  const { means, stds } = standardisation(examples)
  const rows = examples.map((example) => [1, ...standardised(example.features, means, stds)])
  const labels = examples.map((example) => (example.label ? 1 : 0))
  const size = MATCH_FEATURES.length + 1
  // Ignored features stay at 0: give them a unit diagonal and a zero gradient.
  const active = [true, ...MATCH_FEATURES.map((feature) => stds[feature] > 0)]
  let beta = new Array<number>(size).fill(0)
  let iterations = 0
  let converged = false

  for (; iterations < MAX_ITERATIONS && !converged; iterations++) {
    const gradient = new Array<number>(size).fill(0)
    const hessian = Array.from({ length: size }, () => new Array<number>(size).fill(0))
    rows.forEach((x, i) => {
      let z = 0
      for (let k = 0; k < size; k++) z += beta[k]! * x[k]!
      const p = sigmoid(z)
      const w = Math.max(p * (1 - p), 1e-12)
      const residual = labels[i]! - p
      for (let j = 0; j < size; j++) {
        gradient[j] = gradient[j]! + residual * x[j]!
        const hj = hessian[j]!
        for (let k = 0; k < size; k++) hj[k] = hj[k]! + w * x[j]! * x[k]!
      }
    })
    for (let j = 0; j < size; j++) {
      const hj = hessian[j]!
      if (!active[j]) {
        for (let k = 0; k < size; k++) {
          hj[k] = j === k ? 1 : 0
          hessian[k]![j] = j === k ? 1 : 0
        }
        gradient[j] = 0
        continue
      }
      if (j > 0) {
        hj[j] = hj[j]! + l2
        gradient[j] = gradient[j]! - l2 * beta[j]!
      }
    }
    const step = solveLinear(hessian, gradient)
    beta = beta.map((value, k) => value + step[k]!)
    converged = Math.max(...step.map((value) => Math.abs(value))) < TOLERANCE
  }

  const coefficients = emptyRecord(0)
  MATCH_FEATURES.forEach((feature, index) => {
    coefficients[feature] = active[index + 1] ? (beta[index + 1] ?? 0) : 0
  })
  return { intercept: beta[0] ?? 0, coefficients, means, stds, iterations, converged }
}

/**
 * The non-negative weights a logistic model implies for explanations (§8 "top two contributing
 * features"): max(0, coefficient ÷ std) per feature (the effect of one raw unit), normalised to
 * sum to 1. Null when no coefficient is positive (the caller falls back to v0's weights).
 */
export function explanationWeights(
  model: LogisticModelParams,
): Record<MatchFeature, number> | null {
  const raw = emptyRecord(0)
  let total = 0
  for (const feature of MATCH_FEATURES) {
    const std = model.stds[feature]
    const value = std > 0 ? Math.max(0, model.coefficients[feature] / std) : 0
    raw[feature] = Number.isFinite(value) ? value : 0
    total += raw[feature]
  }
  if (total <= 0) return null
  for (const feature of MATCH_FEATURES) raw[feature] = round(raw[feature] / total)
  return raw
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
