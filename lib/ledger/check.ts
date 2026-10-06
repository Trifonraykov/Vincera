import "server-only"

import { and, asc, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import {
  chargebacks,
  ledgerAdjustments,
  ledgerEntries,
  orders,
  refunds,
  transferReversals,
  transfers,
} from "@/lib/db/schema"
import type { CheckoutGateway, MoneyGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"
import { stripeIdOf } from "@/lib/stripe/ids"

import type { LedgerCheckMismatch, LedgerCheckReport } from "./types"

/**
 * Reconciliation (§9 `pnpm ledger:check`; CLAUDE.md §19.31 "Invariants", §19.33, §19.37).
 * Read-only.
 *
 * - every order: Σ entries = gross − succeeded refunds − lost chargebacks once posted (a dispute
 *   after a refund can take the order below zero: the platform's loss), 0 before; and
 *   `amount_refunded_cents` = min(gross, succeeded refunds + lost chargebacks);
 * - orders paid more than `postingGraceHours` (24) ago are posted;
 * - every transfer: Σ entries marked with it = amount − reversed (0 for a failed transfer, whose
 *   entries were released); no transfer or reversal is still `pending` after a day;
 * - every posted refund: Σ its entries = −amount while succeeded, 0 once it failed or was
 *   canceled (and nothing before it is posted); every lost, posted chargeback: −amount;
 * - every admin ledger adjustment (Phase 6): Σ its entries = 0;
 * - with `compareWithStripe`, both directions:
 *   - every transfer Stripe knows (`created`, `reversed`, `partially_reversed`) matches Stripe's
 *     amount, amount reversed and destination, and is the only one in its `transfer_group`;
 *   - every transfer Stripe made in the last `stripeWindowDays` (35) has a row of ours;
 *   - every order with a charge paid in the last `stripeOrderWindowDays` (120, the dispute
 *     window): Stripe's `amount_refunded` = our succeeded refunds, and a disputed charge has a
 *     chargeback row (one Stripe read per order).
 *
 * Not checked: how a sale was split between members (the take rate may have changed since; the
 * split is unit- and property-tested in lib/ledger/split.ts).
 *
 * Mismatches carry ids and amounts only. The caller decides what to do with them (the script
 * exits 1, the daily job reports them to Sentry).
 */
export type LedgerCheckGateway = Pick<MoneyGateway, "listTransfersByGroup" | "listTransfers"> &
  Pick<CheckoutGateway, "retrieveCharge">

const DAY_MS = 24 * 60 * 60 * 1000

export async function checkLedger(
  db: DbOrTx,
  options: {
    compareWithStripe?: boolean
    /** Required with `compareWithStripe`. */
    gateway?: LedgerCheckGateway
    postingGraceHours?: number
    stripeWindowDays?: number
    stripeOrderWindowDays?: number
    at?: Date
  } = {},
): Promise<LedgerCheckReport> {
  const at = options.at ?? now()
  const graceMs = (options.postingGraceHours ?? 24) * 60 * 60 * 1000
  const mismatches: LedgerCheckMismatch[] = []

  // --- Orders ---------------------------------------------------------------------------------
  const orderRows = await db
    .select({
      id: orders.id,
      gross: orders.amountGrossCents,
      refunded: orders.amountRefundedCents,
      paidAt: orders.paidAt,
      posted: sql<boolean>`${orders.ledgerPostedAt} IS NOT NULL`,
      actual: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
      // Succeeded refunds plus lost chargebacks (what Stripe took back from the platform).
      takenBack: sql<string>`(
        SELECT coalesce(sum(r.amount_cents), 0) FROM ${refunds} r
        WHERE r.order_id = "orders"."id" AND r.status = 'succeeded'
      ) + (
        SELECT coalesce(sum(c.amount_cents), 0) FROM ${chargebacks} c
        WHERE c.order_id = "orders"."id" AND c.status = 'lost'
      )`,
    })
    .from(orders)
    .leftJoin(ledgerEntries, eq(ledgerEntries.orderId, orders.id))
    .groupBy(orders.id)
    .orderBy(asc(orders.id))

  for (const order of orderRows) {
    const actual = Number(order.actual)
    const takenBack = Number(order.takenBack)
    const expectedRefunded = Math.min(order.gross, takenBack)
    if (order.refunded !== expectedRefunded) {
      mismatches.push({
        kind: "order_refunded",
        orderId: order.id,
        expectedCents: expectedRefunded,
        actualCents: order.refunded,
      })
    }
    if (order.posted) {
      const expected = order.gross - takenBack
      if (actual !== expected) {
        mismatches.push({
          kind: "order_sum",
          orderId: order.id,
          expectedCents: expected,
          actualCents: actual,
        })
      }
      continue
    }
    if (actual !== 0) {
      mismatches.push({
        kind: "order_sum",
        orderId: order.id,
        detail: "entries before the sale was posted",
        expectedCents: 0,
        actualCents: actual,
      })
    }
    // A free order (gross 0, a 100 % discount: no payment, no balance transaction) is never
    // posted and needs no entries (CLAUDE.md §19.36).
    if (order.gross > 0 && at.getTime() - order.paidAt.getTime() > graceMs) {
      mismatches.push({
        kind: "order_not_posted",
        orderId: order.id,
        expectedCents: order.gross,
        actualCents: 0,
      })
    }
  }

  // --- Refunds and chargebacks ------------------------------------------------------------------
  const refundRows = await db
    .select({
      id: refunds.id,
      orderId: refunds.orderId,
      amount: refunds.amountCents,
      status: refunds.status,
      posted: sql<boolean>`${refunds.ledgerPostedAt} IS NOT NULL`,
      count: sql<number>`count(${ledgerEntries.id})::int`,
      actual: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(refunds)
    .leftJoin(ledgerEntries, eq(ledgerEntries.refundId, refunds.id))
    .groupBy(refunds.id)
    .orderBy(asc(refunds.id))
  for (const refund of refundRows) {
    const actual = Number(refund.actual)
    const reversedAway = refund.status === "failed" || refund.status === "canceled"
    const expected = refund.posted && !reversedAway ? -refund.amount : 0
    if (actual !== expected) {
      mismatches.push({
        kind: "refund_sum",
        refundId: refund.id,
        orderId: refund.orderId,
        detail: `status ${refund.status}${refund.posted ? ", posted" : ", not posted"}`,
        expectedCents: expected,
        actualCents: actual,
      })
    }
  }

  const chargebackRows = await db
    .select({
      id: chargebacks.id,
      orderId: chargebacks.orderId,
      amount: chargebacks.amountCents,
      posted: sql<boolean>`${chargebacks.ledgerPostedAt} IS NOT NULL`,
      actual: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(chargebacks)
    .leftJoin(ledgerEntries, eq(ledgerEntries.chargebackId, chargebacks.id))
    .groupBy(chargebacks.id)
    .orderBy(asc(chargebacks.id))
  for (const chargeback of chargebackRows) {
    const actual = Number(chargeback.actual)
    const expected = chargeback.posted ? -chargeback.amount : 0
    if (actual !== expected) {
      mismatches.push({
        kind: "chargeback_sum",
        chargebackId: chargeback.id,
        orderId: chargeback.orderId,
        expectedCents: expected,
        actualCents: actual,
      })
    }
  }

  // --- Admin adjustments (Phase 6, CLAUDE.md §19.38): every one sums to zero ----------------------
  const adjustmentRows = await db
    .select({
      id: ledgerAdjustments.id,
      orderId: ledgerAdjustments.orderId,
      actual: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerAdjustments)
    .leftJoin(ledgerEntries, eq(ledgerEntries.adjustmentId, ledgerAdjustments.id))
    .groupBy(ledgerAdjustments.id)
    .having(sql`coalesce(sum(${ledgerEntries.amountCents}), 0) <> 0`)
    .orderBy(asc(ledgerAdjustments.id))
  for (const adjustment of adjustmentRows) {
    mismatches.push({
      kind: "adjustment_sum",
      adjustmentId: adjustment.id,
      ...(adjustment.orderId ? { orderId: adjustment.orderId } : {}),
      expectedCents: 0,
      actualCents: Number(adjustment.actual),
    })
  }

  // --- Transfers ------------------------------------------------------------------------------
  const transferRows = await db
    .select({
      id: transfers.id,
      status: transfers.status,
      amount: transfers.amountCents,
      reversed: transfers.amountReversedCents,
      actual: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(transfers)
    .leftJoin(ledgerEntries, eq(ledgerEntries.transferId, transfers.id))
    .groupBy(transfers.id)
    .orderBy(asc(transfers.id))
  for (const transfer of transferRows) {
    const actual = Number(transfer.actual)
    const expected = transfer.status === "failed" ? 0 : transfer.amount - transfer.reversed
    if (actual !== expected) {
      mismatches.push({
        kind: "transfer_sum",
        transferId: transfer.id,
        detail: `status ${transfer.status}`,
        expectedCents: expected,
        actualCents: actual,
      })
    }
  }

  // --- Stuck in flight ------------------------------------------------------------------------
  const dayAgo = new Date(at.getTime() - DAY_MS)
  const stalePending = await db
    .select({ id: transfers.id, amount: transfers.amountCents })
    .from(transfers)
    .where(and(eq(transfers.status, "pending"), lt(transfers.createdAt, dayAgo)))
    .orderBy(asc(transfers.id))
  for (const transfer of stalePending) {
    mismatches.push({
      kind: "transfer_pending",
      transferId: transfer.id,
      detail: "pending for more than a day",
      expectedCents: transfer.amount,
      actualCents: 0,
    })
  }
  const staleReversals = await db
    .select({
      id: transferReversals.id,
      transferId: transferReversals.transferId,
      amount: transferReversals.amountCents,
    })
    .from(transferReversals)
    .where(and(eq(transferReversals.status, "pending"), lt(transferReversals.createdAt, dayAgo)))
    .orderBy(asc(transferReversals.id))
  for (const reversal of staleReversals) {
    mismatches.push({
      kind: "reversal_pending",
      reversalId: reversal.id,
      transferId: reversal.transferId,
      detail: "pending for more than a day",
      expectedCents: reversal.amount,
      actualCents: 0,
    })
  }

  if (options.compareWithStripe) {
    if (!options.gateway) throw new Error("checkLedger: compareWithStripe needs a gateway")
    mismatches.push(...(await compareTransfersWithStripe(db, options.gateway)))
    mismatches.push(
      ...(await findUnknownStripeTransfers(db, options.gateway, {
        createdFrom: new Date(at.getTime() - (options.stripeWindowDays ?? 35) * DAY_MS),
      })),
    )
    mismatches.push(
      ...(await compareOrdersWithStripe(db, options.gateway, {
        paidFrom: new Date(at.getTime() - (options.stripeOrderWindowDays ?? 120) * DAY_MS),
      })),
    )
  }

  return {
    ordersChecked: orderRows.length,
    transfersChecked: transferRows.length,
    mismatches,
  }
}

/** Our transfers that Stripe has (created, reversed, partially reversed) against Stripe's copy. */
async function compareTransfersWithStripe(
  db: DbOrTx,
  gateway: Pick<MoneyGateway, "listTransfersByGroup">,
): Promise<LedgerCheckMismatch[]> {
  const rows = await db
    .select({
      id: transfers.id,
      stripeTransferId: transfers.stripeTransferId,
      amount: transfers.amountCents,
      reversed: transfers.amountReversedCents,
      currency: transfers.currency,
      destination: transfers.destinationAccountId,
    })
    .from(transfers)
    .where(and(isNotNull(transfers.stripeTransferId), ne(transfers.status, "failed")))
    .orderBy(asc(transfers.id))

  const mismatches: LedgerCheckMismatch[] = []
  for (const row of rows) {
    const group = await gateway.listTransfersByGroup(`payout_${row.id}`)
    const others = group.filter((transfer) => transfer.id !== row.stripeTransferId)
    if (others.length > 0) {
      // One transfer per group: another one is a double payout.
      mismatches.push({
        kind: "transfer_stripe",
        transferId: row.id,
        detail: `${group.length} transfers at Stripe in its group (${others.map((t) => t.id).join(", ")})`,
        expectedCents: row.amount,
        actualCents: group.reduce((sum, transfer) => sum + transfer.amount, 0),
      })
    }
    const atStripe = group.find((transfer) => transfer.id === row.stripeTransferId)
    if (!atStripe) {
      mismatches.push({
        kind: "transfer_stripe",
        transferId: row.id,
        detail: `missing at Stripe (${row.stripeTransferId})`,
        expectedCents: row.amount,
        actualCents: 0,
      })
      continue
    }
    const differences: string[] = []
    if (atStripe.amount !== row.amount) differences.push("amount")
    if (atStripe.amount_reversed !== row.reversed) differences.push("amount_reversed")
    if (atStripe.currency !== row.currency) differences.push("currency")
    if (stripeIdOf(atStripe.destination) !== row.destination) differences.push("destination")
    if (differences.length > 0) {
      mismatches.push({
        kind: "transfer_stripe",
        transferId: row.id,
        detail: differences.join(", "),
        expectedCents: atStripe.amount - atStripe.amount_reversed,
        actualCents: row.amount - row.reversed,
      })
    }
  }
  return mismatches
}

/** Transfers Stripe made in the window that no row of ours records (Stripe against us). */
async function findUnknownStripeTransfers(
  db: DbOrTx,
  gateway: Pick<MoneyGateway, "listTransfers">,
  window: { createdFrom: Date },
): Promise<LedgerCheckMismatch[]> {
  const atStripe = await gateway.listTransfers({ createdFrom: window.createdFrom })
  if (atStripe.length === 0) return []
  const known = await db
    .select({ stripeTransferId: transfers.stripeTransferId })
    .from(transfers)
    .where(isNotNull(transfers.stripeTransferId))
  const ours = new Set(known.map((row) => row.stripeTransferId))
  return atStripe
    .filter((transfer) => !ours.has(transfer.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((transfer) => ({
      kind: "transfer_unknown" as const,
      stripeId: transfer.id,
      detail: transfer.metadata?.transfer_id
        ? `metadata transfer_id ${transfer.metadata.transfer_id}`
        : "no row of ours",
      expectedCents: 0,
      actualCents: transfer.amount,
    }))
}

/**
 * Orders paid in the window against their charge at Stripe: refunds we never recorded (e.g. a
 * dashboard refund whose event was lost) and disputes we have no chargeback for.
 */
async function compareOrdersWithStripe(
  db: DbOrTx,
  gateway: Pick<CheckoutGateway, "retrieveCharge">,
  window: { paidFrom: Date },
): Promise<LedgerCheckMismatch[]> {
  const rows = await db
    .select({
      id: orders.id,
      chargeId: orders.stripeChargeId,
      refunds: sql<string>`(
        SELECT coalesce(sum(r.amount_cents), 0) FROM ${refunds} r
        WHERE r.order_id = "orders"."id" AND r.status = 'succeeded'
      )`,
      chargebacks: sql<number>`(
        SELECT count(*)::int FROM ${chargebacks} c WHERE c.order_id = "orders"."id"
      )`,
    })
    .from(orders)
    .where(and(isNotNull(orders.stripeChargeId), gte(orders.paidAt, window.paidFrom)))
    .orderBy(asc(orders.id))
  const mismatches: LedgerCheckMismatch[] = []
  for (const row of rows) {
    if (!row.chargeId) continue
    let charge
    try {
      charge = await gateway.retrieveCharge(row.chargeId)
    } catch (error) {
      if (error instanceof StripeGatewayError && error.code === "resource_missing") {
        mismatches.push({
          kind: "order_stripe",
          orderId: row.id,
          detail: `charge missing at Stripe (${row.chargeId})`,
          expectedCents: 0,
          actualCents: 0,
        })
        continue
      }
      throw error
    }
    const recorded = Number(row.refunds)
    if (charge.amount_refunded !== recorded) {
      mismatches.push({
        kind: "order_stripe",
        orderId: row.id,
        detail: "refunded amount",
        expectedCents: charge.amount_refunded,
        actualCents: recorded,
      })
    }
    if (charge.disputed === true && row.chargebacks === 0) {
      mismatches.push({
        kind: "order_stripe",
        orderId: row.id,
        detail: "disputed at Stripe, no chargeback recorded",
        expectedCents: 0,
        actualCents: 0,
      })
    }
  }
  return mismatches
}

/** A plain-text report for the script and logs (ids and amounts only). */
export function formatLedgerReport(report: LedgerCheckReport): string {
  const head = `Checked ${report.ordersChecked} orders and ${report.transfersChecked} transfers.`
  if (report.mismatches.length === 0) return `${head}\nThe ledger balances.`
  const lines = report.mismatches.map((m) => {
    const ids = [
      m.orderId && `order ${m.orderId}`,
      m.refundId && `refund ${m.refundId}`,
      m.chargebackId && `chargeback ${m.chargebackId}`,
      m.adjustmentId && `adjustment ${m.adjustmentId}`,
      m.transferId && `transfer ${m.transferId}`,
      m.reversalId && `reversal ${m.reversalId}`,
      m.stripeId && `Stripe ${m.stripeId}`,
    ]
      .filter(Boolean)
      .join(", ")
    const detail = m.detail ? ` (${m.detail})` : ""
    return `- ${m.kind}: ${ids}: expected ${m.expectedCents}, found ${m.actualCents}${detail}`
  })
  return `${head}\n${report.mismatches.length} mismatch(es):\n${lines.join("\n")}`
}
