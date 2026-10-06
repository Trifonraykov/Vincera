import { describe, expect, it } from "vitest"

import {
  contributions,
  matchWeightsSchema,
  roundScore,
  SCORE_BAND_LABELS,
  scoreBand,
  scoreFeatures,
  scorePercent,
  topTwoFeatures,
  V0_WEIGHTS,
} from "@/lib/matching/score"

import { matchFeatures } from "../../helpers/db-fixtures"

/** The §8 score and its weights (CLAUDE.md §19.27). */

describe("scoreFeatures", () => {
  it("is the §8 weighted sum with the v0 weights", () => {
    expect(Object.values(V0_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1)
    const features = {
      semantic: 0.8,
      topic_overlap: 0.5,
      audience_fit: 0.5,
      format_fit: 1,
      stage_fit: 0.9,
      price_fit: 0.75,
      reliability: 0.5,
    }
    const expected =
      0.35 * 0.8 + 0.2 * 0.5 + 0.15 * 0.5 + 0.1 * 1 + 0.1 * 0.9 + 0.05 * 0.75 + 0.05 * 0.5
    expect(scoreFeatures(features, V0_WEIGHTS)).toBe(roundScore(expected))
    expect(scoreFeatures(matchFeatures(1), V0_WEIGHTS)).toBe(1)
    expect(scoreFeatures(matchFeatures(0), V0_WEIGHTS)).toBe(0)
    expect(scoreFeatures(matchFeatures(0.5), V0_WEIGHTS)).toBe(0.5)
  })

  it("normalises weights that do not sum to 1 and clamps bad feature values", () => {
    const doubled = Object.fromEntries(
      Object.entries(V0_WEIGHTS).map(([feature, weight]) => [feature, weight * 2]),
    ) as typeof V0_WEIGHTS
    const features = { ...matchFeatures(0.4), semantic: 0.9 }
    expect(scoreFeatures(features, doubled)).toBe(scoreFeatures(features, V0_WEIGHTS))
    expect(scoreFeatures({ ...matchFeatures(1), semantic: 7 }, V0_WEIGHTS)).toBe(1)
    expect(scoreFeatures({ ...matchFeatures(0), semantic: Number.NaN }, V0_WEIGHTS)).toBe(0)
    expect(roundScore(0.12345678)).toBe(0.123457)
  })

  it("validates the config's weights", () => {
    expect(matchWeightsSchema.safeParse(V0_WEIGHTS).success).toBe(true)
    expect(matchWeightsSchema.safeParse({ ...V0_WEIGHTS, semantic: -1 }).success).toBe(false)
    const { semantic: _semantic, ...missing } = V0_WEIGHTS
    expect(matchWeightsSchema.safeParse(missing).success).toBe(false)
    const zeros = Object.fromEntries(Object.keys(V0_WEIGHTS).map((feature) => [feature, 0]))
    expect(matchWeightsSchema.safeParse(zeros).success).toBe(false)
  })
})

describe("top two features", () => {
  it("ranks features by weight × value, ties in §8 order", () => {
    const features = { ...matchFeatures(0.5), format_fit: 1 }
    // semantic 0.175, topic 0.1, format 0.1 (tie with topic: topic comes first in §8 order)
    expect(topTwoFeatures(features, V0_WEIGHTS).map((entry) => entry.feature)).toEqual([
      "semantic",
      "topic_overlap",
    ])
    const strongFormat = { ...matchFeatures(0.1), format_fit: 1, stage_fit: 0.9 }
    expect(topTwoFeatures(strongFormat, V0_WEIGHTS)).toEqual([
      { feature: "format_fit", value: 1 },
      { feature: "stage_fit", value: 0.9 },
    ])
    const all = contributions(features, V0_WEIGHTS)
    expect(all).toHaveLength(7)
    expect(all.reduce((sum, entry) => sum + entry.contribution, 0)).toBeCloseTo(
      scoreFeatures(features, V0_WEIGHTS),
    )
  })
})

describe("score display", () => {
  it("bands and rounds", () => {
    expect(scoreBand(0.82)).toBe("great")
    expect(scoreBand(0.7)).toBe("great")
    expect(scoreBand(0.55)).toBe("good")
    expect(scoreBand(0.2)).toBe("fair")
    expect(SCORE_BAND_LABELS.great).toBe("Great fit")
    expect(scorePercent(0.8249)).toBe(82)
    expect(scorePercent(1.3)).toBe(100)
    expect(scorePercent(-1)).toBe(0)
  })
})
