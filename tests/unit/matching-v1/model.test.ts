import { describe, expect, it } from "vitest"

import { MATCH_FEATURES, type MatchFeatures } from "@/lib/db/schema/types"
import { scoreFeatures, scoreMatch, V0_WEIGHTS } from "@/lib/matching/score"
import {
  explanationWeights,
  fitLogistic,
  predict,
  sigmoid,
  solveLinear,
  standardisation,
  type TrainingExample,
} from "@/lib/matching/v1/logistic"
import { auc, calibrationByDecile, evaluate, logLoss } from "@/lib/matching/v1/metrics"
import { matchingModelSchema, scoreWithModel } from "@/lib/matching/v1/model"
import { HOLDOUT_BYTE_THRESHOLD, isHoldout } from "@/lib/matching/v1/split"
import {
  InsufficientTrainingDataError,
  MIN_SALE_POSITIVES,
  trainV1,
  v1BeatsV0,
  type Dataset,
} from "@/lib/matching/v1/train-core"
import { nextV1Version } from "@/lib/matching/v1/train"
import { buildDataset, preOutcomeFeatures, type MatchOutcomeRow } from "@/lib/matching/v1/dataset"
import { prng } from "@/lib/seed/matching-history"

/** Matching v1's model and metrics on synthetic data with known weights (§8; CLAUDE.md §19.42). */

function features(random: () => number): MatchFeatures {
  const row = {} as MatchFeatures
  for (const feature of MATCH_FEATURES) row[feature] = Math.round(random() * 1000) / 1000
  return row
}

/** True model: semantic +3, topic_overlap +1.5, price_fit −2, the rest 0. */
function trueLogit(row: MatchFeatures): number {
  return -1 + 3 * row.semantic + 1.5 * row.topic_overlap - 2 * row.price_fit
}

function synthetic(n: number, seed = 7): TrainingExample[] {
  const random = prng(seed)
  return Array.from({ length: n }, () => {
    const row = features(random)
    return { features: row, label: random() < sigmoid(trueLogit(row)) }
  })
}

const uuid = (i: number) => `00000000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`

describe("logistic regression", () => {
  it("recovers the signs and order of known weights", () => {
    const fit = fitLogistic(synthetic(4000), { l2: 1 })
    expect(fit.converged).toBe(true)
    // Coefficients are per std; std of U(0,1) is the same for every feature, so order is kept.
    expect(fit.coefficients.semantic).toBeGreaterThan(fit.coefficients.topic_overlap)
    expect(fit.coefficients.topic_overlap).toBeGreaterThan(0.2)
    expect(fit.coefficients.price_fit).toBeLessThan(-0.3)
    for (const feature of ["audience_fit", "format_fit", "stage_fit", "reliability"] as const) {
      expect(Math.abs(fit.coefficients[feature])).toBeLessThan(0.15)
    }
    // Raw-unit coefficient for semantic is close to 3.
    expect(fit.coefficients.semantic / fit.stds.semantic).toBeGreaterThan(2.4)
    expect(fit.coefficients.semantic / fit.stds.semantic).toBeLessThan(3.6)
  })

  it("is deterministic", () => {
    const data = synthetic(500)
    expect(fitLogistic(data)).toEqual(fitLogistic(data))
  })

  it("ignores a constant feature and shrinks with a larger λ", () => {
    const data = synthetic(400).map((example) => ({
      ...example,
      features: { ...example.features, reliability: 0.5 },
    }))
    const fit = fitLogistic(data, { l2: 1 })
    expect(fit.stds.reliability).toBe(0)
    expect(fit.coefficients.reliability).toBe(0)
    const strong = fitLogistic(data, { l2: 1000 })
    expect(Math.abs(strong.coefficients.semantic)).toBeLessThan(Math.abs(fit.coefficients.semantic))
    expect(predict(fit, data[0]!.features)).toBeGreaterThan(0)
  })

  it("solves linear systems and standardises", () => {
    expect(
      solveLinear(
        [
          [2, 1],
          [1, 3],
        ],
        [3, 5],
      ),
    ).toEqual([0.8, 1.4].map((v) => expect.closeTo(v, 10)))
    const { means, stds } = standardisation([
      { features: { ...synthetic(1)[0]!.features, semantic: 0 }, label: true },
      { features: { ...synthetic(1)[0]!.features, semantic: 1 }, label: false },
    ])
    expect(means.semantic).toBe(0.5)
    expect(stds.semantic).toBe(0.5)
  })

  it("derives non-negative explanation weights that sum to 1", () => {
    const fit = fitLogistic(synthetic(2000))
    const weights = explanationWeights(fit)
    expect(weights).not.toBeNull()
    expect(weights!.price_fit).toBe(0)
    expect(weights!.semantic).toBeGreaterThan(weights!.topic_overlap)
    const total = MATCH_FEATURES.reduce((sum, feature) => sum + weights![feature], 0)
    expect(total).toBeCloseTo(1, 5)
  })
})

describe("metrics", () => {
  it("computes AUC with ties counting ½", () => {
    expect(
      auc([
        { score: 0.9, label: true },
        { score: 0.1, label: false },
      ]),
    ).toBe(1)
    expect(
      auc([
        { score: 0.1, label: true },
        { score: 0.9, label: false },
      ]),
    ).toBe(0)
    expect(
      auc([
        { score: 0.5, label: true },
        { score: 0.5, label: false },
      ]),
    ).toBe(0.5)
    expect(
      auc([
        { score: 0.8, label: true },
        { score: 0.5, label: true },
        { score: 0.5, label: false },
        { score: 0.2, label: false },
      ]),
    ).toBe(0.875)
    expect(auc([{ score: 0.5, label: true }])).toBeNull()
  })

  it("clips log loss", () => {
    expect(logLoss([{ score: 1, label: false }])).toBeCloseTo(-Math.log(1e-6), 6)
    expect(logLoss([{ score: 0.5, label: true }])).toBeCloseTo(Math.log(2), 10)
    expect(logLoss([])).toBeNull()
  })

  it("cuts calibration into ten rank deciles", () => {
    const scored = Array.from({ length: 25 }, (_, i) => ({ score: i / 25, label: i >= 20 }))
    const bins = calibrationByDecile(scored)
    expect(bins).toHaveLength(10)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(25)
    expect(bins[9]!.observedRate).toBe(1)
    expect(bins[0]!.observedRate).toBe(0)
    expect(evaluate(scored).auc).toBe(1)
  })
})

describe("split, model parsing and training", () => {
  it("holds out about 20 % of rows, always the same ones", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => uuid(i))
    const held = ids.filter(isHoldout)
    expect(held.length / ids.length).toBeGreaterThan(0.17)
    expect(held.length / ids.length).toBeLessThan(0.24)
    expect(ids.filter(isHoldout)).toEqual(held)
    expect(HOLDOUT_BYTE_THRESHOLD).toBe(52)
  })

  function dataset(n: number, options: { saleRate?: number } = {}): Dataset {
    const random = prng(11)
    return {
      sourceVersion: "v0",
      excludedPositives: 3,
      rows: Array.from({ length: n }, (_, i) => {
        const row = features(random)
        const accepted = random() < sigmoid(trueLogit(row))
        return {
          matchId: uuid(i),
          features: row,
          v0Score: scoreFeatures(row, V0_WEIGHTS),
          accepted,
          sale: accepted && random() < (options.saleRate ?? 0.5),
        }
      }),
    }
  }

  it("beats v0 on the hold-out when the signal differs from v0's weights", () => {
    const result = trainV1(dataset(3000), {
      trainedAt: new Date("2026-10-06T00:00:00Z"),
      fallbackWeights: V0_WEIGHTS,
    })
    expect(v1BeatsV0(result.metrics, "accepted")).toBe(true)
    expect(result.metrics.targets.accepted.v1!.auc!).toBeGreaterThan(0.7)
    expect(result.metrics.rows.excludedPositives).toBe(3)
    expect(result.metrics.rows.training + result.metrics.rows.holdout).toBe(3000)
    expect(result.model.targets.sale).not.toBeNull()
    expect(matchingModelSchema.parse(result.model)).toEqual(result.model)
    const score = scoreWithModel(result.model, dataset(1).rows[0]!.features)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
    expect(
      scoreMatch(dataset(1).rows[0]!.features, { weights: V0_WEIGHTS, model: result.model }),
    ).toBe(score)
  })

  it("refuses with too little history and skips sale without enough sales", () => {
    expect(() =>
      trainV1(dataset(30), { trainedAt: new Date(), fallbackWeights: V0_WEIGHTS }),
    ).toThrow(InsufficientTrainingDataError)
    const result = trainV1(dataset(600, { saleRate: 0.01 }), {
      trainedAt: new Date(),
      fallbackWeights: V0_WEIGHTS,
    })
    expect(result.model.targets.sale).toBeNull()
    expect(result.metrics.targets.sale.fitted).toBe(false)
    expect(result.metrics.targets.sale.reason).toContain(String(MIN_SALE_POSITIVES))
  })

  it("names versions by day with a suffix when taken", () => {
    expect(nextV1Version("2026-10-06", [])).toBe("v1-2026-10-06")
    expect(nextV1Version("2026-10-06", ["v1-2026-10-06"])).toBe("v1-2026-10-06-2")
    expect(nextV1Version("2026-10-06", ["v1-2026-10-06", "v1-2026-10-06-2"])).toBe(
      "v1-2026-10-06-3",
    )
  })
})

describe("pre-outcome features", () => {
  const stored = { ...Object.fromEntries(MATCH_FEATURES.map((f) => [f, 0.9])) } as MatchFeatures
  const snapshot = { ...Object.fromEntries(MATCH_FEATURES.map((f) => [f, 0.1])) } as MatchFeatures
  const base: MatchOutcomeRow = {
    matchId: uuid(1),
    storedFeatures: stored,
    computedAt: new Date("2026-05-02T00:00:00Z"),
    sent: true,
    accepted: true,
    live: false,
    sale: false,
    firstProposalAt: new Date("2026-05-01T00:00:00Z"),
    snapshotFeatures: null,
  }

  it("prefers the snapshot, then a vector computed before the send, else excludes positives", () => {
    expect(preOutcomeFeatures({ ...base, snapshotFeatures: snapshot })).toBe(snapshot)
    expect(preOutcomeFeatures({ ...base, computedAt: new Date("2026-04-30T00:00:00Z") })).toBe(
      stored,
    )
    expect(preOutcomeFeatures(base)).toBeNull()
    expect(preOutcomeFeatures({ ...base, accepted: false })).toBe(stored)
    expect(preOutcomeFeatures({ ...base, firstProposalAt: null, sent: false })).toBe(stored)
    const built = buildDataset(
      [base, { ...base, matchId: uuid(2), snapshotFeatures: snapshot, sale: true }],
      {
        sourceVersion: "v0",
        v0Weights: V0_WEIGHTS,
      },
    )
    expect(built.excludedPositives).toBe(1)
    expect(built.rows).toHaveLength(1)
    expect(built.rows[0]!.v0Score).toBe(scoreFeatures(snapshot, V0_WEIGHTS))
    expect(built.rows[0]!.sale).toBe(true)
  })
})
