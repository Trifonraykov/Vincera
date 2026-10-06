import type {
  MatchFeature,
  MatchFeatures,
  MatchWeights,
  ProductFormat,
  TargetType,
} from "@/lib/db/schema"
import { SIZE_TIER_LABELS } from "@/lib/social/size-tier"

import type { PairEvidence } from "./features"
import { contributions } from "./score"

/**
 * Match explanations in plain language (§7.3 use 3, §8 "The explanation names the top two
 * contributing features in plain language"). Pure and client-safe:
 *
 * - `templateExplanation` is the deterministic sentence pages show until the model's sentence is
 *   cached, and what the fake AI service returns (§19.16), so the two never disagree;
 * - `explanationKey` is what a cached sentence depends on: the two explained features and the band of
 *   each value. A recompute keeps the cached sentence while the key is unchanged and clears it
 *   otherwise (CLAUDE.md §19.27), so the sentence never names features that no longer lead.
 *
 * Sentences speak to the viewer ("you"), name no one, and never quote scores: values are given
 * as bands ("closely", "a little"), which is also why a band change regenerates the sentence.
 */

export type ViewerRole = "creator" | "builder"

/** How strong a feature value is, for wording. 0.45–0.55 is "neutral": mostly unknown inputs. */
export type FeatureBand = "strong" | "good" | "neutral" | "some" | "weak"

export function featureBand(value: number): FeatureBand {
  if (value >= 0.75) return "strong"
  if (value > 0.55) return "good"
  if (value >= 0.45) return "neutral"
  if (value >= 0.2) return "some"
  return "weak"
}

export type ExplainedFeature = { feature: MatchFeature; value: number }

export type MatchExplanationInput = {
  viewerRole: ViewerRole
  targetType: TargetType
  top: [ExplainedFeature, ExplainedFeature]
  /** Facts the sentence may cite; null on pages, which only have the stored features. */
  evidence: PairEvidence | null
}

/** Plain names of the features, e.g. for the "Why this match" breakdown. */
export const FEATURE_LABELS: Record<MatchFeature, string> = {
  semantic: "Similar focus",
  topic_overlap: "Shared topics",
  audience_fit: "Audience languages and countries",
  format_fit: "Has shipped this format",
  stage_fit: "Product stage for the audience size",
  price_fit: "Price points",
  reliability: "Collab track record",
}

/**
 * The two features an explanation names: §8's "top two contributing features", ranked by
 * contribution (weight × value). A feature that contributes less is never named ahead of one that
 * contributes more, so a weak feature (one that lowered the score) is never given as a reason
 * ahead of a larger one. On an exact tie, a feature outside the neutral band (0.45–0.55, mostly
 * unknown inputs) goes first, then §8's order (CLAUDE.md §19.30; this replaces §19.27's "skip
 * neutral features", which departed from §8 without sign-off).
 */
export function explainedFeatures(
  features: MatchFeatures,
  weights: MatchWeights,
): [ExplainedFeature, ExplainedFeature] {
  const ranked = contributions(features, weights)
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (a, b) =>
        b.contribution - a.contribution ||
        Number(featureBand(a.value) === "neutral") - Number(featureBand(b.value) === "neutral") ||
        a.index - b.index,
    )
  const [first, second] = ranked
  if (!first || !second) throw new Error("explainedFeatures: fewer than two features")
  return [
    { feature: first.feature, value: first.value },
    { feature: second.feature, value: second.value },
  ]
}

/** The cache key of a stored explanation: the two explained features with their bands. */
export function explanationKey(features: MatchFeatures, weights: MatchWeights): string {
  return explainedFeatures(features, weights)
    .map(({ feature, value }) => `${feature}:${featureBand(value)}`)
    .join("|")
}

/** The explanation input for a stored row (pages: no evidence). */
export function explanationInput(
  viewerRole: ViewerRole,
  targetType: TargetType,
  features: MatchFeatures,
  weights: MatchWeights,
  evidence: PairEvidence | null = null,
): MatchExplanationInput {
  return { viewerRole, targetType, top: explainedFeatures(features, weights), evidence }
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

const ADVERBS: Record<FeatureBand, string> = {
  strong: "closely",
  good: "well",
  neutral: "reasonably",
  some: "partly",
  weak: "loosely",
}

/** Who "they" are for a target: the person, or the owner of the idea or product. */
function isThing(targetType: TargetType): boolean {
  return targetType === "product" || targetType === "idea"
}

function semanticClause(input: MatchExplanationInput, band: FeatureBand): string {
  const adverb = ADVERBS[band]
  switch (input.targetType) {
    case "product":
      return `this product fits your content and audience ${adverb}`
    case "builder":
      return `their work fits your content ${adverb}`
    case "idea":
      return `this brief fits what you build ${adverb}`
    case "creator":
      return `their content fits what you build ${adverb}`
  }
}

function topicClause(input: MatchExplanationInput, band: FeatureBand): string {
  const shared = input.evidence?.sharedTopics ?? []
  if (shared.length > 0) {
    return band === "strong" || band === "good"
      ? `you share topics like ${listWords(shared)}`
      : `you both cover ${listWords(shared)}`
  }
  switch (band) {
    case "strong":
      return "your topics overlap a lot"
    case "good":
      return "your topics overlap well"
    case "neutral":
      return "nothing in your topics pulls you apart"
    case "some":
      return "your topics overlap a little"
    case "weak":
      return "your topics barely overlap"
  }
}

function audienceClause(band: FeatureBand, evidence: PairEvidence | null): string {
  const languages = evidence?.sharedLanguages ?? []
  const languageNames = languages.slice(0, 2).map(languageName)
  switch (band) {
    case "strong":
    case "good":
      return languageNames.length > 0
        ? `you reach people in the same language (${listWords(languageNames)}) and places`
        : "your audiences speak the same languages and live in the same places"
    case "neutral":
      return "nothing about language or location stands in the way"
    case "some":
    case "weak":
      return "your audiences partly share languages and countries"
  }
}

const languageNamesFormatter = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" })
  } catch {
    return null
  }
})()

function languageName(code: string): string {
  try {
    return languageNamesFormatter?.of(code) ?? code
  } catch {
    return code
  }
}

/** "an app", "an AI utility", "a template"; "this kind of product" for `other` or unknown. */
const FORMAT_NOUNS: Record<ProductFormat, string> = {
  app: "an app",
  tool: "a tool",
  template: "a template",
  ai_utility: "an AI utility",
  course_tool: "a course tool",
  other: "this kind of product",
}

function formatClause(input: MatchExplanationInput, value: number): string {
  const format = input.evidence?.format
  const noun = format ? FORMAT_NOUNS[format] : "this kind of product"
  const shipped = value >= 1
  if (input.viewerRole === "builder") {
    return shipped ? `you've shipped ${noun} before` : `it would be a new format for you to build`
  }
  return shipped ? `they've shipped ${noun} before` : `it would be a new format for them`
}

function stageClause(input: MatchExplanationInput, band: FeatureBand): string {
  const tier = input.evidence?.sizeTier
  const audience = tier ? `a ${SIZE_TIER_LABELS[tier].toLowerCase()} audience` : "the audience size"
  const good = band === "strong" || band === "good"
  if (input.viewerRole === "creator") {
    const stage = input.evidence?.stage
    const product =
      input.targetType === "product"
        ? stage
          ? `a ${stage} product`
          : "its stage"
        : stage
          ? `their ${stage} product`
          : "their products' stage"
    return good
      ? `${product} suits ${tier ? "an audience your size" : "your audience size"}`
      : `${product} is workable for your audience size`
  }
  return good
    ? `your products are at a stage that suits ${audience}`
    : `your products' stage is workable for ${audience}`
}

function priceClause(band: FeatureBand): string {
  switch (band) {
    case "strong":
      return "your price points are close"
    case "good":
      return "your price points are in the same range"
    case "neutral":
      return "the price is open to agree"
    case "some":
    case "weak":
      return "your price points differ but could meet"
  }
}

function reliabilityClause(input: MatchExplanationInput, value: number): string {
  const whose = isThing(input.targetType) ? "its owner has" : "they have"
  if (value > 0.55) return `${whose} a good track record on past collabs`
  if (value >= 0.45) return `${whose} a clean record so far`
  return `${whose} some collab history to talk through`
}

function clause(input: MatchExplanationInput, { feature, value }: ExplainedFeature): string {
  const band = featureBand(value)
  switch (feature) {
    case "semantic":
      return semanticClause(input, band)
    case "topic_overlap":
      return topicClause(input, band)
    case "audience_fit":
      return audienceClause(band, input.evidence)
    case "format_fit":
      return formatClause(input, value)
    case "stage_fit":
      return stageClause(input, band)
    case "price_fit":
      return priceClause(band)
    case "reliability":
      return reliabilityClause(input, value)
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The deterministic sentence for the top two features, e.g. "This product fits your content and
 * audience closely, and you share topics like budget and meal prep."
 */
export function templateExplanation(input: MatchExplanationInput): string {
  const [first, second] = input.top
  return `${capitalize(clause(input, first))}, and ${clause(input, second)}.`
}
