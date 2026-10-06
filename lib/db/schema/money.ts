import { sql } from "drizzle-orm"
import {
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

import { now } from "../../clock"
import {
  createdAt,
  currency,
  currencyFormatCheck,
  id,
  nonBlankCheck,
  textArray,
  timestamps,
  timestamptz,
  withRLS,
} from "./columns"
import {
  ledgerAccountEnum,
  payoutBatchStatusEnum,
  stripeCapabilityStatusEnum,
  transferReversalStatusEnum,
  transferStatusEnum,
} from "./enums"
import { chargebacks, orders, refunds } from "./commerce"
import { users } from "./identity"
import type { JsonObject } from "./types"

/** Money (§5, §9). Nothing here is ever cascaded: deletes are RESTRICTed. */

/**
 * Stripe Connect account per user (v1 account with Express dashboard controller properties,
 * §19.10), synced from `account.updated` / `capability.updated` (§7.2). "Payouts ready" =
 * `payouts_enabled` AND `transfers_capability = 'active'` (lib/payouts/readiness.ts).
 */
export const stripeAccounts = withRLS(
  pgTable(
    "stripe_accounts",
    {
      id: id(),
      userId: uuid("user_id")
        .notNull()
        .unique()
        .references(() => users.id, { onDelete: "restrict" }),
      stripeAccountId: text("stripe_account_id").notNull().unique(),
      chargesEnabled: boolean("charges_enabled").notNull().default(false),
      payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
      detailsSubmitted: boolean("details_submitted").notNull().default(false),
      /** `account.capabilities.transfers`; `unrequested` when absent. */
      transfersCapability: stripeCapabilityStatusEnum("transfers_capability")
        .notNull()
        .default("unrequested"),
      /** `account.requirements.currently_due` (includes `past_due`): what Stripe still needs. */
      requirementsCurrentlyDue: textArray("requirements_currently_due"),
      /** `account.requirements.disabled_reason`, e.g. `requirements.past_due`; null when enabled. */
      disabledReason: text("disabled_reason"),
      /** ISO 3166-1 alpha-2, as Stripe reports it. */
      country: text("country"),
      /**
       * When the Stripe data last applied was current: the event's `created` for webhooks, the
       * retrieval time for `accounts.retrieve`. An older event never overwrites newer data.
       */
      updatedFromStripeAt: timestamptz("updated_from_stripe_at"),
      ...timestamps(),
    },
    (t) => [check("stripe_accounts_country_format", sql`${t.country} ~ '^[A-Z]{2}$'`)],
  ),
)

/**
 * One run of the daily payout job (§9, §13 `payouts/release`; CLAUDE.md §19.31). `run_key`
 * (`daily:<YYYY-MM-DD>`, or `manual:<uuid>` for an admin run) makes a run idempotent: a retried
 * or repeated run finds its batch and resumes it.
 */
export const payoutBatches = withRLS(
  pgTable(
    "payout_batches",
    {
      id: id(),
      runKey: text("run_key").notNull().unique(),
      /** Entries with `available_at <= cutoff_at` are payable in this batch (the run's clock). */
      cutoffAt: timestamptz("cutoff_at").notNull(),
      status: payoutBatchStatusEnum("status").notNull().default("running"),
      startedAt: timestamptz("started_at").notNull(),
      completedAt: timestamptz("completed_at"),
      /** Transfers created at Stripe in this batch, and their total. */
      transferCount: integer("transfer_count").notNull().default(0),
      totalCents: integer("total_cents").notNull().default(0),
      failedCount: integer("failed_count").notNull().default(0),
      ...timestamps(),
    },
    (t) => [
      check("payout_batches_run_key_not_blank", nonBlankCheck(t.runKey)),
      check(
        "payout_batches_completed_iff_final",
        sql`(${t.status} = 'running') = (${t.completedAt} IS NULL)`,
      ),
      check(
        "payout_batches_counts_nonnegative",
        sql`${t.transferCount} >= 0 AND ${t.totalCents} >= 0 AND ${t.failedCount} >= 0`,
      ),
    ],
  ),
)

/** One Stripe transfer per user (and currency) per payout batch (§9, §19.10). */
export const transfers = withRLS(
  pgTable(
    "transfers",
    {
      /** Also the Stripe idempotency key's anchor and `metadata.transfer_id`. */
      id: id(),
      batchId: uuid("batch_id")
        .notNull()
        .references(() => payoutBatches.id, { onDelete: "restrict" }),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      /** The connected account paid (`acct_…`), as it was when the transfer was made. */
      destinationAccountId: text("destination_account_id").notNull(),
      /** Null while `pending` (before Stripe returned the transfer). */
      stripeTransferId: text("stripe_transfer_id").unique(),
      amountCents: integer("amount_cents").notNull(),
      currency: currency(),
      status: transferStatusEnum("status").notNull().default("pending"),
      /** Stripe's error code when `failed` (e.g. `balance_insufficient`). */
      failureCode: text("failure_code"),
      /** Total reversed via transfer reversals after refunds (§9). */
      amountReversedCents: integer("amount_reversed_cents").notNull().default(0),
      ...timestamps(),
    },
    (t) => [
      index("transfers_user_id_idx").on(t.userId),
      index("transfers_batch_id_idx").on(t.batchId),
      unique("transfers_batch_user_currency_key").on(t.batchId, t.userId, t.currency),
      check("transfers_amount_positive", sql`${t.amountCents} > 0`),
      check(
        "transfers_reversed_range",
        sql`${t.amountReversedCents} BETWEEN 0 AND ${t.amountCents}`,
      ),
      check("transfers_currency_format", currencyFormatCheck(t.currency)),
      check(
        "transfers_stripe_id_unless_pending",
        sql`${t.status} IN ('pending', 'failed') OR ${t.stripeTransferId} IS NOT NULL`,
      ),
      check(
        "transfers_failure_code_only_when_failed",
        sql`${t.failureCode} IS NULL OR ${t.status} = 'failed'`,
      ),
    ],
  ),
)

/**
 * A reversal of (part of) a transfer after money already paid out was refunded or lost to a
 * chargeback (§9 "create a transfer reversal and record it"; CLAUDE.md §19.31). The row id is the
 * Stripe idempotency key's anchor. A failed reversal leaves the negative entries unpaid, so they
 * are netted against the user's next payouts (§19.10).
 */
export const transferReversals = withRLS(
  pgTable(
    "transfer_reversals",
    {
      id: id(),
      transferId: uuid("transfer_id")
        .notNull()
        .references(() => transfers.id, { onDelete: "restrict" }),
      refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "restrict" }),
      chargebackId: uuid("chargeback_id").references(() => chargebacks.id, {
        onDelete: "restrict",
      }),
      /** Stripe's `trr_…` id once created. */
      stripeReversalId: text("stripe_reversal_id").unique(),
      amountCents: integer("amount_cents").notNull(),
      currency: currency(),
      status: transferReversalStatusEnum("status").notNull().default("pending"),
      failureCode: text("failure_code"),
      ...timestamps(),
    },
    (t) => [
      index("transfer_reversals_transfer_id_idx").on(t.transferId),
      index("transfer_reversals_refund_id_idx").on(t.refundId),
      index("transfer_reversals_chargeback_id_idx").on(t.chargebackId),
      check("transfer_reversals_amount_positive", sql`${t.amountCents} > 0`),
      check("transfer_reversals_currency_format", currencyFormatCheck(t.currency)),
      check(
        "transfer_reversals_one_cause",
        sql`num_nonnulls(${t.refundId}, ${t.chargebackId}) <= 1`,
      ),
      check(
        "transfer_reversals_stripe_id_when_succeeded",
        sql`${t.status} <> 'succeeded' OR ${t.stripeReversalId} IS NOT NULL`,
      ),
    ],
  ),
)

/**
 * Append-only ledger (§5, §9): every component of every sale and refund. `user_id` null = platform.
 * DB triggers block UPDATE and DELETE, except setting `transfer_id` once (NULL → value) when the
 * payout job pays the entry out. Corrections are new (negative/adjustment) entries.
 */
export const ledgerEntries = withRLS(
  pgTable(
    "ledger_entries",
    {
      id: id(),
      orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
      refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "restrict" }),
      /** A lost chargeback's mirror entries (§9; CLAUDE.md §19.31). */
      chargebackId: uuid("chargeback_id").references(() => chargebacks.id, {
        onDelete: "restrict",
      }),
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
      index("ledger_entries_chargeback_id_idx").on(t.chargebackId),
      index("ledger_entries_transfer_id_idx").on(t.transferId),
      // The payout query: a user's unpaid entries.
      index("ledger_entries_unpaid_idx")
        .on(t.userId, t.availableAt)
        .where(sql`${t.transferId} IS NULL AND ${t.userId} IS NOT NULL`),
      check("ledger_entries_currency_format", currencyFormatCheck(t.currency)),
      check("ledger_entries_one_cause", sql`num_nonnulls(${t.refundId}, ${t.chargebackId}) <= 1`),
      check(
        "ledger_entries_cause_has_order",
        sql`(${t.refundId} IS NULL AND ${t.chargebackId} IS NULL) OR ${t.orderId} IS NOT NULL`,
      ),
      // Platform-side entries are never paid out.
      check(
        "ledger_entries_transfer_needs_user",
        sql`${t.transferId} IS NULL OR ${t.userId} IS NOT NULL`,
      ),
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
  ),
)

/** Stripe webhook idempotency (§7.2): one row per received event id. */
export const stripeEvents = withRLS(
  pgTable("stripe_events", {
    /** Stripe event id (evt_...). */
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    /** Connected account (`event.account`) for Connect events; null for platform events. */
    account: text("account"),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    receivedAt: timestamptz("received_at").notNull().defaultNow().$defaultFn(now),
    processedAt: timestamptz("processed_at"),
  }),
)
