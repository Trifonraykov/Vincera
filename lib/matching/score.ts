import { z } from "zod"

import {
  MATCH_FEATURES,
  type MatchFeature,
  type MatchFeatures,
  type MatchWeights,
} from "@/lib/db/schema/types"

/**
 * The §8 score: Σ weight × feature, with the weights of the active `matching_config` row (v0:
 * semantic 0.35, topic_overlap 0.20, audience_fit 0.15, format_fit 0.10, stage_fit 0.10,
 * price_fit 0.05, reliability 0.05). Pure and client-safe.
 *
 * The weights are divided by their sum, so a config whose weights do not add up to exactly 1 still
 * yields a score in 0–1 (the database checks the range); for v0 the division changes nothing.
 * Scores are rounded to `numeric(7,6)`'s six decimals.
 */

/** v0's weights (§8), as migration 0003 inserted them. Tests and fallbacks only: read the table. */
export const V0_WEIGHTS: MatchWeights = {
  semantic: 0.35,
  topic_overlap: 0.2,
  audience_fit: 0.15,
  format_fit: 0.1,
  stage_fit: 0.1,
  price_fit: 0.05,
  reliability: 0.05,
}

const weight = z.number().finite().min(0)

/** `matching_config.weights`: every feature, each a non-negative number, not all zero. */
export const matchWeightsSchema = z
  .object({
    semantic: weight,
    topic_overlap: weight,
    audience_fit: weight,
    format_fit: weight,
    stage_fit: weight,
    price_fit: weight,
    reliability: weight,
  })
  .refine((weights) => MATCH_FEATURES.some((feature) => weights[feature] > 0), {
    message: "At least one weight must be positive",
  })

/** Round to the six decimals `matches.score` stores. */
export function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Σ weight × feature ÷ Σ weight, in 0–1. */
export function scoreFeatures(features: MatchFeatures, weights: MatchWeights): number {
  let total = 0
  let weightSum = 0
  for (const feature of MATCH_FEATURES) {
    const w = weights[feature]
    total += w * clampFeature(features[feature])
    weightSum += w
  }
  if (weightSum <= 0) return 0
  return roundScore(Math.min(1, Math.max(0, total / weightSum)))
}

function clampFeature(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** Each feature's share of the score (weight × value ÷ Σ weight), largest first. */
export function contributions(
  features: MatchFeatures,
  weights: MatchWeights,
): { feature: MatchFeature; value: number; contribution: number }[] {
  const weightSum = MATCH_FEATURES.reduce((sum, feature) => sum + weights[feature], 0)
  return MATCH_FEATURES.map((feature, index) => ({
    feature,
    index,
    value: clampFeature(features[feature]),
    contribution:
      weightSum > 0 ? (weights[feature] * clampFeature(features[feature])) / weightSum : 0,
  }))
    .sort((a, b) => b.contribution - a.contribution || a.index - b.index)
    .map(({ feature, value, contribution }) => ({ feature, value, contribution }))
}

/**
 * The two features that contribute most (weight × value), the ones the explanation names (§8).
 * Ties keep the §8 order, so the result is deterministic.
 */
export function topTwoFeatures(
  features: MatchFeatures,
  weights: MatchWeights,
): [{ feature: MatchFeature; value: number }, { feature: MatchFeature; value: number }] {
  const [first, second] = contributions(features, weights)
  if (!first || !second) throw new Error("topTwoFeatures: fewer than two features")
  return [
    { feature: first.feature, value: first.value },
    { feature: second.feature, value: second.value },
  ]
}

/** How a match reads at a glance; the badge on Discover shows the score as a percentage. */
export type ScoreBand = "great" | "good" | "fair"

export function scoreBand(score: number): ScoreBand {
  if (score >= 0.7) return "great"
  if (score >= 0.5) return "good"
  return "fair"
}

export const SCORE_BAND_LABELS: Record<ScoreBand, string> = {
  great: "Great fit",
  good: "Good fit",
  fair: "Possible fit",
}

/** 0.8234 → 82 */
export function scorePercent(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100)
}
