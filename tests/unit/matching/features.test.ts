import { describe, expect, it } from "vitest"

import {
  audienceFitFeature,
  clamp01,
  cosineSimilarity,
  formatFitFeature,
  geoOverlap,
  jaccard,
  languageOverlap,
  NEUTRAL,
  pairEvidence,
  pairFeatures,
  priceFit,
  priceFitFeature,
  reliabilityFeature,
  roleForTargetType,
  semanticFeature,
  STAGE_FIT_TABLE,
  stageFitFeature,
  topicOverlapFeature,
  topicSet,
  type BuilderFacts,
  type CreatorFacts,
} from "@/lib/matching/features"

/** Matching v0 features (§8; CLAUDE.md §19.27): every definition and edge case. */

const creator: CreatorFacts = {
  userId: "c",
  topics: ["Meal Prep", "#budget cooking"],
  languages: ["en", "es"],
  audienceCountries: [
    { country: "GB", share: 0.6 },
    { country: "US", share: 0.4 },
  ],
  sizeTier: "micro",
  ideas: [{ format: "app", price: { cents: 900, currency: "eur" }, topics: ["grocery lists"] }],
}

const builder: BuilderFacts = {
  userId: "b",
  skills: ["React", "meal prep"],
  stack: ["typescript"],
  shippedFormats: ["app"],
  products: [
    {
      format: "app",
      stage: "beta",
      price: { cents: 1200, currency: "eur" },
      topics: ["meal prep"],
    },
  ],
  languages: [],
  country: null,
}

describe("semantic", () => {
  it("is the cosine similarity of the two vectors, clamped to 0–1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
    expect(semanticFeature(cosineSimilarity([1, 0], [-1, 0]))).toBe(0)
    expect(semanticFeature(0.42)).toBe(0.42)
    expect(semanticFeature(1.0000001)).toBe(1)
  })

  it("is neutral without both embeddings", () => {
    expect(cosineSimilarity([], [])).toBeNull()
    expect(cosineSimilarity([1, 2], [1])).toBeNull()
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull()
    expect(semanticFeature(null)).toBe(NEUTRAL)
    expect(semanticFeature(Number.NaN)).toBe(NEUTRAL)
  })
})

describe("topic_overlap", () => {
  it("is the Jaccard index of normalised topic sets", () => {
    const a = topicSet(["Meal Prep", "#budget cooking"])
    expect([...a]).toEqual(["meal prep", "budget cooking"])
    expect(jaccard(a, topicSet(["meal prep"]))).toBe(0.5)
    expect(jaccard(a, topicSet(["meal prep", "budget cooking"]))).toBe(1)
    expect(jaccard(a, topicSet(["golang"]))).toBe(0)
    expect(topicOverlapFeature(a, topicSet(["golang"]))).toBe(0)
  })

  it("is neutral when either side has no topics", () => {
    expect(jaccard(new Set(), topicSet(["a"]))).toBeNull()
    expect(topicOverlapFeature(new Set(), new Set())).toBe(NEUTRAL)
    expect(topicSet(["  ", "#"]).size).toBe(0)
  })
})

describe("format_fit", () => {
  it("is 1 with a shipped item of a wanted format, else 0.5", () => {
    expect(formatFitFeature(["app"], ["tool", "app"])).toBe(1)
    expect(formatFitFeature(["template"], ["app"])).toBe(0.5)
    expect(formatFitFeature([], ["app"])).toBe(0.5)
    expect(formatFitFeature(["app"], [])).toBe(0.5)
    expect(formatFitFeature(["tool", "app"], ["app"])).toBe(1)
  })
})

describe("audience_fit", () => {
  it("multiplies language overlap and geo overlap", () => {
    expect(languageOverlap(["en", "es"], ["EN"])).toBe(1)
    expect(languageOverlap(["en"], ["de"])).toBe(0)
    expect(languageOverlap(["en", "de"], ["de", "fr"])).toBe(0.5)
    expect(
      geoOverlap(
        [
          { country: "GB", share: 0.6 },
          { country: "US", share: 0.4 },
        ],
        [{ country: "gb", share: 1 }],
      ),
    ).toBeCloseTo(0.6)
    // Shares are normalised first (providers list only their top countries).
    expect(geoOverlap([{ country: "GB", share: 0.3 }], [{ country: "GB", share: 0.5 }])).toBe(1)
    expect(
      audienceFitFeature(
        { languages: ["en"], countries: [{ country: "GB", share: 1 }] },
        { languages: ["en"], countries: [{ country: "GB", share: 1 }] },
      ),
    ).toBe(1)
    expect(
      audienceFitFeature(
        { languages: ["en"], countries: [{ country: "GB", share: 1 }] },
        { languages: ["de"], countries: [{ country: "GB", share: 1 }] },
      ),
    ).toBe(0)
  })

  it("is 0.5 when both factors are unknown, and an unknown factor counts √0.5", () => {
    expect(
      audienceFitFeature({ languages: [], countries: [] }, { languages: [], countries: [] }),
    ).toBe(NEUTRAL)
    expect(
      audienceFitFeature(
        { languages: ["en"], countries: [] },
        { languages: ["en"], countries: [] },
      ),
    ).toBeCloseTo(Math.SQRT1_2)
    expect(languageOverlap([], ["en"])).toBeNull()
    expect(geoOverlap([], [{ country: "GB", share: 1 }])).toBeNull()
    expect(geoOverlap([{ country: "GB", share: 0 }], [{ country: "GB", share: 1 }])).toBeNull()
  })
})

describe("price_fit", () => {
  it("is 1 − |a − b| ÷ max(a, b), clamped", () => {
    const eur = (cents: number) => ({ cents, currency: "eur" })
    expect(priceFit(eur(1000), eur(1000))).toBe(1)
    expect(priceFit(eur(1000), eur(500))).toBe(0.5)
    expect(priceFit(eur(0), eur(0))).toBe(1)
    expect(priceFit(eur(0), eur(900))).toBe(0)
    expect(priceFit(eur(900), { cents: 900, currency: "USD" })).toBeNull()
    expect(priceFit(null, eur(900))).toBeNull()
    expect(priceFit(eur(-1), eur(900))).toBeNull()
  })

  it("takes the best comparable pair, 0.5 when none", () => {
    const eur = (cents: number) => ({ cents, currency: "eur" })
    expect(priceFitFeature([eur(900), eur(2000)], [eur(1900)])).toBe(0.95)
    expect(priceFitFeature([], [eur(1900)])).toBe(NEUTRAL)
    expect(priceFitFeature([null], [null])).toBe(NEUTRAL)
  })
})

describe("reliability", () => {
  it("starts at 0.5, goes up with completed collabs and down with disputes", () => {
    expect(reliabilityFeature({ completed: 0, disputes: 0 })).toBe(0.5)
    expect(reliabilityFeature({ completed: 1, disputes: 0 })).toBe(0.625)
    expect(reliabilityFeature({ completed: 2, disputes: 0 })).toBeCloseTo(0.71875)
    expect(reliabilityFeature({ completed: 0, disputes: 1 })).toBeCloseTo(0.3)
    expect(reliabilityFeature({ completed: 0, disputes: 2 })).toBeCloseTo(0.18)
    expect(reliabilityFeature({ completed: 100, disputes: 0 })).toBeLessThanOrEqual(1)
    expect(reliabilityFeature({ completed: 0, disputes: 100 })).toBeGreaterThanOrEqual(0)
    expect(reliabilityFeature({ completed: 1, disputes: 1 })).toBeCloseTo(0.425)
    expect(reliabilityFeature({ completed: -3, disputes: -1 })).toBe(0.5)
  })
})

describe("stage_fit", () => {
  it("favours beta/live for larger creators and idea/prototype for smaller ones", () => {
    expect(STAGE_FIT_TABLE.macro.live).toBeGreaterThan(STAGE_FIT_TABLE.macro.idea)
    expect(STAGE_FIT_TABLE.nano.prototype).toBeGreaterThan(STAGE_FIT_TABLE.nano.live)
    expect(stageFitFeature("mid", ["idea", "beta"])).toBe(1)
    expect(stageFitFeature("nano", ["live"])).toBe(0.5)
    expect(stageFitFeature(null, ["beta"])).toBe(NEUTRAL)
    expect(stageFitFeature("macro", [])).toBe(NEUTRAL)
    for (const row of Object.values(STAGE_FIT_TABLE)) {
      for (const value of Object.values(row)) expect(value).toBe(clamp01(value))
    }
  })
})

describe("pairFeatures", () => {
  it("builds the full vector for a creator looking at a product", () => {
    const product = builder.products[0]
    if (!product) throw new Error("no product")
    const features = pairFeatures({
      targetType: "product",
      creator,
      builder,
      product,
      cosine: 0.8,
      reliability: { completed: 1, disputes: 0 },
    })
    expect(features).toEqual({
      semantic: 0.8,
      // creator {meal prep, budget cooking, grocery lists} vs product {meal prep}
      topic_overlap: 1 / 3,
      // The builder has no languages or country: both factors unknown.
      audience_fit: 0.5,
      format_fit: 1,
      stage_fit: 1, // micro × beta
      price_fit: 0.75, // 900 vs 1200
      reliability: 0.625,
    })
  })

  it("compares a builder's skills, stack and products with an idea", () => {
    const idea = creator.ideas[0]
    if (!idea) throw new Error("no idea")
    const features = pairFeatures({
      targetType: "idea",
      creator,
      builder,
      idea,
      cosine: null,
      reliability: { completed: 0, disputes: 0 },
    })
    expect(features).toMatchObject({
      semantic: 0.5,
      topic_overlap: 0, // {react, meal prep, typescript} vs {grocery lists}
      format_fit: 1,
      stage_fit: 1,
      price_fit: 0.75,
    })
  })

  it("compares two people through the creator's ideas and the builder's products", () => {
    const features = pairFeatures({
      targetType: "creator",
      creator: { ...creator, ideas: [], sizeTier: null },
      builder: { ...builder, products: [], languages: ["en"], country: "GB" },
      cosine: 0.3,
      reliability: { completed: 0, disputes: 0 },
    })
    expect(features).toMatchObject({
      semantic: 0.3,
      // {meal prep, budget cooking} vs {react, meal prep, typescript}
      topic_overlap: 0.25,
      // Same language; 60% of the audience is in the builder's country.
      audience_fit: 0.6,
      format_fit: 0.5,
      stage_fit: 0.5,
      price_fit: 0.5,
    })
  })

  it("gives explanations evidence without names", () => {
    const evidence = pairEvidence({
      targetType: "builder",
      creator,
      builder: { ...builder, languages: ["es"] },
      cosine: 0.5,
      reliability: { completed: 0, disputes: 0 },
    })
    expect(evidence).toEqual({
      sharedTopics: ["meal prep"],
      format: "app",
      stage: "beta",
      sizeTier: "micro",
      sharedLanguages: ["es"],
    })
    expect(roleForTargetType("product")).toBe("creator")
    expect(roleForTargetType("creator")).toBe("builder")
  })
})
