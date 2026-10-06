import { eq } from "drizzle-orm"

import type { Db } from "@/lib/db/client"
import { ledgerEntries, orders } from "@/lib/db/schema"
import type { LedgerConfig } from "@/lib/ledger/post"
import type { StripeBalanceTransaction } from "@/lib/stripe/money-shared"

import { insertLiveLaunch, insertOrder } from "../../helpers/db-fixtures"

/** Fixtures of the ledger integration tests (CLAUDE.md §19.33). */

export const CONFIG: LedgerConfig = { takeRateBps: 1000, holdDays: 14 }
export const PAID_AT = new Date("2026-09-01T10:00:00.000Z")
export const DAY_MS = 24 * 60 * 60 * 1000

let counter = 0

/** A balance transaction for a charge of `amount` with Stripe fee `fee`. */
export function balanceTransaction(
  amount: number,
  fee: number,
  currency = "eur",
): StripeBalanceTransaction {
  counter += 1
  return {
    id: `txn_test_${Date.now().toString(36)}_${counter}`,
    object: "balance_transaction",
    amount,
    fee,
    net: amount - fee,
    currency,
    fee_details: [{ amount: fee, currency, type: "stripe_fee" }],
    status: "pending",
    type: "charge",
    available_on: 0,
    created: 0,
  }
}

/** A live launch (60 % creator / 40 % builder) and a €19 order with 21 % VAT included. */
export async function saleFixture(db: Db, overrides: Partial<typeof orders.$inferInsert> = {}) {
  const launch = await insertLiveLaunch(db)
  counter += 1
  const order = await insertOrder(db, launch.launch.id, PAID_AT, {
    amountGrossCents: 1900,
    taxCents: 330,
    stripeFeeCents: 0,
    stripePaymentIntentId: `pi_test_${Date.now().toString(36)}_${counter}`,
    ...overrides,
  })
  return { ...launch, order }
}

export async function entriesOf(db: Db, orderId: string) {
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId))
}

export function total(rows: readonly { amountCents: number }[]): number {
  return rows.reduce((sum, row) => sum + row.amountCents, 0)
}

/** What the refund handler does next to `postRefundLedger` (payouts' job): the refunded amount. */
export async function addRefunded(db: Db, orderId: string, amount: number) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
  if (!order) throw new Error("no order")
  const refunded = order.amountRefundedCents + amount
  await db
    .update(orders)
    .set({
      amountRefundedCents: refunded,
      status: refunded === order.amountGrossCents ? "refunded" : "partially_refunded",
    })
    .where(eq(orders.id, orderId))
}
