import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import {
  createdAt,
  currency,
  currencyFormatCheck,
  id,
  nonBlankCheck,
  timestamps,
  timestamptz,
  withRLS,
} from "./columns"
import {
  chargebackStatusEnum,
  deliveryTypeEnum,
  launchPausedByEnum,
  launchStatusEnum,
  orderAttributionEnum,
  orderStatusEnum,
  refundRequestReasonEnum,
  refundRequestStatusEnum,
  refundStatusEnum,
} from "./enums"
import { collabs } from "./collab"
import { users } from "./identity"
import type { DeliveryConfig, LaunchApproval, LaunchMedia } from "./types"

/**
 * Launch & commerce (§5, §10). Orders and everything that money or attribution hangs off are
 * never cascaded (RESTRICT); a launch's files and unassigned keys cascade with it.
 */

export const launches = withRLS(
  pgTable(
    "launches",
    {
      id: id(),
      collabId: uuid("collab_id")
        .notNull()
        .unique()
        .references(() => collabs.id, { onDelete: "restrict" }),
      slug: text("slug").notNull().unique(),
      title: text("title").notNull(),
      tagline: text("tagline"),
      descriptionMd: text("description_md"),
      priceCents: integer("price_cents"),
      currency: currency(),
      media: jsonb("media")
        .$type<LaunchMedia[]>()
        .notNull()
        .default(sql`'[]'::jsonb`),
      deliveryType: deliveryTypeEnum("delivery_type"),
      deliveryConfig: jsonb("delivery_config").$type<DeliveryConfig>(),
      status: launchStatusEnum("status").notNull().default("draft"),
      /**
       * Stripe Tax product tax code (`txcd_` + 8 digits) sent with `price_data` (§7.2, §19.10);
       * null = the default for the delivery type (CLAUDE.md §19.31).
       */
      taxCode: text("tax_code"),
      /** Approvals of the current version; saving the launch resets it (§12). */
      approvedBy: jsonb("approved_by")
        .$type<LaunchApproval[]>()
        .notNull()
        .default(sql`'[]'::jsonb`),
      /** First member approval of the current version (draft → pending_approval). */
      submittedAt: timestamptz("submitted_at"),
      /** The admin who last approved or sent back the launch in `admin_review`. */
      reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
        onDelete: "restrict",
      }),
      reviewedAt: timestamptz("reviewed_at"),
      /** Shown to the members when an admin sends the launch back to draft. */
      reviewNote: text("review_note"),
      /** First time the launch went live; kept across pauses (the slug is fixed from then on). */
      wentLiveAt: timestamptz("went_live_at"),
      /** Set exactly while `paused`. */
      pausedAt: timestamptz("paused_at"),
      pausedBy: launchPausedByEnum("paused_by"),
      /** Set exactly when `ended`. */
      endedAt: timestamptz("ended_at"),
      ...timestamps(),
    },
    (t) => [
      index("launches_status_idx").on(t.status),
      index("launches_reviewed_by_user_id_idx").on(t.reviewedByUserId),
      // The public /launches directory (Phase 7): live launches, newest first.
      index("launches_live_directory_idx")
        .on(t.wentLiveAt.desc())
        .where(sql`${t.status} = 'live'`),
      check("launches_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
      check("launches_slug_length", sql`char_length(${t.slug}) BETWEEN 3 AND 80`),
      check("launches_title_not_blank", nonBlankCheck(t.title)),
      check("launches_currency_format", currencyFormatCheck(t.currency)),
      // Stripe's minimum charge in EUR is 0.50; 10,000.00 is the platform's ceiling.
      check(
        "launches_price_range",
        sql`${t.priceCents} IS NULL OR ${t.priceCents} BETWEEN 50 AND 1000000`,
      ),
      check(
        "launches_tax_code_format",
        sql`${t.taxCode} IS NULL OR ${t.taxCode} ~ '^txcd_[0-9]{8}$'`,
      ),
      check(
        "launches_delivery_config_matches_type",
        sql`${t.deliveryConfig} IS NULL OR ${t.deliveryConfig}->>'type' = ${t.deliveryType}::text`,
      ),
      check("launches_approved_by_array", sql`jsonb_typeof(${t.approvedBy}) = 'array'`),
      check("launches_media_array", sql`jsonb_typeof(${t.media}) = 'array'`),
      check(
        "launches_paused_iff_paused_at",
        sql`(${t.status} = 'paused') = (${t.pausedAt} IS NOT NULL AND ${t.pausedBy} IS NOT NULL)`,
      ),
      check(
        "launches_paused_by_only_when_paused",
        sql`${t.pausedBy} IS NULL OR ${t.pausedAt} IS NOT NULL`,
      ),
      check(
        "launches_ended_iff_ended_at",
        sql`(${t.status} = 'ended') = (${t.endedAt} IS NOT NULL)`,
      ),
      check(
        "launches_live_has_went_live_at",
        sql`${t.status} NOT IN ('live', 'paused') OR ${t.wentLiveAt} IS NOT NULL`,
      ),
      check(
        "launches_submitted_unless_draft",
        sql`${t.status} NOT IN ('pending_approval', 'admin_review') OR ${t.submittedAt} IS NOT NULL`,
      ),
      check(
        "launches_reviewed_pair",
        sql`(${t.reviewedByUserId} IS NULL) = (${t.reviewedAt} IS NULL)`,
      ),
      // Beyond draft, a launch must be sellable.
      check(
        "launches_complete_unless_draft",
        sql`${t.status} = 'draft' OR (${t.priceCents} IS NOT NULL AND ${t.deliveryType} IS NOT NULL)`,
      ),
    ],
  ),
)

export const launchFiles = withRLS(
  pgTable(
    "launch_files",
    {
      id: id(),
      launchId: uuid("launch_id")
        .notNull()
        .references(() => launches.id, { onDelete: "cascade" }),
      storageKey: text("storage_key").notNull().unique(),
      filename: text("filename").notNull(),
      sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
      /** MIME type, checked against the upload allow-list (§14). */
      contentType: text("content_type"),
      /** Display order on /access/[token]. */
      position: integer("position").notNull().default(0),
      ...timestamps(),
    },
    (t) => [
      index("launch_files_launch_id_idx").on(t.launchId),
      check("launch_files_size_nonnegative", sql`${t.sizeBytes} >= 0`),
      // 200 MB per deliverable (§14).
      check("launch_files_size_limit", sql`${t.sizeBytes} <= 209715200`),
      check("launch_files_filename_not_blank", nonBlankCheck(t.filename)),
      check("launch_files_position_nonnegative", sql`${t.position} >= 0`),
    ],
  ),
)

export const trackedLinks = withRLS(
  pgTable(
    "tracked_links",
    {
      id: id(),
      launchId: uuid("launch_id")
        .notNull()
        .references(() => launches.id, { onDelete: "restrict" }),
      ownerUserId: uuid("owner_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      /** 8 chars base62, used in /r/[code]. */
      code: text("code").notNull().unique(),
      label: text("label"),
      /**
       * The creator's default link, made when the launch first goes live (§12). At most one per
       * launch.
       */
      isDefault: boolean("is_default").notNull().default(false),
      /**
       * A Stripe promotion code tied to this link (§10): uppercase letters and digits, unique
       * platform-wide (Stripe promotion codes are unique per account). A checkout that uses it is
       * attributed to this link.
       */
      discountCode: text("discount_code").unique(),
      /** Percentage off for `discount_code` (1–100); set exactly when the code is. */
      discountPercentOff: integer("discount_percent_off"),
      /** Stripe's `promo_…` id once the promotion code exists at Stripe. */
      stripePromotionCodeId: text("stripe_promotion_code_id").unique(),
      /** A disabled link still redirects and keeps its history but stops attributing. */
      disabledAt: timestamptz("disabled_at"),
      ...timestamps(),
    },
    (t) => [
      index("tracked_links_launch_id_idx").on(t.launchId),
      index("tracked_links_owner_user_id_idx").on(t.ownerUserId),
      uniqueIndex("tracked_links_one_default_per_launch_idx")
        .on(t.launchId)
        .where(sql`${t.isDefault}`),
      check("tracked_links_code_format", sql`${t.code} ~ '^[0-9A-Za-z]{8}$'`),
      check(
        "tracked_links_discount_code_format",
        sql`${t.discountCode} IS NULL OR ${t.discountCode} ~ '^[A-Z0-9]{4,20}$'`,
      ),
      check(
        "tracked_links_discount_pair",
        sql`(${t.discountCode} IS NULL) = (${t.discountPercentOff} IS NULL)`,
      ),
      check(
        "tracked_links_discount_range",
        sql`${t.discountPercentOff} IS NULL OR ${t.discountPercentOff} BETWEEN 1 AND 100`,
      ),
      check(
        "tracked_links_promotion_needs_code",
        sql`${t.stripePromotionCodeId} IS NULL OR ${t.discountCode} IS NOT NULL`,
      ),
      check("tracked_links_label_length", sql`${t.label} IS NULL OR char_length(${t.label}) <= 80`),
    ],
  ),
)

/** Append-only (§5): one row per /r/[code] hit, never updated or deleted. */
export const linkClicks = withRLS(
  pgTable(
    "link_clicks",
    {
      id: id(),
      trackedLinkId: uuid("tracked_link_id")
        .notNull()
        .references(() => trackedLinks.id, { onDelete: "restrict" }),
      clickedAt: timestamptz("clicked_at").notNull(),
      referrer: text("referrer"),
      /** ISO 3166-1 alpha-2. */
      country: text("country"),
      uaHash: text("ua_hash"),
      /** Value of the visitor cookie. */
      visitorId: text("visitor_id"),
      /** Bot user agents are logged but flagged (§10). */
      isBot: boolean("is_bot").notNull().default(false),
      createdAt: createdAt(),
    },
    (t) => [index("link_clicks_tracked_link_clicked_at_idx").on(t.trackedLinkId, t.clickedAt)],
  ),
)

export const orders = withRLS(
  pgTable(
    "orders",
    {
      /**
       * The `order_ref` (§7.2): a UUIDv7 generated when the Checkout Session is created, sent as
       * `metadata.order_ref` and `client_reference_id`, and used as this row's id when the order is
       * created from `checkout.session.completed` (CLAUDE.md §19.31).
       */
      id: id(),
      launchId: uuid("launch_id")
        .notNull()
        .references(() => launches.id, { onDelete: "restrict" }),
      buyerEmail: text("buyer_email").notNull(),
      stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull().unique(),
      stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
      /** The PaymentIntent's charge (`ch_…`); `charge.updated` and refunds find the order by it. */
      stripeChargeId: text("stripe_charge_id").unique(),
      /** The charge's balance transaction (`txn_…`), whose `fee` is the real Stripe fee (§9). */
      stripeBalanceTransactionId: text("stripe_balance_transaction_id").unique(),
      /** What the buyer paid, tax included (`session.amount_total`). */
      amountGrossCents: integer("amount_gross_cents").notNull(),
      taxCents: integer("tax_cents").notNull().default(0),
      /** Discount from a promotion code (`total_details.amount_discount`). */
      discountCents: integer("discount_cents").notNull().default(0),
      /** 0 until the ledger is posted (the fee is only known from the balance transaction). */
      stripeFeeCents: integer("stripe_fee_cents").notNull().default(0),
      /** Sum of succeeded refunds and lost chargebacks (§9); drives the refunded statuses. */
      amountRefundedCents: integer("amount_refunded_cents").notNull().default(0),
      currency: currency(),
      /** ISO 3166-1 alpha-2 from Checkout's customer details (tax evidence), when known. */
      buyerCountry: text("buyer_country"),
      trackedLinkId: uuid("tracked_link_id").references(() => trackedLinks.id, {
        onDelete: "restrict",
      }),
      /** How `tracked_link_id` was decided; null when the order is not attributed. */
      attribution: orderAttributionEnum("attribution"),
      status: orderStatusEnum("status").notNull().default("paid"),
      paidAt: timestamptz("paid_at").notNull(),
      /**
       * When `postOrderLedger` wrote the sale's ledger entries (§9, §19.10). Null while the
       * Stripe fee is still unknown ("fee pending").
       */
      ledgerPostedAt: timestamptz("ledger_posted_at"),
      ...timestamps(),
    },
    (t) => [
      index("orders_launch_id_paid_at_idx").on(t.launchId, t.paidAt),
      index("orders_tracked_link_id_idx").on(t.trackedLinkId),
      index("orders_ledger_pending_idx")
        .on(t.paidAt)
        .where(sql`${t.ledgerPostedAt} IS NULL`),
      index("orders_status_idx").on(t.status),
      check(
        "orders_amounts_nonnegative",
        sql`${t.amountGrossCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.stripeFeeCents} >= 0 AND ${t.discountCents} >= 0`,
      ),
      check("orders_tax_within_gross", sql`${t.taxCents} <= ${t.amountGrossCents}`),
      check(
        "orders_refunded_range",
        sql`${t.amountRefundedCents} BETWEEN 0 AND ${t.amountGrossCents}`,
      ),
      check("orders_currency_format", currencyFormatCheck(t.currency)),
      check(
        "orders_buyer_country_format",
        sql`${t.buyerCountry} IS NULL OR ${t.buyerCountry} ~ '^[A-Z]{2}$'`,
      ),
      check(
        "orders_attribution_has_link",
        sql`(${t.attribution} IS NULL) = (${t.trackedLinkId} IS NULL)`,
      ),
      check(
        "orders_ledger_needs_balance_transaction",
        sql`${t.ledgerPostedAt} IS NULL OR ${t.stripeBalanceTransactionId} IS NOT NULL`,
      ),
      check(
        "orders_refunded_status",
        sql`${t.status} = 'disputed' OR (${t.status} = 'paid' AND ${t.amountRefundedCents} = 0) OR (${t.status} = 'partially_refunded' AND ${t.amountRefundedCents} > 0 AND ${t.amountRefundedCents} < ${t.amountGrossCents}) OR (${t.status} = 'refunded' AND ${t.amountRefundedCents} = ${t.amountGrossCents})`,
      ),
    ],
  ),
)

export const licenseKeys = withRLS(
  pgTable(
    "license_keys",
    {
      id: id(),
      launchId: uuid("launch_id")
        .notNull()
        .references(() => launches.id, { onDelete: "cascade" }),
      key: text("key").notNull(),
      /** Null until the key is assigned to an order. */
      orderId: uuid("order_id")
        .unique()
        .references(() => orders.id, { onDelete: "restrict" }),
      /** Set exactly when `order_id` is. */
      assignedAt: timestamptz("assigned_at"),
      ...timestamps(),
    },
    (t) => [
      unique("license_keys_launch_key_key").on(t.launchId, t.key),
      check("license_keys_key_not_blank", nonBlankCheck(t.key)),
      check("license_keys_key_length", sql`char_length(${t.key}) <= 200`),
      check("license_keys_assigned_pair", sql`(${t.orderId} IS NULL) = (${t.assignedAt} IS NULL)`),
      // Fast "next unassigned key" lookup.
      index("license_keys_unassigned_idx")
        .on(t.launchId)
        .where(sql`${t.orderId} IS NULL`),
    ],
  ),
)

/** Buyer access (§12): /access/[token]. */
export const accessGrants = withRLS(
  pgTable(
    "access_grants",
    {
      id: id(),
      orderId: uuid("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
      /** 32 random bytes, base64url without padding (43 characters). */
      token: text("token").notNull().unique(),
      revokedAt: timestamptz("revoked_at"),
      ...timestamps(),
    },
    (t) => [
      index("access_grants_order_id_idx").on(t.orderId),
      // One working grant per order; a revoked grant may be replaced (e.g. re-sent link).
      uniqueIndex("access_grants_one_active_per_order_idx")
        .on(t.orderId)
        .where(sql`${t.revokedAt} IS NULL`),
      check("access_grants_token_format", sql`${t.token} ~ '^[A-Za-z0-9_-]{43}$'`),
    ],
  ),
)

export const refunds = withRLS(
  pgTable(
    "refunds",
    {
      id: id(),
      orderId: uuid("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
      amountCents: integer("amount_cents").notNull(),
      currency: currency(),
      /**
       * Stripe's `re_…` id. Null only between our insert and Stripe's answer for a refund we
       * start; the row id is the idempotency key (`refund:<id>`) and `metadata.refund_id`.
       */
      stripeRefundId: text("stripe_refund_id").unique(),
      status: refundStatusEnum("status").notNull().default("pending"),
      /** Stripe's `failure_reason` for a failed refund. */
      failureReason: text("failure_reason"),
      reason: text("reason"),
      /** Who asked for it in the app; null for refunds made in Stripe's dashboard. */
      requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
        onDelete: "restrict",
      }),
      /** When the refund's mirror entries were written (on `succeeded`, §9). */
      ledgerPostedAt: timestamptz("ledger_posted_at"),
      ...timestamps(),
    },
    (t) => [
      index("refunds_order_id_idx").on(t.orderId),
      index("refunds_requested_by_user_id_idx").on(t.requestedByUserId),
      check("refunds_amount_positive", sql`${t.amountCents} > 0`),
      check("refunds_currency_format", currencyFormatCheck(t.currency)),
    ],
  ),
)

/**
 * A buyer's refund request from `/access/[token]/refund` (Phase 7, v1; CLAUDE.md §19.38). Buyers
 * have no account: the access token proves the purchase. One request per order, ever; an admin
 * approves it (which starts the refund through `requestRefund`, `refund_id`) or declines it.
 */
export const refundRequests = withRLS(
  pgTable(
    "refund_requests",
    {
      id: id(),
      orderId: uuid("order_id")
        .notNull()
        .unique()
        .references(() => orders.id, { onDelete: "restrict" }),
      /** The access grant whose token was used to ask. */
      accessGrantId: uuid("access_grant_id")
        .notNull()
        .references(() => accessGrants.id, { onDelete: "restrict" }),
      reason: refundRequestReasonEnum("reason").notNull(),
      /** Optional words from the buyer (≤ 1,000 characters); shown to admins and members only. */
      message: text("message"),
      /** What is left to refund when the request was made (integer cents, the order's currency). */
      amountCents: integer("amount_cents").notNull(),
      currency: currency(),
      status: refundRequestStatusEnum("status").notNull().default("pending"),
      decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
        onDelete: "restrict",
      }),
      decidedAt: timestamptz("decided_at"),
      /** The admin's note (≤ 500 characters); the buyer's email quotes it when declined. */
      decisionNote: text("decision_note"),
      /** The refund an approval started. */
      refundId: uuid("refund_id")
        .unique()
        .references(() => refunds.id, { onDelete: "restrict" }),
      ...timestamps(),
    },
    (t) => [
      index("refund_requests_status_created_at_idx").on(t.status, t.createdAt),
      index("refund_requests_access_grant_id_idx").on(t.accessGrantId),
      index("refund_requests_decided_by_user_id_idx").on(t.decidedByUserId),
      check("refund_requests_amount_positive", sql`${t.amountCents} > 0`),
      check("refund_requests_currency_format", currencyFormatCheck(t.currency)),
      check(
        "refund_requests_message",
        sql`${t.message} IS NULL OR (${nonBlankCheck(t.message)} AND char_length(${t.message}) <= 1000)`,
      ),
      check(
        "refund_requests_decision_note",
        sql`${t.decisionNote} IS NULL OR (${nonBlankCheck(t.decisionNote)} AND char_length(${t.decisionNote}) <= 500)`,
      ),
      // Decided exactly when not pending.
      check(
        "refund_requests_decided_columns",
        sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL) AND (${t.decidedAt} IS NULL) = (${t.decidedByUserId} IS NULL)`,
      ),
      // An approval always started a refund (approve = requestRefund, then this row).
      check(
        "refund_requests_refund_iff_approved",
        sql`(${t.status} = 'approved') = (${t.refundId} IS NOT NULL)`,
      ),
    ],
  ),
)

/**
 * A chargeback (Stripe `Dispute`, §9 "Disputes (chargebacks)"); not to be confused with collab
 * `disputes` (§5 trust). While `open`, the order is `disputed` and its entries are not paid out.
 */
export const chargebacks = withRLS(
  pgTable(
    "chargebacks",
    {
      id: id(),
      orderId: uuid("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
      /** Stripe's `du_…` / `dp_…` id. */
      stripeDisputeId: text("stripe_dispute_id").notNull().unique(),
      amountCents: integer("amount_cents").notNull(),
      /** Stripe's dispute fee, absorbed by the platform when lost (§19.31). */
      feeCents: integer("fee_cents").notNull().default(0),
      currency: currency(),
      /** Stripe's `reason` (e.g. `fraudulent`). */
      reason: text("reason"),
      status: chargebackStatusEnum("status").notNull().default("open"),
      /** Stripe's own status value, as last received. */
      stripeStatus: text("stripe_status").notNull(),
      openedAt: timestamptz("opened_at").notNull(),
      closedAt: timestamptz("closed_at"),
      /** When a lost chargeback's mirror entries were written. */
      ledgerPostedAt: timestamptz("ledger_posted_at"),
      ...timestamps(),
    },
    (t) => [
      index("chargebacks_order_id_idx").on(t.orderId),
      index("chargebacks_status_idx").on(t.status),
      check("chargebacks_amount_positive", sql`${t.amountCents} > 0 AND ${t.feeCents} >= 0`),
      check("chargebacks_currency_format", currencyFormatCheck(t.currency)),
      check("chargebacks_closed_iff_final", sql`(${t.status} = 'open') = (${t.closedAt} IS NULL)`),
      check(
        "chargebacks_ledger_only_when_lost",
        sql`${t.ledgerPostedAt} IS NULL OR ${t.status} = 'lost'`,
      ),
    ],
  ),
)
