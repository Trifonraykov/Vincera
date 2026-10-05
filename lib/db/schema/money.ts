import { sql } from "drizzle-orm"
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core"

import { now } from "../../clock"
import { createdAt, currency, id, timestamps, timestamptz } from "./columns"
import { ledgerAccountEnum, transferStatusEnum } from "./enums"
import { orders, refunds } from "./commerce"
import { users } from "./identity"
import type { JsonObject } from "./types"

/** Money (§5, §9). Nothing here is ever cascaded: deletes are RESTRICTed. */

/** Stripe Connect Express account per user, synced from `account.updated` (§7.2). */
export const stripeAccounts = pgTable("stripe_accounts", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "restrict" }),
  stripeAccountId: text("stripe_account_id").notNull().unique(),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  country: text("country"),
  updatedFromStripeAt: timestamptz("updated_from_stripe_at"),
  ...timestamps(),
})

/** One Stripe transfer per user per payout batch (§9). */
export const transfers = pgTable(
  "transfers",
  {
    /** Also the Stripe idempotency key for the transfer. */
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Null while `pending` (before Stripe returned the transfer). */
    stripeTransferId: text("stripe_transfer_id").unique(),
    amountCents: integer("amount_cents").notNull(),
    currency: currency(),
    status: transferStatusEnum("status").notNull().default("pending"),
    /** Total reversed via transfer reversals after refunds (§9). */
    amountReversedCents: integer("amount_reversed_cents").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("transfers_user_id_idx").on(t.userId),
    check("transfers_amount_positive", sql`${t.amountCents} > 0`),
    check("transfers_reversed_range", sql`${t.amountReversedCents} BETWEEN 0 AND ${t.amountCents}`),
  ],
)

/**
 * Append-only ledger (§5, §9): every component of every sale and refund. `user_id` null = platform.
 * DB triggers block UPDATE and DELETE, except setting `transfer_id` once (NULL → value) when the
 * payout job pays the entry out. Corrections are new (negative/adjustment) entries.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    account: ledgerAccountEnum("account").notNull(),
    /** Signed: refunds and reversals are negative. */
    amountCents: integer("amount_cents").notNull(),
    currency: currency(),
    /** paid_at + HOLD_DAYS; the payout job only pays entries available by then. */
    availableAt: timestamptz("available_at").notNull(),
    transferId: uuid("transfer_id").references(() => transfers.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_user_id_available_at_idx").on(t.userId, t.availableAt),
    index("ledger_entries_order_id_idx").on(t.orderId),
    index("ledger_entries_refund_id_idx").on(t.refundId),
    index("ledger_entries_transfer_id_idx").on(t.transferId),
    // Member shares belong to a user; platform-side components belong to nobody.
    check(
      "ledger_entries_share_has_user",
      sql`${t.account} NOT IN ('creator_share', 'builder_share') OR ${t.userId} IS NOT NULL`,
    ),
    check(
      "ledger_entries_platform_has_no_user",
      sql`${t.account} NOT IN ('platform_fee', 'stripe_fee', 'tax') OR ${t.userId} IS NULL`,
    ),
  ],
)

/** Stripe webhook idempotency (§7.2): one row per received event id. */
export const stripeEvents = pgTable("stripe_events", {
  /** Stripe event id (evt_...). */
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<JsonObject>().notNull(),
  receivedAt: timestamptz("received_at").notNull().defaultNow().$defaultFn(now),
  processedAt: timestamptz("processed_at"),
})
