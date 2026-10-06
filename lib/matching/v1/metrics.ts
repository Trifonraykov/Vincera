/**
 * Held-out evaluation for matching v1 against v0 (§8 Phase 7; CLAUDE.md §19.38). Pure and
 * client-safe.
 *
 * - AUC: the Mann–Whitney statistic (the chance a random positive scores above a random negative;
 *   ties count ½), computed from average ranks. Null without both classes.
 * - Log loss: mean −[y·ln p + (1−y)·ln(1−p)] with p clipped to [1e-6, 1 − 1e-6]. v0's score is
 *   not a probability; it is evaluated as one and marked uncalibrated.
 * - Calibration by decile: predictions sorted ascending and cut into ten groups of (nearly) equal
 *   size by rank; each group's mean prediction against its observed rate.
 */

export type Scored = { score: number; label: boolean }

export const LOG_LOSS_EPSILON = 1e-6

export type CalibrationBin = {
  /** 1 (lowest predictions) … 10. */
  decile: number
  count: number
  positives: number
  meanPredicted: number
  observedRate: number
}

export type EvaluationMetrics = {
  rows: number
  positives: number
  auc: number | null
  logLoss: number | null
  calibration: CalibrationBin[]
}

export function auc(scored: readonly Scored[]): number | null {
  const positives = scored.filter((row) => row.label).length
  const negatives = scored.length - positives
  if (positives === 0 || negatives === 0) return null
  const sorted = [...scored].sort((a, b) => a.score - b.score)
  // Average ranks (1-based) over runs of equal scores.
  let rankSumPositives = 0
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j++
    const averageRank = (i + 1 + (j + 1)) / 2
    for (let k = i; k <= j; k++) if (sorted[k]!.label) rankSumPositives += averageRank
    i = j + 1
  }
  const u = rankSumPositives - (positives * (positives + 1)) / 2
  return u / (positives * negatives)
}

export function logLoss(scored: readonly Scored[]): number | null {
  if (scored.length === 0) return null
  let total = 0
  for (const row of scored) {
    const p = Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, row.score))
    total += row.label ? -Math.log(p) : -Math.log(1 - p)
  }
  return total / scored.length
}

export function calibrationByDecile(scored: readonly Scored[]): CalibrationBin[] {
  if (scored.length === 0) return []
  const sorted = [...scored].sort((a, b) => a.score - b.score)
  const bins: CalibrationBin[] = []
  for (let decile = 0; decile < 10; decile++) {
    const start = Math.floor((decile * sorted.length) / 10)
    const end = Math.floor(((decile + 1) * sorted.length) / 10)
    const group = sorted.slice(start, end)
    if (group.length === 0) continue
    const positives = group.filter((row) => row.label).length
    bins.push({
      decile: decile + 1,
      count: group.length,
      positives,
      meanPredicted: round(group.reduce((sum, row) => sum + row.score, 0) / group.length),
      observedRate: round(positives / group.length),
    })
  }
  return bins
}

export function evaluate(scored: readonly Scored[]): EvaluationMetrics {
  const value = auc(scored)
  const loss = logLoss(scored)
  return {
    rows: scored.length,
    positives: scored.filter((row) => row.label).length,
    auc: value === null ? null : round(value),
    logLoss: loss === null ? null : round(loss),
    calibration: calibrationByDecile(scored),
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
