import { z } from "zod"

import { expandableIdSchema, stripeIdSchema, stripeMetadataSchema } from "./ids"

/**
 * Money objects of the Stripe gateway (Phase 5, CLAUDE.md §19.31): balance transactions (the real
 * Stripe fee, §9), transfers and their reversals (payouts, §9 / §19.10), refunds and disputes
 * (chargebacks). Zod schemas keep Stripe's field names and only the fields the platform reads.
 *
 * Owner: the ledger builder (`./live-money.ts`, `./fake-money.ts`); payouts reads these types.
 * Unknown enum values from newer API versions stay strings; callers map them (fail closed).
 */

const amount = z.int()
const currency = z.string().regex(/^[a-z]{3}$/)
const unixSeconds = z.int().nonnegative()

// --- Balance transactions ---------------------------------------------------------------------

/** One line of `BalanceTransaction.fee_details` (`stripe_fee`, `tax`, `application_fee`, ...). */
export const stripeFeeDetailSchema = z.object({
  amount,
  currency,
  type: z.string().min(1),
  description: z.string().nullish(),
})

/**
 * A `BalanceTransaction`: `fee` is what Stripe kept from the charge (§9 step 2, `stripe_fee`),
 * `net = amount - fee`. Amounts are in the platform's settlement currency (EUR for this platform;
 * a different currency than the order's is refused by the ledger).
 */
export const stripeBalanceTransactionSchema = z.object({
  id: stripeIdSchema("txn"),
  object: z.literal("balance_transaction"),
  amount,
  fee: amount,
  net: amount,
  currency,
  fee_details: z.array(stripeFeeDetailSchema),
  /** `pending | available`. */
  status: z.string().min(1),
  /** `charge`, `refund`, `adjustment`, ... */
  type: z.string().min(1),
  available_on: unixSeconds,
  created: unixSeconds,
  source: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
})
export type StripeBalanceTransaction = z.output<typeof stripeBalanceTransactionSchema>

/** A `balance_transaction` field: an id, the expanded object, or null while still pending. */
export const balanceTransactionFieldSchema = z
  .union([stripeIdSchema("txn"), stripeBalanceTransactionSchema])
  .nullable()

// --- Transfers --------------------------------------------------------------------------------

/** A `Transfer` to a connected account (one aggregated transfer per user per batch, §19.10). */
export const stripeTransferSchema = z.object({
  id: stripeIdSchema("tr"),
  object: z.literal("transfer"),
  amount,
  amount_reversed: amount,
  currency,
  destination: expandableIdSchema("acct"),
  transfer_group: z.string().nullish(),
  reversed: z.boolean(),
  metadata: stripeMetadataSchema.nullish(),
  created: unixSeconds,
})
export type StripeTransfer = z.output<typeof stripeTransferSchema>

/** A `TransferReversal` (money pulled back from a connected account after a refund, §9). */
export const stripeTransferReversalSchema = z.object({
  id: stripeIdSchema("trr"),
  object: z.literal("transfer_reversal"),
  amount,
  currency,
  transfer: expandableIdSchema("tr"),
  metadata: stripeMetadataSchema.nullish(),
  created: unixSeconds,
})
export type StripeTransferReversal = z.output<typeof stripeTransferReversalSchema>

export type CreateTransferInput = {
  /** Integer cents, > 0. */
  amount: number
  currency: string
  /** The user's connected account (`stripe_accounts.stripe_account_id`). */
  destination: string
  /** `payout_<transfers.id>`: lets a retry find a transfer whose idempotency key expired. */
  transferGroup: string
  /** At least `transfer_id`, `batch_id`, `user_id` (our ids; never emails). */
  metadata: Record<string, string>
}

export type CreateTransferReversalInput = {
  transferId: string
  /** Integer cents, > 0, at most what is left unreversed. */
  amount: number
  /** At least `transfer_reversal_id` and `refund_id` or `chargeback_id`. */
  metadata: Record<string, string>
}

// --- Refunds ----------------------------------------------------------------------------------

/** A `Refund`. `status`: `pending | requires_action | succeeded | failed | canceled`. */
export const stripeRefundSchema = z.object({
  id: stripeIdSchema("re"),
  object: z.literal("refund"),
  amount,
  currency,
  status: z.string().nullish(),
  failure_reason: z.string().nullish(),
  reason: z.string().nullish(),
  payment_intent: expandableIdSchema("pi").nullish(),
  charge: expandableIdSchema("ch").nullish(),
  balance_transaction: balanceTransactionFieldSchema.optional(),
  /** `refund_id` (our row id) when the platform started the refund. */
  metadata: stripeMetadataSchema.nullish(),
  created: unixSeconds,
})
export type StripeRefund = z.output<typeof stripeRefundSchema>

export type CreateRefundInput = {
  paymentIntentId: string
  /** Integer cents, > 0, at most what is left unrefunded. */
  amount: number
  /** Stripe's reason enum, when one applies. */
  reason?: "duplicate" | "fraudulent" | "requested_by_customer"
  /** At least `refund_id` and `order_ref` (our ids). */
  metadata: Record<string, string>
}

// --- Disputes (chargebacks) -------------------------------------------------------------------

/**
 * A `Dispute` (`charge.dispute.*`). Its balance transactions carry the disputed amount and the
 * dispute fee the platform pays (§9; the platform absorbs the fee when lost, CLAUDE.md §19.31).
 */
export const stripeDisputeSchema = z.object({
  id: z.string().regex(/^(du|dp)_[A-Za-z0-9_]{1,250}$/),
  object: z.literal("dispute"),
  amount,
  currency,
  /** `warning_needs_response | warning_under_review | warning_closed | needs_response |
   * under_review | won | lost | prevented`. */
  status: z.string().min(1),
  reason: z.string().nullish(),
  charge: expandableIdSchema("ch"),
  payment_intent: expandableIdSchema("pi").nullish(),
  balance_transactions: z.array(stripeBalanceTransactionSchema).nullish(),
  created: unixSeconds,
})
export type StripeDispute = z.output<typeof stripeDisputeSchema>
