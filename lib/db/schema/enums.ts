import { pgEnum } from "drizzle-orm/pg-core"

/**
 * Postgres enums for every enumerated status/kind in CLAUDE.md §5.
 * Each enum exposes its values as `xEnum.enumValues`; the matching TS union is exported next to it,
 * so app code and Zod schemas can share the exact set (e.g. `z.enum(ideaStatusEnum.enumValues)`).
 */

// Identity & profiles
/** Values allowed in `users.roles` (a text[] per §5) and `users.active_role`. */
export const userRoleEnum = pgEnum("user_role", ["creator", "builder", "admin"])
export type UserRole = (typeof userRoleEnum.enumValues)[number]

export const userStatusEnum = pgEnum("user_status", ["active", "suspended"])
export type UserStatus = (typeof userStatusEnum.enumValues)[number]

/** nano <10k, micro 10k–100k, mid 100k–500k, macro >500k followers (computed). */
export const sizeTierEnum = pgEnum("size_tier", ["nano", "micro", "mid", "macro"])
export type SizeTier = (typeof sizeTierEnum.enumValues)[number]

export const availabilityEnum = pgEnum("builder_availability", ["open", "limited", "closed"])
export type Availability = (typeof availabilityEnum.enumValues)[number]

export const dealPreferenceEnum = pgEnum("deal_preference", ["split", "fixed", "either"])
export type DealPreference = (typeof dealPreferenceEnum.enumValues)[number]

// Social data
export const socialProviderEnum = pgEnum("social_provider", [
  "youtube",
  "instagram",
  "tiktok",
  "github",
])
export type SocialProvider = (typeof socialProviderEnum.enumValues)[number]

export const socialConnectionStatusEnum = pgEnum("social_connection_status", [
  "active",
  "expired",
  "revoked",
])
export type SocialConnectionStatus = (typeof socialConnectionStatusEnum.enumValues)[number]

/** `manual` = follower count + screenshot fallback while a provider's API is not approved (§7.1). */
export const socialConnectionSourceEnum = pgEnum("social_connection_source", ["oauth", "manual"])
export type SocialConnectionSource = (typeof socialConnectionSourceEnum.enumValues)[number]

/**
 * What audience shares are fractions of: YouTube reports viewers, Instagram followers. The numbers
 * mean different things, so snapshots keep the basis (docs/integrations/social-providers.md).
 */
export const audienceBasisEnum = pgEnum("audience_basis", ["viewers", "followers"])
export type AudienceBasis = (typeof audienceBasisEnum.enumValues)[number]

// Supply & demand
/** Shared by ideas.format, products.format and portfolio_items.format. */
export const productFormatEnum = pgEnum("product_format", [
  "app",
  "tool",
  "template",
  "ai_utility",
  "course_tool",
  "other",
])
export type ProductFormat = (typeof productFormatEnum.enumValues)[number]

export const ideaStatusEnum = pgEnum("idea_status", [
  "draft",
  "open",
  "in_collab",
  "launched",
  "archived",
])
export type IdeaStatus = (typeof ideaStatusEnum.enumValues)[number]

export const productStageEnum = pgEnum("product_stage", ["idea", "prototype", "beta", "live"])
export type ProductStage = (typeof productStageEnum.enumValues)[number]

export const productStatusEnum = pgEnum("product_status", [
  "draft",
  "seeking",
  "in_collab",
  "launched",
  "archived",
])
export type ProductStatus = (typeof productStatusEnum.enumValues)[number]

// Matching
/** Shared by matches.target_type and saved_items.target_type. */
export const targetTypeEnum = pgEnum("target_type", ["creator", "builder", "idea", "product"])
export type TargetType = (typeof targetTypeEnum.enumValues)[number]

export const matchStatusEnum = pgEnum("match_status", ["shown", "saved", "dismissed", "proposed"])
export type MatchStatus = (typeof matchStatusEnum.enumValues)[number]

// Collaboration
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "countered",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
])
export type ProposalStatus = (typeof proposalStatusEnum.enumValues)[number]

export const collabStageEnum = pgEnum("collab_stage", [
  "agreement",
  "building",
  "launch_review",
  "live",
  "ended",
])
export type CollabStage = (typeof collabStageEnum.enumValues)[number]

/**
 * Why a collab ended (§5 `collabs.ended_reason`; values decided in CLAUDE.md §19.24): `completed`
 * (ran its course after launch), `cancelled` (a member left before launch, the agreement's exit
 * terms), `dispute` (ended by a resolved dispute), `admin` (ended by an admin). Matching's
 * `reliability` counts `completed` up and `dispute` down.
 */
export const collabEndReasonEnum = pgEnum("collab_end_reason", [
  "completed",
  "cancelled",
  "dispute",
  "admin",
])
export type CollabEndReason = (typeof collabEndReasonEnum.enumValues)[number]

export const collabRoleEnum = pgEnum("collab_role", ["creator", "builder"])
export type CollabRole = (typeof collabRoleEnum.enumValues)[number]

export const agreementStatusEnum = pgEnum("agreement_status", [
  "awaiting_signatures",
  "signed",
  "terminated",
])
export type AgreementStatus = (typeof agreementStatusEnum.enumValues)[number]

export const threadKindEnum = pgEnum("thread_kind", ["proposal", "collab"])
export type ThreadKind = (typeof threadKindEnum.enumValues)[number]

// Launch & commerce
export const deliveryTypeEnum = pgEnum("delivery_type", ["file", "license_key", "url"])
export type DeliveryType = (typeof deliveryTypeEnum.enumValues)[number]

export const launchStatusEnum = pgEnum("launch_status", [
  "draft",
  "pending_approval",
  "admin_review",
  "live",
  "paused",
  "ended",
])
export type LaunchStatus = (typeof launchStatusEnum.enumValues)[number]

export const orderStatusEnum = pgEnum("order_status", [
  "paid",
  "refunded",
  "partially_refunded",
  "disputed",
])
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number]

/**
 * Who paused a live launch (CLAUDE.md §19.31): a member (either member may resume), an admin or a
 * chargeback/dispute (only an admin resumes).
 */
export const launchPausedByEnum = pgEnum("launch_paused_by", ["member", "admin", "dispute"])
export type LaunchPausedBy = (typeof launchPausedByEnum.enumValues)[number]

/** How an order was attributed to a tracked link (§10; CLAUDE.md §19.31). */
export const orderAttributionEnum = pgEnum("order_attribution", ["cookie", "ref", "discount_code"])
export type OrderAttribution = (typeof orderAttributionEnum.enumValues)[number]

/** Stripe's `Refund.status` (§9 refunds; CLAUDE.md §19.31). Unknown future values map to `pending`. */
export const refundStatusEnum = pgEnum("refund_status", [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
])
export type RefundStatus = (typeof refundStatusEnum.enumValues)[number]

/**
 * A chargeback (Stripe `Dispute`, §9) as the ledger sees it: `open` while Stripe's status is any
 * `needs_response` / `under_review` / `warning_*` value, then `won` or `lost`
 * (`chargebacks.stripe_status` keeps Stripe's own value).
 */
export const chargebackStatusEnum = pgEnum("chargeback_status", ["open", "won", "lost"])
export type ChargebackStatus = (typeof chargebackStatusEnum.enumValues)[number]

// Money
export const ledgerAccountEnum = pgEnum("ledger_account", [
  "creator_share",
  "builder_share",
  "platform_fee",
  "stripe_fee",
  "tax",
  "adjustment",
])
export type LedgerAccount = (typeof ledgerAccountEnum.enumValues)[number]

/**
 * Status of a Stripe capability on a connected account (§19.10: payouts-ready needs `transfers`
 * to be `active`). `Account.capabilities.transfers` reports active | inactive | pending; a
 * capability that was never requested is absent there and `unrequested` on the Capability object.
 */
export const stripeCapabilityStatusEnum = pgEnum("stripe_capability_status", [
  "active",
  "inactive",
  "pending",
  "unrequested",
])
export type StripeCapabilityStatus = (typeof stripeCapabilityStatusEnum.enumValues)[number]

/**
 * §5 leaves transfers.status open. `pending` is written before the Stripe call (the row id is the
 * idempotency key), `created` once Stripe returns the transfer; reversals update the status.
 */
export const transferStatusEnum = pgEnum("transfer_status", [
  "pending",
  "created",
  "failed",
  "reversed",
  "partially_reversed",
])
export type TransferStatus = (typeof transferStatusEnum.enumValues)[number]

/** One run of the daily payout job (§9; CLAUDE.md §19.31). */
export const payoutBatchStatusEnum = pgEnum("payout_batch_status", [
  "running",
  "completed",
  "failed",
])
export type PayoutBatchStatus = (typeof payoutBatchStatusEnum.enumValues)[number]

/** A transfer reversal after a refund or lost chargeback of already transferred money (§9). */
export const transferReversalStatusEnum = pgEnum("transfer_reversal_status", [
  "pending",
  "succeeded",
  "failed",
])
export type TransferReversalStatus = (typeof transferReversalStatusEnum.enumValues)[number]

// Trust & ops
export const disputeKindEnum = pgEnum("dispute_kind", ["split", "non_delivery", "exit", "other"])
export type DisputeKind = (typeof disputeKindEnum.enumValues)[number]

export const disputeStatusEnum = pgEnum("dispute_status", ["open", "in_review", "resolved"])
export type DisputeStatus = (typeof disputeStatusEnum.enumValues)[number]

/**
 * How an admin settled a collab dispute (CLAUDE.md §19.38): `no_action` (closed without changes),
 * `adjusted` (an audited ledger adjustment moved money), `collab_ended` (the collab was ended,
 * reason `dispute`), `other` (see the resolution note).
 */
export const disputeOutcomeEnum = pgEnum("dispute_outcome", [
  "no_action",
  "adjusted",
  "collab_ended",
  "other",
])
export type DisputeOutcome = (typeof disputeOutcomeEnum.enumValues)[number]

// Phase 7 (v1): buyer refund requests at /access/[token]/refund (CLAUDE.md §19.38)
export const refundRequestStatusEnum = pgEnum("refund_request_status", [
  "pending",
  "approved",
  "declined",
])
export type RefundRequestStatus = (typeof refundRequestStatusEnum.enumValues)[number]

/** Why the buyer asks for their money back (a choice on the form; the free text is optional). */
export const refundRequestReasonEnum = pgEnum("refund_request_reason", [
  "not_as_described",
  "not_working",
  "not_received",
  "accidental",
  "other",
])
export type RefundRequestReason = (typeof refundRequestReasonEnum.enumValues)[number]

/**
 * How a `matching_config` row scores (§8; CLAUDE.md §19.38): `weighted` = Σ weight × feature (v0),
 * `logistic` = the v1 model in `matching_config.model` (Phase 7).
 */
export const matchingModelKindEnum = pgEnum("matching_model_kind", ["weighted", "logistic"])
export type MatchingModelKind = (typeof matchingModelKindEnum.enumValues)[number]
