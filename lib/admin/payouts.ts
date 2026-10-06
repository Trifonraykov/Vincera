import "server-only"

import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { orders, payoutBatches, refunds, transfers, users } from "@/lib/db/schema"
import type { PayoutBatchStatus, RefundStatus, TransferStatus } from "@/lib/db/schema/enums"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import { enqueue } from "@/lib/jobs/enqueue"
import { checkLedger } from "@/lib/ledger/check"
import type { LedgerCheckReport } from "@/lib/ledger/types"
import { applyStripeRefund } from "@/lib/refunds/apply"
import { runAfterCommit } from "@/lib/refunds/request"
import type { MoneyGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"

import { writeAdminAudit } from "./audit"

/**
 * /admin/payouts (Phase 6; CLAUDE.md §19.38, §19.35 open item): payout batches, failed and
 * pending transfers, stuck refunds, the reconciliation status, and the admin's money actions:
 *
 * - **Run payouts now** (`startPayoutRun`): a `manual:<uuid>` payout batch. It is how failed
 *   payouts are retried: a refused transfer released its entries (they are payable again), and a
 *   pending one left by a crash is resumed by any run (§19.35 "collect"). Idempotent where it
 *   matters: entries are marked with their transfer under a row lock, so nothing is paid twice.
 * - **Stuck refunds** (`pending`, no Stripe id, older than `STUCK_REFUND_MINUTES`: the app stopped
 *   between our insert and Stripe's answer): retry with the same idempotency key
 *   (`refund:<refundId>`), or cancel.
 */

export const STUCK_REFUND_MINUTES = 15

export const PAYOUT_ERRORS = {
  refundNotFound: "That refund doesn't exist.",
  refundNotStuck: "This refund isn't stuck: it is no longer pending, or Stripe already has it.",
  refundTooRecent: `Give a new refund ${STUCK_REFUND_MINUTES} minutes before retrying or cancelling it.`,
} as const

export type AdminPayoutsOverview = {
  batches: {
    id: string
    runKey: string
    status: PayoutBatchStatus
    startedAt: Date
    completedAt: Date | null
    transferCount: number
    totalCents: number
    failedCount: number
  }[]
  failedTransfers: TransferRow[]
  pendingTransfers: TransferRow[]
  stuckRefunds: {
    id: string
    orderId: string
    amountCents: number
    currency: string
    status: RefundStatus
    createdAt: Date
  }[]
}

export type TransferRow = {
  id: string
  userId: string
  userName: string
  amountCents: number
  currency: string
  status: TransferStatus
  failureCode: string | null
  createdAt: Date
  batchRunKey: string
}

async function transfersWith(
  db: DbOrTx,
  status: TransferStatus,
  since?: Date,
): Promise<TransferRow[]> {
  const rows = await db
    .select({
      id: transfers.id,
      userId: transfers.userId,
      userName: users.name,
      userEmail: users.email,
      amountCents: transfers.amountCents,
      currency: transfers.currency,
      status: transfers.status,
      failureCode: transfers.failureCode,
      createdAt: transfers.createdAt,
      batchRunKey: payoutBatches.runKey,
    })
    .from(transfers)
    .innerJoin(users, eq(users.id, transfers.userId))
    .innerJoin(payoutBatches, eq(payoutBatches.id, transfers.batchId))
    .where(and(eq(transfers.status, status), since ? gte(transfers.createdAt, since) : undefined))
    .orderBy(desc(transfers.createdAt))
    .limit(50)
  return rows.map(({ userEmail, userName, ...row }) => ({
    ...row,
    userName: userName ?? userEmail ?? "Deleted user",
  }))
}

export async function loadPayoutsOverview(
  db: DbOrTx,
  at: Date = now(),
): Promise<AdminPayoutsOverview> {
  const since = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000)
  const stuckBefore = new Date(at.getTime() - STUCK_REFUND_MINUTES * 60 * 1000)
  const [batches, failedTransfers, pendingTransfers, stuckRefunds] = await Promise.all([
    db
      .select({
        id: payoutBatches.id,
        runKey: payoutBatches.runKey,
        status: payoutBatches.status,
        startedAt: payoutBatches.startedAt,
        completedAt: payoutBatches.completedAt,
        transferCount: payoutBatches.transferCount,
        totalCents: payoutBatches.totalCents,
        failedCount: payoutBatches.failedCount,
      })
      .from(payoutBatches)
      .orderBy(desc(payoutBatches.startedAt))
      .limit(20),
    transfersWith(db, "failed", since),
    transfersWith(db, "pending"),
    db
      .select({
        id: refunds.id,
        orderId: refunds.orderId,
        amountCents: refunds.amountCents,
        currency: refunds.currency,
        status: refunds.status,
        createdAt: refunds.createdAt,
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, "pending"),
          isNull(refunds.stripeRefundId),
          lt(refunds.createdAt, stuckBefore),
        ),
      )
      .orderBy(asc(refunds.createdAt))
      .limit(50),
  ])
  return { batches, failedTransfers, pendingTransfers, stuckRefunds }
}

/** The database-only reconciliation (no Stripe calls while a page renders). */
export async function ledgerStatus(db: DbOrTx): Promise<LedgerCheckReport> {
  return checkLedger(db, { compareWithStripe: false })
}

/**
 * Start a manual payout run (`payouts/release.requested { runKey: manual:<uuid> }`); audited
 * `payouts.run_started`. With fake jobs the run happens right after the request.
 */
export async function startPayoutRun(db: DbOrTx, admin: AuthzUser): Promise<{ runKey: string }> {
  const runKey = `manual:${newId()}`
  await withTransaction(async (tx) => {
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "payouts.run_started",
      targetType: "payout_batch",
      targetId: null,
      before: null,
      after: { run_key: runKey },
    })
  }, db)
  await enqueue("payouts/release.requested", { runKey }, { id: runKey })
  return { runKey }
}

async function lockStuckRefund(tx: DbOrTx, refundId: string, at: Date) {
  const [found] = await tx
    .select({ orderId: refunds.orderId })
    .from(refunds)
    .where(eq(refunds.id, refundId))
  if (!found) throw new ActionError(PAYOUT_ERRORS.refundNotFound)
  // Lock order: the order first, then the refund (CLAUDE.md §19.33).
  const [order] = await tx
    .select({ id: orders.id, paymentIntentId: orders.stripePaymentIntentId })
    .from(orders)
    .where(eq(orders.id, found.orderId))
    .for("update")
  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for("update")
  if (!order || !refund) throw new ActionError(PAYOUT_ERRORS.refundNotFound)
  if (refund.status !== "pending" || refund.stripeRefundId !== null) {
    throw new ActionError(PAYOUT_ERRORS.refundNotStuck)
  }
  if (refund.createdAt.getTime() > at.getTime() - STUCK_REFUND_MINUTES * 60 * 1000) {
    throw new ActionError(PAYOUT_ERRORS.refundTooRecent)
  }
  return { order, refund }
}

/**
 * Retry a stuck refund at Stripe with its own idempotency key (`refund:<refundId>`): Stripe
 * answers with the refund it already made, or makes it now. The answer is applied like the
 * webhook would; a refusal marks it `failed`. Audited as `refund.requested` (retry).
 */
export async function retryStuckRefund(
  db: DbOrTx,
  admin: AuthzUser,
  input: { refundId: string },
  deps: { gateway: Pick<MoneyGateway, "createRefund"> },
): Promise<{ status: "applied" | "failed" }> {
  const prepared = await withTransaction(async (tx) => {
    const { order, refund } = await lockStuckRefund(tx, input.refundId, now())
    if (!order.paymentIntentId) throw new ActionError("This order has no card payment to refund.")
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "refund.requested",
      targetType: "refund",
      targetId: refund.id,
      before: { status: "pending" },
      after: { status: "pending", retry: true, amount_cents: refund.amountCents },
    })
    return { refund, paymentIntentId: order.paymentIntentId }
  }, db)

  let stripeRefund
  try {
    stripeRefund = await deps.gateway.createRefund(
      {
        paymentIntentId: prepared.paymentIntentId,
        amount: prepared.refund.amountCents,
        metadata: { refund_id: prepared.refund.id, order_ref: prepared.refund.orderId },
      },
      { idempotencyKey: `refund:${prepared.refund.id}` },
    )
  } catch (error) {
    if (!(error instanceof StripeGatewayError)) throw error
    await markRefundFailed(db, admin.id, prepared.refund.id, error.code)
    return { status: "failed" }
  }
  const tasks: (() => Promise<void> | void)[] = []
  await withTransaction(
    (tx) =>
      applyStripeRefund(tx, stripeRefund, {
        now: now(),
        afterCommit: (task) => {
          tasks.push(task)
        },
      }),
    db,
  )
  await runAfterCommit(tasks)
  return { status: "applied" }
}

async function markRefundFailed(
  db: DbOrTx,
  actorUserId: string,
  refundId: string,
  reason: string,
  status: "failed" | "canceled" = "failed",
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(refunds)
      .set({ status, failureReason: reason })
      .where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
      .returning()
    if (!row) return false
    await track(
      "refund.failed",
      {
        actorUserId,
        subjectType: "refund",
        subjectId: row.id,
        properties: {
          order_id: row.orderId,
          amount_cents: row.amountCents,
          currency: row.currency,
        },
      },
      tx,
    )
    return true
  }, db)
}

/**
 * Cancel a stuck refund: `canceled` (`refund.failed`), audit `refund.canceled`. Only for refunds
 * Stripe never answered; if Stripe did make it, its webhook records the refund by its Stripe id
 * (a dashboard-style row) and `ledger:check` compares the charge's refunded amount.
 */
export async function cancelStuckRefund(
  db: DbOrTx,
  admin: AuthzUser,
  input: { refundId: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const { refund } = await lockStuckRefund(tx, input.refundId, now())
    await tx
      .update(refunds)
      .set({ status: "canceled", failureReason: "canceled_by_admin" })
      .where(eq(refunds.id, refund.id))
    await track(
      "refund.failed",
      {
        actorUserId: admin.id,
        subjectType: "refund",
        subjectId: refund.id,
        properties: {
          order_id: refund.orderId,
          amount_cents: refund.amountCents,
          currency: refund.currency,
        },
      },
      tx,
    )
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "refund.canceled",
      targetType: "refund",
      targetId: refund.id,
      before: { status: "pending" },
      after: { status: "canceled", amount_cents: refund.amountCents },
    })
  }, db)
}

/** Count of transfers that failed in the last 30 days (overview). */
export async function recentFailedTransferCount(db: DbOrTx, at: Date = now()): Promise<number> {
  const since = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000)
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transfers)
    .where(and(eq(transfers.status, "failed"), gte(transfers.createdAt, since)))
  return row?.n ?? 0
}
