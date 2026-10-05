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
