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
  uuid,
} from "drizzle-orm/pg-core"

import { createdAt, currency, id, timestamps, timestamptz } from "./columns"
import { deliveryTypeEnum, launchStatusEnum, orderStatusEnum } from "./enums"
import { collabs } from "./collab"
import { users } from "./identity"
import type { DeliveryConfig, LaunchApproval, LaunchMedia } from "./types"

/**
 * Launch & commerce (§5, §10). Orders and everything that money or attribution hangs off are
 * never cascaded (RESTRICT); a launch's files and unassigned keys cascade with it.
 */

export const launches = pgTable(
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
    /** Approvals of the current version; saving the launch resets it (§12). */
    approvedBy: jsonb("approved_by")
      .$type<LaunchApproval[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    wentLiveAt: timestamptz("went_live_at"),
    ...timestamps(),
  },
  (t) => [
    index("launches_status_idx").on(t.status),
    check("launches_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("launches_price_nonnegative", sql`${t.priceCents} >= 0`),
    // Beyond draft, a launch must be sellable.
    check(
      "launches_complete_unless_draft",
      sql`${t.status} = 'draft' OR (${t.priceCents} IS NOT NULL AND ${t.deliveryType} IS NOT NULL)`,
    ),
  ],
)

export const launchFiles = pgTable(
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
    ...timestamps(),
  },
  (t) => [
    index("launch_files_launch_id_idx").on(t.launchId),
    check("launch_files_size_nonnegative", sql`${t.sizeBytes} >= 0`),
  ],
)

export const trackedLinks = pgTable(
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
    discountCode: text("discount_code"),
    ...timestamps(),
  },
  (t) => [
    index("tracked_links_launch_id_idx").on(t.launchId),
    index("tracked_links_owner_user_id_idx").on(t.ownerUserId),
    unique("tracked_links_launch_discount_code_key").on(t.launchId, t.discountCode),
    check("tracked_links_code_format", sql`${t.code} ~ '^[0-9A-Za-z]{8}$'`),
  ],
)

/** Append-only (§5): one row per /r/[code] hit, never updated or deleted. */
export const linkClicks = pgTable(
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
)

export const orders = pgTable(
  "orders",
  {
    /** Also sent to Stripe Checkout as metadata.order_ref (§7.2). */
    id: id(),
    launchId: uuid("launch_id")
      .notNull()
      .references(() => launches.id, { onDelete: "restrict" }),
    buyerEmail: text("buyer_email").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull().unique(),
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    amountGrossCents: integer("amount_gross_cents").notNull(),
    taxCents: integer("tax_cents").notNull().default(0),
    stripeFeeCents: integer("stripe_fee_cents").notNull().default(0),
    currency: currency(),
    trackedLinkId: uuid("tracked_link_id").references(() => trackedLinks.id, {
      onDelete: "restrict",
    }),
    status: orderStatusEnum("status").notNull().default("paid"),
    paidAt: timestamptz("paid_at").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("orders_launch_id_paid_at_idx").on(t.launchId, t.paidAt),
    index("orders_tracked_link_id_idx").on(t.trackedLinkId),
    check(
      "orders_amounts_nonnegative",
      sql`${t.amountGrossCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.stripeFeeCents} >= 0`,
    ),
  ],
)

export const licenseKeys = pgTable(
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
    ...timestamps(),
  },
  (t) => [
    unique("license_keys_launch_key_key").on(t.launchId, t.key),
    // Fast "next unassigned key" lookup.
    index("license_keys_unassigned_idx")
      .on(t.launchId)
      .where(sql`${t.orderId} IS NULL`),
  ],
)

/** Buyer access (§12): /access/[token]. */
export const accessGrants = pgTable(
  "access_grants",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    /** 32 random bytes, base64url. */
    token: text("token").notNull().unique(),
    revokedAt: timestamptz("revoked_at"),
    ...timestamps(),
  },
  (t) => [index("access_grants_order_id_idx").on(t.orderId)],
)

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    stripeRefundId: text("stripe_refund_id").unique(),
    reason: text("reason"),
    ...timestamps(),
  },
  (t) => [
    index("refunds_order_id_idx").on(t.orderId),
    check("refunds_amount_positive", sql`${t.amountCents} > 0`),
  ],
)
