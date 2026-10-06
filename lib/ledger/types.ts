import type { CollabRole, LedgerAccount } from "@/lib/db/schema/enums"

/**
 * Ledger contracts (§9; CLAUDE.md §19.31 "Ledger"). Client-safe types only. Owner: the ledger
 * builder, who implements `./split.ts`, `./post.ts`, `./release.ts`, `./refund.ts`, `./check.ts`
 * against these shapes; checkout and payouts call them.
 */

/** A collab member as the split sees them (`collab_members`: split_pct sums to 100). */
export type SplitMember = { userId: string; role: CollabRole; splitPct: number }

export type SplitInput = {
  /** What the buyer paid, tax included (`orders.amount_gross_cents`), integer cents ≥ 0. */
  grossCents: number
  /** `orders.tax_cents` (Stripe Tax, included in gross). */
  taxCents: number
  /** The balance transaction's `fee`. */
  stripeFeeCents: number
  /** PLATFORM_TAKE_RATE in basis points (0.10 → 1000), so the fee is integer arithmetic. */
  takeRateBps: number
  members: readonly SplitMember[]
}

/** One ledger line before it is written (`ledger_entries` minus ids and timestamps). */
export type LedgerLine = { account: LedgerAccount; userId: string | null; amountCents: number }

export type SplitResult = {
  /** gross − tax − stripe_fee. */
  netCents: number
  /** round(net × rate), half up; when net ≤ 0 it is net itself (the platform carries the loss). */
  platformFeeCents: number
  /** net − platform_fee (0 when net ≤ 0). */
  distributableCents: number
  /** Largest remainder over split_pct; ties → the lower user id; sums to distributable. */
  shares: { userId: string; role: CollabRole; amountCents: number }[]
  /**
   * tax, stripe_fee, platform_fee (user null) and one `<role>_share` per member; zero lines are
   * left out. Always sums to gross (asserted).
   */
  lines: LedgerLine[]
}

export type PostOrderLedgerResult =
  | { status: "posted"; entryCount: number; platformFeeCents: number }
  /** `ledger_posted_at` was already set: nothing written. */
  | { status: "already_posted" }

export type PostRefundLedgerResult =
  | { status: "posted"; entryCount: number }
  | { status: "already_posted" }
  /** The order's sale entries are not posted yet; the refund is posted after them. */
  | { status: "order_not_posted" }

/** `reverseRefundLedger`: a refund that failed after it succeeded gets the mirror of its mirror. */
export type ReverseRefundLedgerResult =
  | { status: "reversed"; entryCount: number }
  /** Its lines already net to zero. */
  | { status: "already_reversed" }
  /** It was never posted: nothing to undo. */
  | { status: "nothing_to_reverse" }

/** A user's payable balance at a batch's cutoff (§9 daily payout job). */
export type PayableBalance = {
  userId: string
  currency: string
  /** The user's connected account (`stripe_accounts.stripe_account_id`), the transfer's destination. */
  stripeAccountId: string
  /** Net of the entries below (negative entries included, §19.10). */
  amountCents: number
  entryIds: string[]
}

/** A user's money per currency (`userBalances`, for `/app/earnings`). */
export type UserBalance = {
  currency: string
  /** Posted, still in the hold period. */
  pendingCents: number
  /** Past the hold, not paid out yet (may be below `MIN_PAYOUT_CENTS`, or negative). */
  availableCents: number
  /** Frozen by an open chargeback (order `disputed`). */
  onHoldCents: number
  /** Paid out by transfers (net of failed transfers' releases and settled reversals). */
  paidOutCents: number
}

/** `releaseFailedTransferEntries`. */
export type ReleaseFailedTransferResult =
  | { status: "released"; entryCount: number; amountCents: number }
  | { status: "already_released" }
  | { status: "nothing_to_release" }

export type LedgerCheckMismatch = {
  kind:
    | "order_sum" // entries of an order ≠ gross − succeeded refunds − lost chargebacks
    | "order_refunded" // amount_refunded_cents ≠ min(gross, succeeded refunds + lost chargebacks)
    | "order_not_posted" // paid more than a day ago, still no ledger
    | "order_stripe" // Stripe's charge was refunded or disputed differently from our records
    | "transfer_sum" // entries paid by a transfer ≠ amount − reversed
    | "transfer_stripe" // our transfer ≠ Stripe's (amount, reversed, destination, several in a group)
    | "transfer_unknown" // a transfer at Stripe we have no row for (e.g. a double payout)
    | "transfer_pending" // a transfer still `pending` after a day (crash before Stripe answered)
    | "reversal_pending" // a transfer reversal still `pending` after a day
    | "refund_sum" // a posted refund's entries ≠ −amount (0 once it failed and was reversed)
    | "chargeback_sum" // a lost chargeback's entries ≠ −amount
    | "adjustment_sum" // an admin ledger adjustment's entries ≠ 0 (Phase 6)
  orderId?: string
  transferId?: string
  reversalId?: string
  /** A Stripe id (`transfer_unknown`): the transfer we have no row for. */
  stripeId?: string
  refundId?: string
  chargebackId?: string
  adjustmentId?: string
  /** Ids and amounts only: what differs (e.g. `destination`, `missing at Stripe`). */
  detail?: string
  expectedCents: number
  actualCents: number
}

export type LedgerCheckReport = {
  ordersChecked: number
  transfersChecked: number
  mismatches: LedgerCheckMismatch[]
}
