import "server-only"

import { and, asc, eq, isNull, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import type { Tx } from "@/lib/db/client"
import {
  chargebacks,
  collabMembers,
  launches,
  ledgerEntries,
  orders,
  refunds,
} from "@/lib/db/schema"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import type { StripeBalanceTransaction } from "@/lib/stripe/money-shared"

import { LedgerError } from "./errors"
import {
  componentsFromEntries,
  computeChargebackMirror,
  computeRefundMirror,
  disputeFeeLines,
} from "./refund"
import { assertLinesSum, computeSplit, takeRateBps } from "./split"
import type {
  LedgerLine,
  PostOrderLedgerResult,
  PostRefundLedgerResult,
  ReverseRefundLedgerResult,
} from "./types"

/**
 * Posting the ledger (§9; CLAUDE.md §19.31 "Ledger", §19.33). Every function runs inside the
 * caller's transaction, locks the order first (`FOR UPDATE`; the refund and dispute handlers take
 * the same lock first, so the order of locks is always order → refund/chargeback), is idempotent,
 * and asserts its sums before writing. Entries are append-only: nothing here updates or deletes a
 * ledger row.
 */

/** Take rate and hold period; defaults from the environment (§17 `PLATFORM_TAKE_RATE`, `HOLD_DAYS`). */
export type LedgerConfig = { takeRateBps: number; holdDays: number }

export function ledgerConfigFromEnv(): LedgerConfig {
  return { takeRateBps: takeRateBps(env.PLATFORM_TAKE_RATE), holdDays: env.HOLD_DAYS }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** paid_at + HOLD_DAYS (§9 step 5). */
export function availableAtFor(paidAt: Date, holdDays: number): Date {
  return new Date(paidAt.getTime() + holdDays * DAY_MS)
}

/**
 * The sale's entries (§9 steps 2–5): lock the order; `ledger_posted_at` set → `already_posted`;
 * else split gross with the balance transaction's fee over the collab's members (the signed
 * split), write every line with `available_at = paid_at + HOLD_DAYS`, set `stripe_fee_cents`,
 * `stripe_balance_transaction_id`, `ledger_posted_at`, and track `order.ledger_posted`. Succeeded
 * refunds and lost chargebacks that arrived before the fee was known are posted right after.
 */
export async function postOrderLedger(
  tx: Tx,
  input: { orderId: string; balanceTransaction: StripeBalanceTransaction },
  config: LedgerConfig = ledgerConfigFromEnv(),
): Promise<PostOrderLedgerResult> {
  const { orderId, balanceTransaction: bt } = input
  const order = await lockOrder(tx, orderId)
  if (order.ledgerPostedAt) return { status: "already_posted" }

  if (bt.currency !== order.currency) {
    throw new LedgerError(
      "currency_mismatch",
      `order ${order.id}: balance transaction ${bt.id} is in ${bt.currency}, the order in ${order.currency}`,
    )
  }
  if (bt.amount !== order.amountGrossCents) {
    throw new LedgerError(
      "balance_transaction_mismatch",
      `order ${order.id}: balance transaction ${bt.id} is for ${bt.amount}, the order for ${order.amountGrossCents}`,
    )
  }
  if (!Number.isSafeInteger(bt.fee) || bt.fee < 0) {
    throw new LedgerError("invalid_input", `balance transaction ${bt.id} has fee ${bt.fee}`)
  }

  const members = await tx
    .select({
      userId: collabMembers.userId,
      role: collabMembers.role,
      splitPct: collabMembers.splitPct,
    })
    .from(collabMembers)
    .innerJoin(launches, eq(launches.collabId, collabMembers.collabId))
    .where(eq(launches.id, order.launchId))

  const split = computeSplit({
    grossCents: order.amountGrossCents,
    taxCents: order.taxCents,
    stripeFeeCents: bt.fee,
    takeRateBps: config.takeRateBps,
    members,
  })

  const availableAt = availableAtFor(order.paidAt, config.holdDays)
  await insertLines(tx, split.lines, { orderId: order.id, currency: order.currency, availableAt })

  await tx
    .update(orders)
    .set({
      stripeFeeCents: bt.fee,
      stripeBalanceTransactionId: bt.id,
      ledgerPostedAt: now(),
    })
    .where(eq(orders.id, order.id))

  await track(
    "order.ledger_posted",
    {
      actorUserId: null,
      subjectType: "order",
      subjectId: order.id,
      properties: {
        launch_id: order.launchId,
        stripe_fee_cents: bt.fee,
        platform_fee_cents: split.platformFeeCents,
        currency: order.currency,
        entry_count: split.lines.length,
      },
    },
    tx,
  )

  // Refunds and lost chargebacks that came before the fee was known (§19.31: "posted later by
  // whoever posts the sale").
  const waitingRefunds = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, order.id),
        eq(refunds.status, "succeeded"),
        isNull(refunds.ledgerPostedAt),
      ),
    )
    .orderBy(asc(refunds.createdAt), asc(refunds.id))
  for (const refund of waitingRefunds) await postRefundLedger(tx, { refundId: refund.id })

  const waitingChargebacks = await tx
    .select({ id: chargebacks.id })
    .from(chargebacks)
    .where(
      and(
        eq(chargebacks.orderId, order.id),
        eq(chargebacks.status, "lost"),
        isNull(chargebacks.ledgerPostedAt),
      ),
    )
    .orderBy(asc(chargebacks.createdAt), asc(chargebacks.id))
  for (const chargeback of waitingChargebacks) {
    await postChargebackLedger(tx, { chargebackId: chargeback.id })
  }
  // Dispute fees Stripe withdrew before the sale was posted (any chargeback status).
  const disputed = await tx
    .select({ id: chargebacks.id })
    .from(chargebacks)
    .where(eq(chargebacks.orderId, order.id))
    .orderBy(asc(chargebacks.createdAt), asc(chargebacks.id))
  for (const chargeback of disputed) {
    await postDisputeFeeLedger(tx, { chargebackId: chargeback.id })
  }

  return {
    status: "posted",
    entryCount: split.lines.length,
    platformFeeCents: split.platformFeeCents,
  }
}

/**
 * The mirror entries of a succeeded refund (`refund_id` set), proportional to what is left of the
 * order's components (lib/ledger/refund.ts). `available_at = max(sale's available_at, now)`, so a
 * refund before payout nets out in the same payout. Idempotent via `refunds.ledger_posted_at`;
 * `order_not_posted` until the sale is posted (`postOrderLedger` posts it then). Does not touch
 * `orders.amount_refunded_cents` / status: the refund handler sets them in the same transaction.
 */
export async function postRefundLedger(
  tx: Tx,
  input: { refundId: string },
): Promise<PostRefundLedgerResult> {
  const [found] = await tx
    .select({ orderId: refunds.orderId })
    .from(refunds)
    .where(eq(refunds.id, input.refundId))
  if (!found) throw new LedgerError("not_found", `refund ${input.refundId} not found`)

  const order = await lockOrder(tx, found.orderId)
  const [refund] = await tx
    .select()
    .from(refunds)
    .where(eq(refunds.id, input.refundId))
    .for("update")
  if (!refund) throw new LedgerError("not_found", `refund ${input.refundId} not found`)
  if (refund.ledgerPostedAt) return { status: "already_posted" }
  if (refund.status !== "succeeded") {
    throw new LedgerError("invalid_state", `refund ${refund.id} is ${refund.status}, not succeeded`)
  }
  if (!order.ledgerPostedAt) return { status: "order_not_posted" }
  if (refund.currency !== order.currency) {
    throw new LedgerError(
      "currency_mismatch",
      `refund ${refund.id} is in ${refund.currency}, its order in ${order.currency}`,
    )
  }

  const stored = await orderLines(tx, order.id)
  const mirror = computeRefundMirror({
    components: componentsFromEntries(stored),
    amountCents: refund.amountCents,
  })
  await insertLines(tx, mirror.lines, {
    orderId: order.id,
    refundId: refund.id,
    currency: order.currency,
    availableAt: mirrorAvailableAt(stored),
  })
  await tx.update(refunds).set({ ledgerPostedAt: now() }).where(eq(refunds.id, refund.id))
  return { status: "posted", entryCount: mirror.lines.length }
}

/**
 * A lost chargeback: the refund mirror of the disputed amount (`chargeback_id` set), capped at what
 * is left of the order, plus an `adjustment` for anything Stripe took beyond it (a dispute after a
 * refund; CLAUDE.md §19.37). Idempotent via `chargebacks.ledger_posted_at`. The dispute fee is not
 * part of it: `postDisputeFeeLedger` books it when Stripe withdraws it. The dispute handler adds
 * the mirrored amount to the order's refunded amount in the same transaction.
 */
export async function postChargebackLedger(
  tx: Tx,
  input: { chargebackId: string },
): Promise<PostRefundLedgerResult> {
  const [found] = await tx
    .select({ orderId: chargebacks.orderId })
    .from(chargebacks)
    .where(eq(chargebacks.id, input.chargebackId))
  if (!found) throw new LedgerError("not_found", `chargeback ${input.chargebackId} not found`)

  const order = await lockOrder(tx, found.orderId)
  const [chargeback] = await tx
    .select()
    .from(chargebacks)
    .where(eq(chargebacks.id, input.chargebackId))
    .for("update")
  if (!chargeback) throw new LedgerError("not_found", `chargeback ${input.chargebackId} not found`)
  if (chargeback.ledgerPostedAt) return { status: "already_posted" }
  if (chargeback.status !== "lost") {
    throw new LedgerError(
      "invalid_state",
      `chargeback ${chargeback.id} is ${chargeback.status}, not lost`,
    )
  }
  if (!order.ledgerPostedAt) return { status: "order_not_posted" }
  if (chargeback.currency !== order.currency) {
    throw new LedgerError(
      "currency_mismatch",
      `chargeback ${chargeback.id} is in ${chargeback.currency}, its order in ${order.currency}`,
    )
  }

  const stored = await orderLines(tx, order.id)
  const mirror = computeChargebackMirror({
    components: componentsFromEntries(stored),
    amountCents: chargeback.amountCents,
  })
  await insertLines(tx, mirror.lines, {
    orderId: order.id,
    chargebackId: chargeback.id,
    currency: order.currency,
    availableAt: mirrorAvailableAt(stored),
  })
  await tx
    .update(chargebacks)
    .set({ ledgerPostedAt: now() })
    .where(eq(chargebacks.id, chargeback.id))
  return { status: "posted", entryCount: mirror.lines.length }
}

/**
 * Keep a chargeback's dispute-fee pair in step with `chargebacks.fee_cents` (§9 "ledger entries
 * for every component"; CLAUDE.md §19.37): the fee is booked when Stripe withdraws it, whatever the
 * outcome, and taken back when Stripe returns it. Writes `stripe_fee +delta` / `adjustment −delta`
 * (user null, `chargeback_id` set) for the difference between the fee and what is already booked,
 * so it is idempotent. Waits (`order_not_posted`) until the sale is posted; `postOrderLedger` books
 * it then.
 */
export async function postDisputeFeeLedger(
  tx: Tx,
  input: { chargebackId: string },
): Promise<PostRefundLedgerResult> {
  const [found] = await tx
    .select({ orderId: chargebacks.orderId })
    .from(chargebacks)
    .where(eq(chargebacks.id, input.chargebackId))
  if (!found) throw new LedgerError("not_found", `chargeback ${input.chargebackId} not found`)
  const order = await lockOrder(tx, found.orderId)
  const [chargeback] = await tx
    .select()
    .from(chargebacks)
    .where(eq(chargebacks.id, input.chargebackId))
    .for("update")
  if (!chargeback) throw new LedgerError("not_found", `chargeback ${input.chargebackId} not found`)
  if (!order.ledgerPostedAt) return { status: "order_not_posted" }
  const [booked] = await tx
    .select({ cents: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)` })
    .from(ledgerEntries)
    .where(
      and(eq(ledgerEntries.chargebackId, chargeback.id), eq(ledgerEntries.account, "stripe_fee")),
    )
  const lines = disputeFeeLines(chargeback.feeCents - Number(booked?.cents ?? 0))
  if (lines.length === 0) return { status: "already_posted" }
  await insertLines(tx, lines, {
    orderId: order.id,
    chargebackId: chargeback.id,
    currency: order.currency,
    availableAt: now(),
  })
  return { status: "posted", entryCount: lines.length }
}

/**
 * A refund that failed after it had succeeded (Stripe can fail a refund later, §19.31): write the
 * mirror of its mirror (same `refund_id`), so its lines net to zero and the shares are payable
 * again. Idempotent: a refund whose lines already net to zero is `already_reversed`.
 */
export async function reverseRefundLedger(
  tx: Tx,
  input: { refundId: string },
): Promise<ReverseRefundLedgerResult> {
  const [found] = await tx
    .select({ orderId: refunds.orderId })
    .from(refunds)
    .where(eq(refunds.id, input.refundId))
  if (!found) throw new LedgerError("not_found", `refund ${input.refundId} not found`)
  await lockOrder(tx, found.orderId)

  const lines = await tx
    .select({
      account: ledgerEntries.account,
      userId: ledgerEntries.userId,
      amountCents: ledgerEntries.amountCents,
      currency: ledgerEntries.currency,
      availableAt: ledgerEntries.availableAt,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.refundId, input.refundId))
    .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id))
  if (lines.length === 0) return { status: "nothing_to_reverse" }
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0)
  if (total === 0) return { status: "already_reversed" }

  const at = now()
  const reversal = lines.map((line) => ({
    orderId: found.orderId,
    refundId: input.refundId,
    userId: line.userId,
    account: line.account,
    amountCents: -line.amountCents,
    currency: line.currency,
    availableAt: line.availableAt > at ? line.availableAt : at,
  }))
  assertLinesSum(reversal, -total, "refund reversal")
  await tx.insert(ledgerEntries).values(reversal)
  return { status: "reversed", entryCount: reversal.length }
}

// --- helpers ----------------------------------------------------------------------------------

async function lockOrder(tx: Tx, orderId: string) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
  if (!order) throw new LedgerError("not_found", `order ${orderId} not found`)
  return order
}

async function orderLines(tx: Tx, orderId: string) {
  return tx
    .select({
      account: ledgerEntries.account,
      userId: ledgerEntries.userId,
      amountCents: ledgerEntries.amountCents,
      refundId: ledgerEntries.refundId,
      chargebackId: ledgerEntries.chargebackId,
      availableAt: ledgerEntries.availableAt,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.orderId, orderId))
}

/** max(the sale lines' available_at, now): never earlier than the sale they mirror. */
function mirrorAvailableAt(
  stored: readonly { availableAt: Date; refundId: string | null; chargebackId: string | null }[],
): Date {
  let at = now()
  for (const line of stored) {
    if (line.refundId === null && line.chargebackId === null && line.availableAt > at) {
      at = line.availableAt
    }
  }
  return at
}

async function insertLines(
  tx: Tx,
  lines: readonly LedgerLine[],
  refs: {
    orderId: string
    refundId?: string
    chargebackId?: string
    currency: string
    availableAt: Date
  },
): Promise<void> {
  if (lines.length === 0) return
  await tx.insert(ledgerEntries).values(
    lines.map((line) => ({
      orderId: refs.orderId,
      refundId: refs.refundId ?? null,
      chargebackId: refs.chargebackId ?? null,
      userId: line.userId,
      account: line.account,
      amountCents: line.amountCents,
      currency: refs.currency,
      availableAt: refs.availableAt,
    })),
  )
}
