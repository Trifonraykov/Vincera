import type {
  CollabRole,
  CollabStage,
  DeliveryType,
  DisputeKind,
  EventContext,
  IdeaStatus,
  ProductFormat,
  ProductStage,
  ProductStatus,
  SizeTier,
  SocialConnectionSource,
  SocialProvider,
  TargetType,
  ThreadKind,
  UserRole,
} from "@/lib/db/schema"

/**
 * The business event catalog (CLAUDE.md §11): every event type, the kind of entity it is about
 * (`subject`) and its exact properties.
 *
 * Rules for properties: ids, enums, counts and amounts only. Never message bodies, emails, names,
 * tokens or free text written by users. `track()` also rejects suspicious keys at runtime.
 * Property keys are snake_case; money is integer cents with its currency.
 */

export type { EventContext }

/** Entity kinds an event can be about; `subject_id` is that entity's id. */
export const SUBJECT_TYPES = [
  "user",
  "creator_profile",
  "builder_profile",
  "social_connection",
  "idea",
  "product",
  "match",
  "proposal",
  "collab",
  "agreement",
  "task",
  "thread",
  "launch",
  "tracked_link",
  "order",
  "transfer",
  "dispute",
] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

/** How a user signed up or in (Auth.js providers, §6). */
export type AuthMethod = "email" | "google" | "github"

/**
 * How a role was added: chosen during onboarding, granted on sign-up because the email is in
 * ADMIN_EMAILS, or granted by an operator with `pnpm admin:grant`.
 */
export type RoleSource = "onboarding" | "admin_emails" | "admin_cli"

/** What triggered a matching recompute (§8, §13). */
export type MatchTrigger = "nightly" | "on_change" | "manual"

/** Claude API uses (§7.3). */
export type AiUse = "audience_summary" | "idea_brief" | "match_explanation" | "launch_kit"

/** Why a social connection stopped working (§7.1). */
export type SocialExpiryReason = "refresh_failed" | "unauthorized" | "revoked"

/** Who paused a launch. */
export type LaunchPausedBy = "member" | "admin" | "dispute"

type NoProperties = Record<string, never>

/** Fields shared by match.* interaction events. */
type MatchInteraction = {
  model_version: string
  target_type: TargetType
  /** 1-based position in the list the user saw. */
  rank: number | null
}

type ProposalTerms = {
  /** 1 for the first offer, +1 per counter. */
  revision_number: number
  creator_split_pct: number
  builder_split_pct: number
  timeline_weeks: number
}

/**
 * Event type → subject kind (null = no subject) and properties.
 * `ai.generated` is about whatever was generated for, so its subject is a union.
 */
export interface EventCatalog {
  // Identity & onboarding
  "user.signed_up": { subject: "user"; properties: { method: AuthMethod } }
  "user.role_added": { subject: "user"; properties: { role: UserRole; source: RoleSource } }
  "onboarding.completed": { subject: "user"; properties: { role: CollabRole } }

  // Social connections
  "social.connected": {
    subject: "social_connection"
    properties: { provider: SocialProvider; source: SocialConnectionSource }
  }
  "social.synced": {
    subject: "social_connection"
    properties: {
      provider: SocialProvider
      snapshot_id: string
      followers: number | null
      size_tier: SizeTier | null
    }
  }
  "social.expired": {
    subject: "social_connection"
    properties: { provider: SocialProvider; reason: SocialExpiryReason }
  }

  // Supply & demand
  "idea.created": {
    subject: "idea"
    properties: { format: ProductFormat; topics: string[]; target_price_cents: number | null }
  }
  "idea.published": { subject: "idea"; properties: NoProperties }
  "idea.archived": { subject: "idea"; properties: { from_status: IdeaStatus } }
  "product.created": {
    subject: "product"
    properties: {
      format: ProductFormat
      stage: ProductStage
      topics: string[]
      target_price_cents: number | null
    }
  }
  "product.published": { subject: "product"; properties: NoProperties }
  "product.archived": { subject: "product"; properties: { from_status: ProductStatus } }

  // Matching (§8)
  /** Batch summary: one event per subject user per recompute. */
  "match.computed": {
    subject: "user"
    properties: {
      model_version: string
      trigger: MatchTrigger
      candidates: number
      stored: number
      top_score: number | null
      duration_ms: number
    }
  }
  "match.shown": { subject: "match"; properties: MatchInteraction & { score: number } }
  "match.clicked": { subject: "match"; properties: MatchInteraction }
  "match.saved": { subject: "match"; properties: MatchInteraction }
  "match.dismissed": { subject: "match"; properties: MatchInteraction }

  // Proposals
  "proposal.sent": {
    subject: "proposal"
    properties: ProposalTerms & {
      to_user_id: string
      target: "idea" | "product"
      target_id: string
      /** The match the proposal came from, if any (links matching to outcomes). */
      match_id: string | null
    }
  }
  "proposal.countered": { subject: "proposal"; properties: ProposalTerms }
  "proposal.accepted": { subject: "proposal"; properties: ProposalTerms & { collab_id: string } }
  "proposal.declined": { subject: "proposal"; properties: { revision_number: number } }
  "proposal.expired": { subject: "proposal"; properties: { revision_number: number } }
  /** Not in the §11 list; the `withdrawn` status needs an event like every other transition. */
  "proposal.withdrawn": { subject: "proposal"; properties: { revision_number: number } }

  // Collabs & agreements
  "collab.created": {
    subject: "collab"
    properties: { proposal_id: string; idea_id: string | null; product_id: string | null }
  }
  "collab.stage_changed": { subject: "collab"; properties: { from: CollabStage; to: CollabStage } }
  "collab.ended": { subject: "collab"; properties: { from_stage: CollabStage } }
  "agreement.generated": {
    subject: "agreement"
    properties: { collab_id: string; template_version: string }
  }
  /** One per party. */
  "agreement.signed": { subject: "agreement"; properties: { collab_id: string; role: CollabRole } }
  "agreement.completed": {
    subject: "agreement"
    properties: { collab_id: string; template_version: string }
  }
  "task.completed": { subject: "task"; properties: { collab_id: string; on_time: boolean | null } }
  /** Counts only, never the body (§11). */
  "message.sent": {
    subject: "thread"
    properties: { thread_kind: ThreadKind; attachment_count: number }
  }

  // Launch
  "launch.submitted": {
    subject: "launch"
    properties: {
      collab_id: string
      price_cents: number
      currency: string
      delivery_type: DeliveryType
    }
  }
  /** One per party (and the admin review). */
  "launch.approved": {
    subject: "launch"
    properties: { collab_id: string; role: CollabRole | "admin" }
  }
  "launch.live": {
    subject: "launch"
    properties: { collab_id: string; price_cents: number; currency: string; auto_approved: boolean }
  }
  "launch.paused": { subject: "launch"; properties: { collab_id: string; by: LaunchPausedBy } }

  // Attribution & commerce (§10)
  "link.clicked": { subject: "tracked_link"; properties: { launch_id: string; is_bot: boolean } }
  "product_page.viewed": { subject: "launch"; properties: { tracked_link_id: string | null } }
  "checkout.started": {
    subject: "launch"
    properties: { tracked_link_id: string | null; price_cents: number; currency: string }
  }
  "order.paid": {
    subject: "order"
    properties: {
      launch_id: string
      tracked_link_id: string | null
      amount_gross_cents: number
      tax_cents: number
      stripe_fee_cents: number
      currency: string
    }
  }
  "order.refunded": {
    subject: "order"
    properties: {
      launch_id: string
      refund_id: string
      amount_cents: number
      currency: string
      full: boolean
    }
  }
  "order.disputed": { subject: "order"; properties: { launch_id: string } }

  // Money & trust
  "payout.sent": {
    subject: "transfer"
    properties: { amount_cents: number; currency: string; entry_count: number }
  }
  "dispute.opened": { subject: "dispute"; properties: { collab_id: string; kind: DisputeKind } }
  "dispute.resolved": { subject: "dispute"; properties: { collab_id: string; kind: DisputeKind } }

  // AI (§7.3)
  "ai.generated": {
    subject: "user" | "creator_profile" | "idea" | "match" | "launch"
    properties: {
      use: AiUse
      prompt_version: string
      model: string
      latency_ms: number
      /** Unknown (null) when generated; a later event or edit records the user's decision. */
      accepted_by_user: boolean | null
      /** True when the LLM output failed validation and the empty fallback was used. */
      fallback: boolean
    }
  }
}

export type EventType = keyof EventCatalog
export type EventSubjectType<T extends EventType> = EventCatalog[T]["subject"]
export type EventProperties<T extends EventType> = EventCatalog[T]["properties"]

/** Every event type, for validation, admin filters and exhaustiveness checks. */
export const EVENT_TYPES = [
  "user.signed_up",
  "user.role_added",
  "onboarding.completed",
  "social.connected",
  "social.synced",
  "social.expired",
  "idea.created",
  "idea.published",
  "idea.archived",
  "product.created",
  "product.published",
  "product.archived",
  "match.computed",
  "match.shown",
  "match.clicked",
  "match.saved",
  "match.dismissed",
  "proposal.sent",
  "proposal.countered",
  "proposal.accepted",
  "proposal.declined",
  "proposal.expired",
  "proposal.withdrawn",
  "collab.created",
  "collab.stage_changed",
  "collab.ended",
  "agreement.generated",
  "agreement.signed",
  "agreement.completed",
  "task.completed",
  "message.sent",
  "launch.submitted",
  "launch.approved",
  "launch.live",
  "launch.paused",
  "link.clicked",
  "product_page.viewed",
  "checkout.started",
  "order.paid",
  "order.refunded",
  "order.disputed",
  "payout.sent",
  "dispute.opened",
  "dispute.resolved",
  "ai.generated",
] as const satisfies readonly EventType[]

// Compile-time check that EVENT_TYPES lists every catalog entry.
type MissingEventTypes = Exclude<EventType, (typeof EVENT_TYPES)[number]>
const _allEventTypesListed: [MissingEventTypes] extends [never] ? true : MissingEventTypes = true

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value)
}

export function isSubjectType(value: string): value is SubjectType {
  return (SUBJECT_TYPES as readonly string[]).includes(value)
}

/** What `track()` takes for event type `T`. */
export type TrackInput<T extends EventType> = {
  /** The user who caused the event; null for system jobs, webhooks and anonymous buyers. */
  actorUserId?: string | null
  subjectType: EventSubjectType<T>
  subjectId: string
  properties: EventProperties<T>
  context?: EventContext
  /** Defaults to `now()` from lib/clock.ts. */
  occurredAt?: Date
}

/** One element of a `trackMany()` batch: a `TrackInput` tagged with its type. */
export type AnyTrackEvent = { [T in EventType]: { type: T } & TrackInput<T> }[EventType]
