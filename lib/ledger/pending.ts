import "server-only"

import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { orders } from "@/lib/db/schema"
import { reportError } from "@/lib/observability"
import type { StripeGateway } from "@/lib/stripe/gateway"
import type { StripeBalanceTransaction } from "@/lib/stripe/money-shared"

import { postOrderLedger, type LedgerConfig } from "./post"

/**
 * The safety net of `ledger/post-pending` (hourly; CLAUDE.md §19.31, §19.33): orders paid more
 * than `minAgeMs` (1 h) ago whose sale is still unposted get their PaymentIntent retrieved with the
 * balance transaction, and `postOrderLedger` runs when the fee is known. Orders whose fee is still
 * pending wait for the next run. One transaction per order; a failing order is reported (ids only)
 * and counted, the others go on.
 */

export const POST_PENDING_BATCH_SIZE = 100

export type PostPendingResult = {
  checked: number
  posted: number
  /** The balance transaction does not exist yet. */
  waiting: number
  /** No PaymentIntent on the order (nothing to read the fee from). */
  skipped: number
  failed: number
}

type PendingGateway = Pick<
  StripeGateway,
  "retrievePaymentIntentWithBalanceTransaction" | "retrieveBalanceTransaction"
>

export async function postPendingOrders(
  db: DbOrTx,
  options: {
    gateway: PendingGateway
    at?: Date
    minAgeMs?: number
    batchSize?: number
    config?: LedgerConfig
  },
): Promise<PostPendingResult> {
  const at = options.at ?? now()
  const cutoff = new Date(at.getTime() - (options.minAgeMs ?? 60 * 60 * 1000))
  const batchSize = options.batchSize ?? POST_PENDING_BATCH_SIZE
  const result: PostPendingResult = { checked: 0, posted: 0, waiting: 0, skipped: 0, failed: 0 }

  let after: { paidAt: Date; id: string } | null = null
  for (;;) {
    const page: { id: string; paidAt: Date; paymentIntentId: string | null }[] = await db
      .select({
        id: orders.id,
        paidAt: orders.paidAt,
        paymentIntentId: orders.stripePaymentIntentId,
      })
      .from(orders)
      .where(
        and(
          isNull(orders.ledgerPostedAt),
          // Free orders (a 100 % discount) have nothing to post (CLAUDE.md §19.36).
          gt(orders.amountGrossCents, 0),
          lte(orders.paidAt, cutoff),
          after
            ? or(
                gt(orders.paidAt, after.paidAt),
                and(eq(orders.paidAt, after.paidAt), gt(orders.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(orders.paidAt), asc(orders.id))
      .limit(batchSize)
    if (page.length === 0) break

    for (const order of page) {
      result.checked += 1
      if (!order.paymentIntentId) {
        result.skipped += 1
        continue
      }
      try {
        const balanceTransaction = await balanceTransactionOf(
          options.gateway,
          order.paymentIntentId,
        )
        if (!balanceTransaction) {
          result.waiting += 1
          continue
        }
        const posted = await withTransaction(
          (tx) => postOrderLedger(tx, { orderId: order.id, balanceTransaction }, options.config),
          db,
        )
        if (posted.status === "posted") result.posted += 1
      } catch (error) {
        result.failed += 1
        reportError(error, {
          tags: { area: "ledger", job: "ledger-post-pending" },
          extra: { orderId: order.id },
        })
      }
    }

    const last = page[page.length - 1]
    if (!last || page.length < batchSize) break
    after = { paidAt: last.paidAt, id: last.id }
  }
  return result
}

/** The charge's balance transaction (expanded, or retrieved by id); null while still pending. */
async function balanceTransactionOf(
  gateway: PendingGateway,
  paymentIntentId: string,
): Promise<StripeBalanceTransaction | null> {
  const paymentIntent = await gateway.retrievePaymentIntentWithBalanceTransaction(paymentIntentId)
  const charge = paymentIntent.latest_charge
  if (!charge || typeof charge === "string") return null
  const field = charge.balance_transaction
  if (field === null) return null
  return typeof field === "string" ? gateway.retrieveBalanceTransaction(field) : field
}
