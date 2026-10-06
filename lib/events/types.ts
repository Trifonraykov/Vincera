import type {
  Availability,
  CollabEndReason,
  CollabRole,
  CollabStage,
  DealPreference,
  DeliveryType,
  DisputeKind,
  DisputeOutcome,
  EventContext,
  IdeaStatus,
  LaunchPausedBy,
  ProductFormat,
  ProductStage,
  ProductStatus,
  RefundRequestReason,
  SizeTier,
  SocialConnectionSource,
  SocialProvider,
  StripeCapabilityStatus,
  TargetType,
  ThreadKind,
  UserRole,
} from "@/lib/db/schema"
import type { OnboardingStepId, OnboardingStepStatus } from "@/lib/onboarding/steps"

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
  "stripe_account",
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
  "refund",
  "chargeback",
  "transfer",
  "payout_batch",
  "dispute",
  // Phases 6–7 (CLAUDE.md §19.38)
  "refund_request",
  "ledger_adjustment",
  "matching_config",
] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

/** How a user signed up or in (Auth.js providers, §6). */
export type AuthMethod = "email" | "google" | "github"

/**
 * How a role was added: chosen during onboarding, granted on sign-up because the email is in
 * ADMIN_EMAILS, granted by an operator with `pnpm admin:grant`, or by an admin in /admin/users
 * (Phase 6).
 */
export type RoleSource = "onboarding" | "admin_emails" | "admin_cli" | "admin"

/** What triggered a matching recompute (§8, §13). */
export type MatchTrigger = "nightly" | "on_change" | "manual"

/** Claude API uses (§7.3). */
export type AiUse =
  "audience_summary" | "idea_brief" | "match_explanation" | "launch_kit" | "listing_hook"

/** Where an imported listing came from (CLAUDE.md §19.45). */
export type ListingSource = "app_store" | "web"

/** Where a creator met a listing (CLAUDE.md §19.45). */
export type ListingSurface = "feed" | "profile"

/** Why a social connection stopped working (§7.1). */
export type SocialExpiryReason = "refresh_failed" | "unauthorized" | "revoked"

/** Where a profile was edited. */
export type ProfileEditSource = "onboarding" | "settings"

/** Who paused a launch. */
export type { LaunchPausedBy }

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
  /** Not in the §11 list (Phase 6): an admin removed a role (only `admin` can be removed). */
  "user.role_removed": { subject: "user"; properties: { role: UserRole } }
  /** Not in the §11 list (Phase 6): an admin suspended the account (its sessions are deleted). */
  "user.suspended": { subject: "user"; properties: NoProperties }
  /** Not in the §11 list (Phase 6): an admin lifted a suspension. */
  "user.unsuspended": { subject: "user"; properties: NoProperties }
  /** Not in the §11 list (§14 GDPR): the user downloaded their data export. */
  "user.data_exported": { subject: "user"; properties: { format: "json" } }
  /** Not in the §11 list (§14 GDPR): the account was deleted and anonymised at the user's request. */
  "user.deleted": { subject: "user"; properties: { roles: UserRole[] } }
  /** A step recorded done or skipped ("Do this later"); Phase 1 funnel. Not in the §11 list. */
  "onboarding.step_completed": {
    subject: "user"
    properties: { step: OnboardingStepId; status: OnboardingStepStatus }
  }
  /** Once per user, when the path is first complete (§19.11). */
  "onboarding.completed": {
    subject: "user"
    properties: { roles: CollabRole[]; skipped_steps: OnboardingStepId[] }
  }

  // Profiles (not in the §11 list: profile changes feed embeddings and matching)
  "creator_profile.created": {
    subject: "creator_profile"
    properties: { country: string | null; topic_count: number; language_count: number }
  }
  /** `fields`: names of the changed columns, never their values. */
  "creator_profile.updated": {
    subject: "creator_profile"
    properties: { fields: string[]; source: ProfileEditSource }
  }
  "builder_profile.created": {
    subject: "builder_profile"
    properties: {
      skill_count: number
      stack_count: number
      availability: Availability
      deal_preference: DealPreference
    }
  }
  "builder_profile.updated": {
    subject: "builder_profile"
    properties: { fields: string[]; source: ProfileEditSource }
  }

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
  /** Not in the §11 list. The connection, its tokens and snapshots are deleted (§14). */
  "social.disconnected": {
    subject: "social_connection"
    properties: { provider: SocialProvider; source: SocialConnectionSource }
  }

  // Payouts onboarding (Stripe Connect, §7.2; not in the §11 list)
  "payouts.account_created": { subject: "stripe_account"; properties: { country: string | null } }
  /** When a synced field changed (from `account.updated` / `capability.updated`). */
  "payouts.account_updated": {
    subject: "stripe_account"
    properties: {
      charges_enabled: boolean
      payouts_enabled: boolean
      details_submitted: boolean
      transfers_capability: StripeCapabilityStatus
      /** Payouts-ready (lib/payouts/readiness.ts) after the change. */
      ready: boolean
      requirements_due_count: number
    }
  }

  // Supply & demand
  "idea.created": {
    subject: "idea"
    properties: { format: ProductFormat; topics: string[]; target_price_cents: number | null }
  }
  /** Not in the §11 list (like profile updates): edits feed embeddings and matching. */
  "idea.updated": { subject: "idea"; properties: { fields: string[] } }
  "idea.published": { subject: "idea"; properties: NoProperties }
  "idea.archived": { subject: "idea"; properties: { from_status: IdeaStatus } }
  /** Not in the §11 list: archived → draft (§19.24). */
  "idea.restored": { subject: "idea"; properties: NoProperties }
  "product.created": {
    subject: "product"
    properties: {
      format: ProductFormat
      stage: ProductStage
      topics: string[]
      target_price_cents: number | null
    }
  }
  /** Not in the §11 list (like profile updates): edits feed embeddings and matching. */
  "product.updated": { subject: "product"; properties: { fields: string[] } }
  "product.published": { subject: "product"; properties: NoProperties }
  "product.archived": { subject: "product"; properties: { from_status: ProductStatus } }
  /** Not in the §11 list: archived → draft (§19.24). */
  "product.restored": { subject: "product"; properties: NoProperties }

  // Imported listings and the creator feed (CLAUDE.md §19.45)
  /** One listing written by an App Store or web import (next to product.created / .updated). */
  "product.imported": {
    subject: "product"
    properties: {
      source: ListingSource
      action: "created" | "updated" | "removed" | "restored"
      image_count: number
    }
  }
  "app_store.connected": {
    subject: "builder_profile"
    properties: { via: "developer_link" | "app_link" | "id"; app_count: number }
  }
  "app_store.verified": {
    subject: "builder_profile"
    properties: { method: "description_code" | "admin" }
  }
  "app_store.disconnected": { subject: "builder_profile"; properties: NoProperties }
  "app_store.synced": {
    subject: "builder_profile"
    properties: {
      trigger: "connected" | "manual" | "scheduled"
      created: number
      updated: number
      removed: number
    }
  }
  /** One feed page rendered for a creator (match rows on it also get match.shown). */
  "feed.viewed": {
    subject: "user"
    properties: { items: number; matched: number; page: number }
  }
  /** A listing opened from the feed or a profile (matched ones also get match.clicked). */
  "listing.opened": {
    subject: "product"
    properties: { surface: ListingSurface; rank: number | null; matched: boolean }
  }
  /** Saved without a match row (with one, match.saved is written instead). */
  "listing.saved": {
    subject: "product"
    properties: { surface: ListingSurface; rank: number | null }
  }
  "listing.unsaved": {
    subject: "product"
    properties: { surface: ListingSurface; rank: number | null }
  }

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
  /** Not in the §11 list: the saved state can be undone (§19.24). */
  "match.unsaved": { subject: "match"; properties: MatchInteraction }
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
  "collab.ended": {
    subject: "collab"
    properties: { from_stage: CollabStage; reason: CollabEndReason }
  }
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
  /** Not in the §11 list: task activity counts toward a collab's `last_activity_at` (§19.24). */
  "task.created": { subject: "task"; properties: { collab_id: string; assigned: boolean } }
  "task.completed": { subject: "task"; properties: { collab_id: string; on_time: boolean | null } }
  /** Not in the §11 list: a done task ticked back to open. */
  "task.reopened": { subject: "task"; properties: { collab_id: string } }
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
  /** Not in the §11 list (CLAUDE.md §19.31): a draft launch created for a collab in `building`. */
  "launch.created": { subject: "launch"; properties: { collab_id: string } }
  /** Not in the §11 list: a member saved the launch setup; `fields` are column names only. */
  "launch.updated": {
    subject: "launch"
    properties: { collab_id: string; fields: string[]; approvals_reset: boolean }
  }
  /** Not in the §11 list: an admin sent the launch back to draft from `admin_review`. */
  "launch.rejected": { subject: "launch"; properties: { collab_id: string } }
  /** Not in the §11 list: a paused launch is live again. */
  "launch.resumed": { subject: "launch"; properties: { collab_id: string; by: "member" | "admin" } }
  /** Not in the §11 list: sales stopped for good (buyers keep their access). */
  "launch.ended": {
    subject: "launch"
    properties: { collab_id: string; by: "admin" | "collab_ended" }
  }
  /** Not in the §11 list: a tracked link (the creator's default one when the launch goes live). */
  "tracked_link.created": {
    subject: "tracked_link"
    properties: { launch_id: string; is_default: boolean; has_discount: boolean }
  }
  /** Not in the §11 list: a link stops attributing (and its promotion code is deactivated). */
  "tracked_link.disabled": { subject: "tracked_link"; properties: { launch_id: string } }
  /** Not in the §11 list (Phase 7 links page): the owner renamed a link; `fields` are names only. */
  "tracked_link.updated": {
    subject: "tracked_link"
    properties: { launch_id: string; fields: string[] }
  }

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
  /**
   * Not in the §11 list (CLAUDE.md §19.31): the sale's ledger entries were written once the Stripe
   * fee was known (`postOrderLedger`). `order.paid` may come earlier with `stripe_fee_cents: 0`.
   */
  "order.ledger_posted": {
    subject: "order"
    properties: {
      launch_id: string
      stripe_fee_cents: number
      platform_fee_cents: number
      currency: string
      entry_count: number
    }
  }
  /** Not in the §11 list: the buyer opened /access/[token] (no actor: buyers have no account). */
  "access.opened": {
    subject: "order"
    properties: { launch_id: string; delivery_type: DeliveryType }
  }
  /** Not in the §11 list: a refund row was created (by the app, or from a Stripe dashboard refund). */
  "refund.created": {
    subject: "refund"
    properties: {
      order_id: string
      amount_cents: number
      currency: string
      source: "app" | "stripe"
    }
  }
  /** Not in the §11 list: Stripe reported the refund failed or canceled (`order.refunded` never came). */
  "refund.failed": {
    subject: "refund"
    properties: { order_id: string; amount_cents: number; currency: string }
  }
  /** Not in the §11 list: a chargeback closed; `lost` writes the mirror entries. */
  /** Not in the §11 list (Phase 7): a buyer asked for a refund at /access/[token]/refund. */
  "refund_request.created": {
    subject: "refund_request"
    properties: {
      order_id: string
      launch_id: string
      reason: RefundRequestReason
      amount_cents: number
      currency: string
      /** Days between payment and the request (whole days, rounded down). */
      days_after_purchase: number
    }
  }
  /** Not in the §11 list: an admin approved it; `refund_id` is the refund it started. */
  "refund_request.approved": {
    subject: "refund_request"
    properties: { order_id: string; refund_id: string }
  }
  /** Not in the §11 list: an admin declined it. */
  "refund_request.declined": { subject: "refund_request"; properties: { order_id: string } }
  "chargeback.closed": {
    subject: "chargeback"
    properties: {
      order_id: string
      outcome: "won" | "lost"
      amount_cents: number
      currency: string
    }
  }

  // Money & trust
  "payout.sent": {
    subject: "transfer"
    properties: { amount_cents: number; currency: string; entry_count: number }
  }
  /** Not in the §11 list: Stripe refused the transfer; its entries are released for a later batch. */
  "payout.failed": {
    subject: "transfer"
    properties: { amount_cents: number; currency: string; failure_code: string }
  }
  /** Not in the §11 list: money already paid out was pulled back after a refund or chargeback. */
  "payout.reversed": {
    subject: "transfer"
    properties: {
      amount_cents: number
      currency: string
      cause: "refund" | "chargeback"
      /** False when Stripe refused it: the negative entries stay and are netted later (§19.10). */
      succeeded: boolean
    }
  }
  /** Not in the §11 list: one run of the daily payout job finished. */
  "payout.batch_completed": {
    subject: "payout_batch"
    properties: { transfer_count: number; total_cents: number; failed_count: number }
  }
  "dispute.opened": { subject: "dispute"; properties: { collab_id: string; kind: DisputeKind } }
  /** Not in the §11 list (Phase 6): an admin started looking into it. */
  "dispute.in_review": { subject: "dispute"; properties: { collab_id: string; kind: DisputeKind } }
  "dispute.resolved": {
    subject: "dispute"
    properties: { collab_id: string; kind: DisputeKind; outcome: DisputeOutcome }
  }
  /**
   * Not in the §11 list (Phase 6): an admin's ledger adjustment. Its entries sum to zero; the
   * properties describe the money moved to (or from) members, never the reason text.
   */
  "ledger.adjusted": {
    subject: "ledger_adjustment"
    properties: {
      dispute_id: string | null
      order_id: string | null
      entry_count: number
      /** Σ of the positive entries (what moved), integer cents. */
      amount_cents: number
      currency: string
    }
  }

  // Matching v1 (§8, Phase 7)
  /** Not in the §11 list: `pnpm matching:train` (or the admin page) stored a new model row. */
  "matching.model_trained": {
    subject: "matching_config"
    properties: {
      model_version: string
      training_rows: number
      holdout_rows: number
      positives_accepted: number
      positives_sale: number
    }
  }
  /** Not in the §11 list: an admin made this model version the one that ranks (audited too). */
  "matching.model_activated": {
    subject: "matching_config"
    properties: { model_version: string; previous_version: string | null; forced: boolean }
  }

  // AI (§7.3)
  "ai.generated": {
    subject: "user" | "creator_profile" | "idea" | "match" | "launch" | "product"
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
  /**
   * The user's decision on generated text, e.g. the creator confirming or editing the audience
   * summary on /onboarding/creator/review (records what `ai.generated.accepted_by_user` cannot).
   */
  "ai.reviewed": {
    subject: "user" | "creator_profile" | "idea" | "match" | "launch" | "product"
    properties: { use: AiUse; prompt_version: string; accepted: boolean; edited: boolean }
  }
}

export type EventType = keyof EventCatalog
export type EventSubjectType<T extends EventType> = EventCatalog[T]["subject"]
export type EventProperties<T extends EventType> = EventCatalog[T]["properties"]

/** Every event type, for validation, admin filters and exhaustiveness checks. */
export const EVENT_TYPES = [
  "user.signed_up",
  "user.role_added",
  "user.role_removed",
  "user.suspended",
  "user.unsuspended",
  "user.data_exported",
  "user.deleted",
  "onboarding.step_completed",
  "onboarding.completed",
  "creator_profile.created",
  "creator_profile.updated",
  "builder_profile.created",
  "builder_profile.updated",
  "social.connected",
  "social.synced",
  "social.expired",
  "social.disconnected",
  "payouts.account_created",
  "payouts.account_updated",
  "idea.created",
  "idea.updated",
  "idea.published",
  "idea.archived",
  "idea.restored",
  "product.created",
  "product.updated",
  "product.published",
  "product.archived",
  "product.restored",
  "product.imported",
  "app_store.connected",
  "app_store.verified",
  "app_store.disconnected",
  "app_store.synced",
  "feed.viewed",
  "listing.opened",
  "listing.saved",
  "listing.unsaved",
  "match.computed",
  "match.shown",
  "match.clicked",
  "match.saved",
  "match.unsaved",
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
  "task.created",
  "task.completed",
  "task.reopened",
  "message.sent",
  "launch.submitted",
  "launch.approved",
  "launch.live",
  "launch.paused",
  "launch.created",
  "launch.updated",
  "launch.rejected",
  "launch.resumed",
  "launch.ended",
  "tracked_link.created",
  "tracked_link.disabled",
  "tracked_link.updated",
  "link.clicked",
  "product_page.viewed",
  "checkout.started",
  "order.paid",
  "order.refunded",
  "order.disputed",
  "order.ledger_posted",
  "access.opened",
  "refund.created",
  "refund.failed",
  "refund_request.created",
  "refund_request.approved",
  "refund_request.declined",
  "chargeback.closed",
  "payout.sent",
  "payout.failed",
  "payout.reversed",
  "payout.batch_completed",
  "dispute.opened",
  "dispute.in_review",
  "dispute.resolved",
  "ledger.adjusted",
  "matching.model_trained",
  "matching.model_activated",
  "ai.generated",
  "ai.reviewed",
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
