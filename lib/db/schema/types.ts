// Relative import: drizzle-kit loads the schema without the `@/` alias. The module is
// dependency-free and client-safe.
import type { OnboardingStepsRecord } from "../../onboarding/steps"

import type { AudienceBasis, CollabRole, DeliveryType } from "./enums"

/**
 * TypeScript shapes of the jsonb columns (§5). Columns are typed with `$type<...>()`; the database
 * does not enforce these shapes, so writers must build them from validated (Zod-parsed) data.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// --- Identity & profiles ---------------------------------------------------------------------

/**
 * users.onboarding_steps: step id → `{ status: "done" | "skipped", at }` (lib/onboarding/steps.ts).
 * Written only by `completeOnboardingStep()` (lib/onboarding/complete-step.ts).
 */
export type { OnboardingStepsRecord }

// --- Social data -------------------------------------------------------------------------------
// The shapes providers return (`AudienceSnapshotInput`, lib/social/types.ts) are stored as they
// are; a compile-time check there keeps the two in sync.

/**
 * audience_snapshots.top_countries: ISO 3166-1 alpha-2 code with its share of the audience.
 * What the shares are fractions of is in audience_snapshots.countries_basis.
 */
export type CountryShare = {
  country: string
  /** 0–1 */
  share: number
}

/** One (age group, gender) bucket the provider reports. */
export type AgeGenderBucket = {
  /** Provider age group normalised to e.g. "18-24", "65+". */
  ageGroup: string
  /** `other`: YouTube's "user_specified"; `unknown`: Instagram's "U". */
  gender: "female" | "male" | "other" | "unknown"
  /** 0–1 */
  share: number
}

/** audience_snapshots.age_gender: the buckets plus what their shares are fractions of. */
export type AgeGender = {
  basis: AudienceBasis
  buckets: AgeGenderBucket[]
}

/**
 * audience_snapshots.raw: the subset of the provider payload worth keeping for re-processing
 * (never tokens). The provider is the snapshot's social connection's.
 */
export type SnapshotRaw = JsonObject

// --- Imported listings (CLAUDE.md §19.45) ------------------------------------------------------

/**
 * products.media: the listing's images, copied into our storage (never hotlinked). `key` is the
 * storage key, `hash` the first 16 hex characters of sha256(source URL), so a re-sync skips images
 * it already has. Pages show them through `/api/products/<id>/media/<hash>`.
 */
export type ProductMediaItem = {
  kind: "icon" | "screenshot" | "image"
  key: string
  hash: string
  contentType: string
  width: number | null
  height: number | null
}

/** products.source_meta for an App Store import: the lookup fields worth showing. */
export type AppStoreSourceMeta = {
  kind: "app_store"
  trackId: string
  artistId: string
  artistName: string
  sellerName: string | null
  country: string
  /** Apple's own label ("Free", "$4.99"). */
  priceLabel: string | null
  price: number | null
  currency: string | null
  rating: number | null
  ratingCount: number | null
  genre: string | null
  genres: string[]
  releaseDate: string | null
  currentVersionReleaseDate: string | null
}

/** products.source_meta for a web import. */
export type WebSourceMeta = {
  kind: "web"
  domain: string
  siteName: string | null
  /** The page after redirects (http(s) only). */
  finalUrl: string
  priceLabel: string | null
  rating: number | null
  ratingCount: number | null
  category: string | null
}

export type ProductSourceMeta = AppStoreSourceMeta | WebSourceMeta

// --- Matching (§8) -----------------------------------------------------------------------------

export const MATCH_FEATURES = [
  "semantic",
  "topic_overlap",
  "audience_fit",
  "format_fit",
  "stage_fit",
  "price_fit",
  "reliability",
] as const
export type MatchFeature = (typeof MATCH_FEATURES)[number]

/** matches.features: the full feature vector (each 0–1). It is the training data for v1. */
export type MatchFeatures = Record<MatchFeature, number>

/** matching_config.weights: one weight per feature. */
export type MatchWeights = Record<MatchFeature, number>

/** proposals.match_snapshot: the match a proposal was sent from, frozen at send time (§19.38). */
export type MatchSnapshot = {
  modelVersion: string
  score: number
  features: MatchFeatures
  /** The match row's `computed_at`, ISO 8601. */
  computedAt: string
}

/** The two v1 outcomes (§8): "proposal accepted" and "launch made ≥ 1 sale". */
export const MATCHING_TARGETS = ["accepted", "sale"] as const
export type MatchingTarget = (typeof MATCHING_TARGETS)[number]

/**
 * One fitted logistic regression over the §8 features (CLAUDE.md §19.38): the features are
 * standardised with `means` / `stds` (a std of 0 makes the feature contribute nothing), then
 * p = σ(intercept + Σ coefficient × standardised feature).
 */
export type LogisticModelParams = {
  intercept: number
  coefficients: Record<MatchFeature, number>
  means: Record<MatchFeature, number>
  stds: Record<MatchFeature, number>
}

/**
 * matching_config.model for `kind = 'logistic'` (Phase 7 v1). The ranking score is the
 * probability of `scoreTarget`; the other target's model is kept for evaluation (null when it
 * had too few positives to fit).
 */
export type MatchingModel = {
  kind: "logistic"
  v: 1
  scoreTarget: MatchingTarget
  l2: number
  targets: Record<MatchingTarget, LogisticModelParams | null>
}

/**
 * matching_config.metrics: the evaluation the trainer stored (held-out AUC, log loss,
 * calibration, sample sizes, the v0 comparison). Its exact shape belongs to lib/matching/v1.
 */
export type MatchingMetrics = JsonObject

// --- Collaboration -----------------------------------------------------------------------------

/** agreements.terms: snapshot of the deal the agreement text was rendered from. */
export type AgreementTerms = {
  parties: {
    userId: string
    role: CollabRole
    /** Legal/display name as it appears in the agreement. */
    name: string
    splitPct: number
  }[]
  scope: string
  timelineWeeks: number
  ip: string
  term: string
  exit: string
}

/** messages.attachments: files uploaded to private storage (R2), referenced by key. */
export type MessageAttachment = {
  storageKey: string
  filename: string
  contentType: string
  sizeBytes: number
}

// --- Launch & commerce -------------------------------------------------------------------------

/** launches.media: product page media in display order. */
export type LaunchMedia = {
  kind: "image" | "video"
  /** Public URL, or a storage key for uploaded media. */
  url: string
  alt: string
}

/** launches.delivery_config, discriminated by launches.delivery_type. */
export type DeliveryConfig =
  | { type: Extract<DeliveryType, "file"> }
  | { type: Extract<DeliveryType, "license_key">; instructions?: string }
  | { type: Extract<DeliveryType, "url">; url: string }

/** launches.approved_by: one entry per member (and admin) approval of the current version. */
export type LaunchApproval = {
  userId: string
  role: CollabRole | "admin"
  /** ISO 8601 timestamp. */
  approvedAt: string
}

// --- Trust & ops -------------------------------------------------------------------------------

/** notifications.payload: what the notification UI needs to render and link. */
export type NotificationPayload = JsonObject

/** admin_audit_log.before / after: the changed fields of the target row. */
export type AuditSnapshot = JsonObject

// --- Events (§11) ------------------------------------------------------------------------------

/**
 * events.context: request context, never PII. `session_id` is an opaque analytics session id,
 * never the Auth.js session token.
 */
export type EventContext = {
  /** ISO 3166-1 alpha-2 country derived from the IP (the IP itself is not stored). */
  ip_country?: string | null
  /** Salted hash of the user agent. */
  ua_hash?: string | null
  session_id?: string | null
}
