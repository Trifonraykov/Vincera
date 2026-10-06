import type {
  MatchFeature,
  MatchFeatures,
  ProductFormat,
  ProductStage,
  SizeTier,
  TargetType,
} from "@/lib/db/schema"
import type { CountryShare } from "@/lib/db/schema/types"
import { normalizeTopic } from "@/lib/social/summary-form"

/**
 * Matching v0 features (§8), each normalised to 0–1. Pure and client-safe: the recompute
 * (lib/matching/recompute.ts) loads the facts, these functions turn them into the feature vector
 * that is stored on every `matches` row (v1's training data), and tests pin every edge case.
 *
 * Rule for missing data (CLAUDE.md §19.24 "Unknown inputs give the neutral 0.5"): a feature whose
 * inputs are unknown on either side is 0.5, so a thin profile is neither rewarded nor punished.
 * The exact definitions, including which facts stand in for each side, are in CLAUDE.md §19.27.
 */

/** The neutral value of a feature whose inputs are unknown. */
export const NEUTRAL = 0.5

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

// --- semantic ---------------------------------------------------------------------------------

/** Cosine similarity of two vectors (−1…1); null when either is empty, zero or of another length. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return null
  return dot / Math.sqrt(normA * normB)
}

/**
 * `semantic`: the cosine similarity of the two embeddings, clamped to 0–1 (an opposite direction
 * is no fit, not a negative one). Null (a missing embedding) is the neutral 0.5. The recompute
 * gets the cosine from pgvector (`1 - (a <=> b)`) so vectors never leave the database.
 */
export function semanticFeature(cosine: number | null): number {
  if (cosine === null || !Number.isFinite(cosine)) return NEUTRAL
  return clamp01(cosine)
}

// --- topic_overlap ----------------------------------------------------------------------------

/** Topics as one comparable set: the shared topic rule (lowercase, `#` dropped), blanks out. */
export function topicSet(...lists: readonly (readonly string[])[]): Set<string> {
  const set = new Set<string>()
  for (const list of lists) {
    for (const topic of list) {
      const normalized = normalizeTopic(topic)
      if (normalized) set.add(normalized)
    }
  }
  return set
}

/** Jaccard index |A ∩ B| ÷ |A ∪ B|; null when either set is empty (unknown, not "no overlap"). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number | null {
  if (a.size === 0 || b.size === 0) return null
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** `topic_overlap`: Jaccard of the two topic sets; 0.5 when a side has no topics. */
export function topicOverlapFeature(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  return jaccard(a, b) ?? NEUTRAL
}

/** The topics both sides share, in `a`'s order (evidence for explanations). */
export function sharedTopics(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((topic) => b.has(topic))
}

// --- format_fit -------------------------------------------------------------------------------

/**
 * `format_fit` (§8): 1 when the builder has a shipped portfolio item of one of the wanted formats,
 * else 0.5. Nothing wanted (no format to compare) is also 0.5.
 */
export function formatFitFeature(
  wanted: readonly ProductFormat[],
  shippedFormats: readonly ProductFormat[],
): number {
  return wanted.some((format) => shippedFormats.includes(format)) ? 1 : NEUTRAL
}

// --- audience_fit -----------------------------------------------------------------------------

/**
 * One side of `audience_fit`: the languages it works in and where its people are (country shares;
 * a person's own country is one country with share 1). Empty lists are unknown.
 */
export type AudienceSide = {
  languages: readonly string[]
  countries: readonly CountryShare[]
}

/**
 * Language overlap: the share of the smaller language list the other side also uses (the overlap
 * coefficient), so a creator who posts in English and Spanish fits an English-only product fully.
 * Null when either side's languages are unknown.
 */
export function languageOverlap(a: readonly string[], b: readonly string[]): number | null {
  const left = new Set(a.map((code) => code.trim().toLowerCase()).filter(Boolean))
  const right = new Set(b.map((code) => code.trim().toLowerCase()).filter(Boolean))
  if (left.size === 0 || right.size === 0) return null
  let shared = 0
  for (const code of left) if (right.has(code)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/**
 * Geo overlap: the histogram intersection Σ min(shareA, shareB) of the two country distributions
 * (each normalised to sum 1 first, since providers list only their top countries). One side being a
 * single country gives the other side's share in it. Null when either side's countries are unknown.
 */
export function geoOverlap(a: readonly CountryShare[], b: readonly CountryShare[]): number | null {
  const left = normalizeShares(a)
  const right = normalizeShares(b)
  if (left.size === 0 || right.size === 0) return null
  let overlap = 0
  for (const [country, share] of left) overlap += Math.min(share, right.get(country) ?? 0)
  return clamp01(overlap)
}

function normalizeShares(shares: readonly CountryShare[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const { country, share } of shares) {
    if (!Number.isFinite(share) || share <= 0) continue
    const code = country.trim().toUpperCase()
    totals.set(code, (totals.get(code) ?? 0) + share)
  }
  const sum = [...totals.values()].reduce((total, share) => total + share, 0)
  if (sum <= 0) return new Map()
  return new Map([...totals].map(([country, share]) => [country, share / sum]))
}

/**
 * A factor that is unknown counts √0.5 in the product, so both unknown give exactly the neutral
 * 0.5 and one known factor still moves the feature (CLAUDE.md §19.27).
 */
const UNKNOWN_FACTOR = Math.SQRT1_2

/** `audience_fit` (§8): language overlap × geo overlap, 0.5 when both are unknown. */
export function audienceFitFeature(a: AudienceSide, b: AudienceSide): number {
  const language = languageOverlap(a.languages, b.languages)
  const geo = geoOverlap(a.countries, b.countries)
  if (language === null && geo === null) return NEUTRAL
  return clamp01((language ?? UNKNOWN_FACTOR) * (geo ?? UNKNOWN_FACTOR))
}

// --- price_fit --------------------------------------------------------------------------------

/** A planned price in integer cents (§0) with its currency. */
export type PriceTag = { cents: number; currency: string }

/**
 * `price_fit` for one pair (§8): 1 − |a − b| ÷ max(a, b), clamped to 0–1. Two free prices fit
 * exactly; prices in different currencies cannot be compared (null).
 */
export function priceFit(a: PriceTag | null, b: PriceTag | null): number | null {
  if (!a || !b) return null
  if (a.currency.toLowerCase() !== b.currency.toLowerCase()) return null
  if (a.cents < 0 || b.cents < 0) return null
  const larger = Math.max(a.cents, b.cents)
  if (larger === 0) return 1
  return clamp01(1 - Math.abs(a.cents - b.cents) / larger)
}

/**
 * `price_fit` between two sets of prices (a creator's open ideas, a builder's products): the best
 * fitting pair, since one good fit is enough to work together. 0.5 when nothing is comparable.
 */
export function priceFitFeature(
  left: readonly (PriceTag | null)[],
  right: readonly (PriceTag | null)[],
): number {
  let best: number | null = null
  for (const a of left) {
    for (const b of right) {
      const fit = priceFit(a, b)
      if (fit !== null && (best === null || fit > best)) best = fit
    }
  }
  return best ?? NEUTRAL
}

// --- reliability ------------------------------------------------------------------------------

/** A person's collab history (§8 `reliability`). */
export type CollabHistory = {
  /** Collabs that went live, or ended `completed`. */
  completed: number
  /** Disputes raised against them by another member of their collabs. */
  disputes: number
}

/**
 * `reliability` (§8): starts at 0.5; each completed collab closes a quarter of the remaining gap to
 * 1 (1 → 0.625, 2 → 0.72, 4 → 0.84), each dispute against the person removes 40 % of what is left
 * of the 0.5 below the baseline (1 → 0.3, 2 → 0.18). Both apply, clamped to 0–1.
 */
export function reliabilityFeature(history: CollabHistory): number {
  const completed = Math.max(0, Math.floor(history.completed))
  const disputes = Math.max(0, Math.floor(history.disputes))
  const up = 0.5 * (1 - 0.75 ** completed)
  const down = 0.5 * (1 - 0.6 ** disputes)
  return clamp01(NEUTRAL + up - down)
}

// --- stage_fit --------------------------------------------------------------------------------

/**
 * `stage_fit` lookup (§8): larger creators score higher with beta/live products (their audience
 * expects something that works), smaller creators with idea/prototype (room to shape it together
 * and a lower bar to launch). Rows: creator size tier; columns: product stage.
 */
export const STAGE_FIT_TABLE: Record<SizeTier, Record<ProductStage, number>> = {
  nano: { idea: 0.9, prototype: 1, beta: 0.7, live: 0.5 },
  micro: { idea: 0.7, prototype: 0.9, beta: 1, live: 0.8 },
  mid: { idea: 0.4, prototype: 0.6, beta: 1, live: 0.9 },
  macro: { idea: 0.2, prototype: 0.4, beta: 0.8, live: 1 },
}

/** `stage_fit` for a creator tier and the stages on offer: the best one; 0.5 when either is unknown. */
export function stageFitFeature(tier: SizeTier | null, stages: readonly ProductStage[]): number {
  if (!tier || stages.length === 0) return NEUTRAL
  return Math.max(...stages.map((stage) => STAGE_FIT_TABLE[tier][stage]))
}

// --- pairs ------------------------------------------------------------------------------------

/** An open idea of a creator (its owner's side of every pair it is part of). */
export type IdeaFacts = {
  format: ProductFormat
  price: PriceTag | null
  topics: readonly string[]
}

/** A seeking product of a builder. */
export type ProductFacts = {
  format: ProductFormat
  stage: ProductStage
  price: PriceTag | null
  topics: readonly string[]
}

/** Everything matching knows about a creator. */
export type CreatorFacts = {
  userId: string
  topics: readonly string[]
  languages: readonly string[]
  /** The audience's countries (the largest verified platform's latest snapshot); [] when unknown. */
  audienceCountries: readonly CountryShare[]
  sizeTier: SizeTier | null
  /** The creator's open ideas. */
  ideas: readonly IdeaFacts[]
}

/** Everything matching knows about a builder. */
export type BuilderFacts = {
  userId: string
  skills: readonly string[]
  stack: readonly string[]
  /** Formats of the builder's shipped portfolio items. */
  shippedFormats: readonly ProductFormat[]
  /** The builder's seeking products. */
  products: readonly ProductFacts[]
  /**
   * Builder profiles have no languages or country (§5); a builder who is also a creator lends them
   * from their creator profile, otherwise they are unknown (CLAUDE.md §19.27).
   */
  languages: readonly string[]
  country: string | null
}

/**
 * One (subject, target) pair. The subject is the person the match is computed for; the target is a
 * product or builder (creator subjects) or an idea or creator (builder subjects). `cosine` is the
 * embeddings' cosine similarity (null when either is missing); `reliability` is the target
 * person's (the owner's for ideas and products).
 */
export type MatchPair =
  | {
      targetType: "product"
      creator: CreatorFacts
      builder: BuilderFacts
      product: ProductFacts
      cosine: number | null
      reliability: CollabHistory
    }
  | {
      targetType: "builder"
      creator: CreatorFacts
      builder: BuilderFacts
      cosine: number | null
      reliability: CollabHistory
    }
  | {
      targetType: "idea"
      creator: CreatorFacts
      builder: BuilderFacts
      idea: IdeaFacts
      cosine: number | null
      reliability: CollabHistory
    }
  | {
      targetType: "creator"
      creator: CreatorFacts
      builder: BuilderFacts
      cosine: number | null
      reliability: CollabHistory
    }

/** A creator's topics for matching: their profile topics plus their open ideas' topics. */
export function creatorTopicSet(creator: CreatorFacts): Set<string> {
  return topicSet(creator.topics, ...creator.ideas.map((idea) => idea.topics))
}

/** A builder's topics for matching: skills, stack and their seeking products' topics. */
export function builderTopicSet(builder: BuilderFacts): Set<string> {
  return topicSet(
    builder.skills,
    builder.stack,
    ...builder.products.map((product) => product.topics),
  )
}

function creatorAudience(creator: CreatorFacts): AudienceSide {
  return { languages: creator.languages, countries: creator.audienceCountries }
}

function builderAudience(builder: BuilderFacts): AudienceSide {
  return {
    languages: builder.languages,
    countries: builder.country ? [{ country: builder.country, share: 1 }] : [],
  }
}

/** The topic sets a pair compares: the subject-side set first. */
export function pairTopicSets(pair: MatchPair): [Set<string>, Set<string>] {
  switch (pair.targetType) {
    case "product":
      return [creatorTopicSet(pair.creator), topicSet(pair.product.topics)]
    case "builder":
      return [creatorTopicSet(pair.creator), builderTopicSet(pair.builder)]
    case "idea":
      return [builderTopicSet(pair.builder), topicSet(pair.idea.topics)]
    case "creator":
      return [builderTopicSet(pair.builder), creatorTopicSet(pair.creator)]
  }
}

/** The full §8 feature vector for a pair (what `matches.features` stores). */
export function pairFeatures(pair: MatchPair): MatchFeatures {
  const [subjectTopics, targetTopics] = pairTopicSets(pair)
  const creatorIdeaPrices = pair.creator.ideas.map((idea) => idea.price)
  const builderProductPrices = pair.builder.products.map((product) => product.price)
  const builderStages = pair.builder.products.map((product) => product.stage)

  let formatFit: number
  let priceFitValue: number
  let stageFit: number
  switch (pair.targetType) {
    case "product":
      formatFit = formatFitFeature([pair.product.format], pair.builder.shippedFormats)
      priceFitValue = priceFitFeature(creatorIdeaPrices, [pair.product.price])
      stageFit = stageFitFeature(pair.creator.sizeTier, [pair.product.stage])
      break
    case "idea":
      formatFit = formatFitFeature([pair.idea.format], pair.builder.shippedFormats)
      priceFitValue = priceFitFeature([pair.idea.price], builderProductPrices)
      stageFit = stageFitFeature(pair.creator.sizeTier, builderStages)
      break
    case "builder":
    case "creator":
      formatFit = formatFitFeature(
        pair.creator.ideas.map((idea) => idea.format),
        pair.builder.shippedFormats,
      )
      priceFitValue = priceFitFeature(creatorIdeaPrices, builderProductPrices)
      stageFit = stageFitFeature(pair.creator.sizeTier, builderStages)
      break
  }

  return {
    semantic: semanticFeature(pair.cosine),
    topic_overlap: topicOverlapFeature(subjectTopics, targetTopics),
    audience_fit: audienceFitFeature(creatorAudience(pair.creator), builderAudience(pair.builder)),
    format_fit: formatFit,
    stage_fit: stageFit,
    price_fit: priceFitValue,
    reliability: reliabilityFeature(pair.reliability),
  }
}

/** Facts an explanation may cite for a pair (never names, emails or free text but topics). */
export type PairEvidence = {
  sharedTopics: string[]
  /** The idea's or product's format, when the target is one. */
  format: ProductFormat | null
  /** The product's stage (product targets). */
  stage: ProductStage | null
  sizeTier: SizeTier | null
  sharedLanguages: string[]
}

export function pairEvidence(pair: MatchPair): PairEvidence {
  const [subjectTopics, targetTopics] = pairTopicSets(pair)
  const builderLanguages = new Set(pair.builder.languages.map((code) => code.toLowerCase()))
  // Between two people: the creator's idea format the builder has shipped, and the builder's
  // product stage that fits the creator's audience best (what `format_fit` and `stage_fit` used).
  const shippedIdeaFormat =
    pair.creator.ideas.find((idea) => pair.builder.shippedFormats.includes(idea.format))?.format ??
    null
  const tier = pair.creator.sizeTier
  const bestStage =
    tier && pair.builder.products.length > 0
      ? pair.builder.products.reduce((best, product) =>
          STAGE_FIT_TABLE[tier][product.stage] > STAGE_FIT_TABLE[tier][best.stage] ? product : best,
        ).stage
      : null
  return {
    sharedTopics: sharedTopics(subjectTopics, targetTopics).slice(0, 3),
    format:
      pair.targetType === "product"
        ? pair.product.format
        : pair.targetType === "idea"
          ? pair.idea.format
          : shippedIdeaFormat,
    stage: pair.targetType === "product" ? pair.product.stage : bestStage,
    sizeTier: pair.creator.sizeTier,
    sharedLanguages: pair.creator.languages.filter((code) =>
      builderLanguages.has(code.toLowerCase()),
    ),
  }
}

/** Which side of the platform sees which target types (§8 "Candidates"). */
export const TARGET_TYPES_FOR_ROLE = {
  creator: ["product", "builder"],
  builder: ["idea", "creator"],
} as const satisfies Record<"creator" | "builder", readonly TargetType[]>

/** The role whose list a target type belongs to. */
export function roleForTargetType(targetType: TargetType): "creator" | "builder" {
  return targetType === "product" || targetType === "builder" ? "creator" : "builder"
}

export type { MatchFeature, MatchFeatures }
