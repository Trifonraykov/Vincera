import "server-only"

import { and, eq, inArray, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { orders, refunds } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { reportError } from "@/lib/observability"
import type { MoneyGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"

import { applyStripeRefund, type ApplyRefundResult } from "./apply"

/**
 * Refund (part of) an order from the app (§9 "Refunds"; CLAUDE.md §19.31: `canRefundOrder`, admins
 * in the MVP; the admin screen is Phase 6, buyer requests v1). The caller authorizes.
 *
 * 1. One transaction: lock the order, check what is left to refund (succeeded and in-flight
 *    refunds count), insert the `refunds` row (`pending`, `requested_by_user_id`) and
 *    `refund.created { source: "app" }`.
 * 2. `createRefund` with the idempotency key `refund:<refundId>` and `metadata.refund_id`, so the
 *    webhook finds this row. A refusal marks it `failed` (`refund.failed`).
 * 3. The answer is applied at once (`applyStripeRefund`), so a refund that succeeded immediately
 *    (test mode, most cards) shows up without waiting for the webhook, which then changes nothing.
 */

export class RefundRequestError extends Error {
  readonly code: "not_found" | "not_refundable" | "too_much" | "no_payment"

  constructor(code: RefundRequestError["code"], message: string) {
    super(message)
    this.name = "RefundRequestError"
    this.code = code
  }
}

export type RequestRefundResult =
  | { status: "refused"; refundId: string; failureCode: string }
  | { status: "requested"; refundId: string; applied: ApplyRefundResult }

/** Run queued side effects after a commit; failures are reported, never thrown. */
export async function runAfterCommit(tasks: readonly (() => Promise<void> | void)[]) {
  for (const task of tasks) {
    try {
      await task()
    } catch (error) {
      reportError(error, { tags: { area: "refunds", phase: "after_commit" } })
    }
  }
}

export async function requestRefund(
  db: DbOrTx,
  input: {
    orderId: string
    /** Integer cents; default: everything still refundable. */
    amountCents?: number
    requestedByUserId: string
    reason?: "duplicate" | "fraudulent" | "requested_by_customer"
  },
  deps: { gateway: Pick<MoneyGateway, "createRefund"> },
): Promise<RequestRefundResult> {
  const prepared = await withTransaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update")
    if (!order) throw new RefundRequestError("not_found", "This order doesn't exist.")
    if (order.status === "disputed") {
      throw new RefundRequestError(
        "not_refundable",
        "The buyer opened a chargeback on this order, so it can't be refunded now.",
      )
    }
    if (!order.stripePaymentIntentId) {
      throw new RefundRequestError("no_payment", "This order has no card payment to refund.")
    }
    const [inFlight] = await tx
      .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
      .from(refunds)
      .where(
        and(eq(refunds.orderId, order.id), inArray(refunds.status, ["pending", "requires_action"])),
      )
    const left = order.amountGrossCents - order.amountRefundedCents - (inFlight?.cents ?? 0)
    const amount = input.amountCents ?? left
    if (!Number.isSafeInteger(amount) || amount <= 0 || left <= 0) {
      throw new RefundRequestError("not_refundable", "Nothing is left to refund on this order.")
    }
    if (amount > left) {
      throw new RefundRequestError(
        "too_much",
        "That's more than what is left to refund on this order.",
      )
    }

    const [row] = await tx
      .insert(refunds)
      .values({
        orderId: order.id,
        amountCents: amount,
        currency: order.currency,
        status: "pending",
        reason: input.reason ?? null,
        requestedByUserId: input.requestedByUserId,
      })
      .returning()
    if (!row) throw new Error("refund row not inserted")
    await track(
      "refund.created",
      {
        actorUserId: input.requestedByUserId,
        subjectType: "refund",
        subjectId: row.id,
        properties: {
          order_id: order.id,
          amount_cents: amount,
          currency: order.currency,
          source: "app",
        },
      },
      tx,
    )
    return { refundId: row.id, paymentIntentId: order.stripePaymentIntentId, amount }
  }, db)

  let stripeRefund
  try {
    stripeRefund = await deps.gateway.createRefund(
      {
        paymentIntentId: prepared.paymentIntentId,
        amount: prepared.amount,
        reason: input.reason,
        metadata: { refund_id: prepared.refundId, order_ref: input.orderId },
      },
      { idempotencyKey: `refund:${prepared.refundId}` },
    )
  } catch (error) {
    if (!(error instanceof StripeGatewayError)) throw error
    await withTransaction(async (tx) => {
      const [failed] = await tx
        .update(refunds)
        .set({ status: "failed", failureReason: error.code })
        .where(and(eq(refunds.id, prepared.refundId), eq(refunds.status, "pending")))
        .returning()
      if (failed) {
        await track(
          "refund.failed",
          {
            actorUserId: input.requestedByUserId,
            subjectType: "refund",
            subjectId: failed.id,
            properties: {
              order_id: failed.orderId,
              amount_cents: failed.amountCents,
              currency: failed.currency,
            },
          },
          tx,
        )
      }
    }, db)
    return { status: "refused", refundId: prepared.refundId, failureCode: error.code }
  }

  const tasks: (() => Promise<void> | void)[] = []
  const applied = await withTransaction(
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
  return { status: "requested", refundId: prepared.refundId, applied }
}
