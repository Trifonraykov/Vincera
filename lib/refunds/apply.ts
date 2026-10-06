import "server-only"

import { and, desc, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm"

import type { Tx } from "@/lib/db/client"
import { accessGrants, orders, refunds } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { enqueue } from "@/lib/jobs/enqueue"
import { LedgerError } from "@/lib/ledger/errors"
import { postRefundLedger, reverseRefundLedger } from "@/lib/ledger/post"
import {
  isOurCheckoutPayment,
  OrderNotRecordedYetError,
  type PaymentRefs,
} from "@/lib/orders/unrecorded-payment"
import type { CheckoutGateway } from "@/lib/stripe/gateway"
import { stripeIdOf } from "@/lib/stripe/ids"
import type { StripeRefund } from "@/lib/stripe/money-shared"

import {
  isFailedRefundStatus,
  mapStripeRefundStatus,
  orderStatusFor,
  refundStatusMayMove,
  type MappedRefundStatus,
} from "./status"

/**
 * Apply a Stripe refund to the platform (§9 "Refunds"; CLAUDE.md §19.31 "Refunds and
 * chargebacks", §19.35). Called by the `refund.*` / `charge.refunded` webhook handlers and right
 * after `requestRefund`, inside the caller's transaction. Idempotent on the refund: the row is
 * found by `stripe_refund_id`, else by `metadata.refund_id` (a refund the app started), else it is
 * created (a refund made in Stripe's dashboard, `refund.created { source: "stripe" }`).
 *
 * Lock order (§19.33): the order first, then the refund row.
 *
 * - Becoming `succeeded` (once): `amount_refunded_cents` and the order status, the mirror entries
 *   (`postRefundLedger`; waits for the sale's entries when those are not posted yet), the access
 *   grant revoked on a full refund, `order.refunded`; after the commit `payouts/reverse` (claw back
 *   what was already paid out) and `refunds/succeeded` (buyer confirmation, members' notices).
 * - `succeeded` → `failed` / `canceled` (Stripe failed it later): the refunded amount goes back
 *   down, the mirror of the mirror is written (`reverseRefundLedger`), access comes back if it was
 *   ended by this refund, `refund.failed`.
 * - `pending` → `failed` / `canceled`: `refund.failed` only.
 * - Older events never move a status backwards (`refundStatusMayMove`).
 */

export type ApplyRefundContext = {
  /** Side effects after the commit (the webhook's `afterCommit`, or the caller's own list). */
  afterCommit: (task: () => Promise<void> | void) => void
  now: Date
  /** For telling our payments apart when no order matches (default: `getStripeGateway()`). */
  gateway?: Pick<CheckoutGateway, "retrieveCharge" | "retrievePaymentIntentWithBalanceTransaction">
}

export type ApplyRefundResult =
  | { status: "unknown_order" }
  | {
      status: "applied"
      refundId: string
      created: boolean
      from: MappedRefundStatus | null
      to: MappedRefundStatus
    }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function applyStripeRefund(
  tx: Tx,
  refund: StripeRefund,
  context: ApplyRefundContext,
): Promise<ApplyRefundResult> {
  const order = await lockOrderOf(tx, refund)
  if (!order) {
    // Our payment whose order is not recorded yet: fail so Stripe retries (CLAUDE.md §19.37).
    const refs: PaymentRefs = {
      chargeId: stripeIdOf(refund.charge),
      paymentIntentId: stripeIdOf(refund.payment_intent),
    }
    if (await isOurCheckoutPayment(tx, refs, context.gateway)) {
      throw new OrderNotRecordedYetError(`refund ${refund.id}`)
    }
    return { status: "unknown_order" }
  }

  const next = mapStripeRefundStatus(refund.status)
  let row = await lockRefundRow(tx, order.id, refund)
  let created = false

  if (!row) {
    const [inserted] = await tx
      .insert(refunds)
      .values({
        orderId: order.id,
        amountCents: refund.amount,
        currency: refund.currency,
        stripeRefundId: refund.id,
        status: "pending",
        reason: refund.reason ?? null,
      })
      .onConflictDoNothing({ target: refunds.stripeRefundId })
      .returning()
    row = inserted ?? (await lockRefundRow(tx, order.id, refund))
    if (!row) throw new Error(`refund ${refund.id} could not be recorded`)
    if (inserted) {
      created = true
      await track(
        "refund.created",
        {
          actorUserId: null,
          subjectType: "refund",
          subjectId: inserted.id,
          properties: {
            order_id: order.id,
            amount_cents: inserted.amountCents,
            currency: inserted.currency,
            source: "stripe",
          },
        },
        tx,
      )
    }
  }

  const from = row.status
  const moves = refundStatusMayMove(from, next)
  if (row.stripeRefundId === null || moves) {
    await tx
      .update(refunds)
      .set({
        stripeRefundId: row.stripeRefundId ?? refund.id,
        ...(moves
          ? {
              status: next,
              failureReason: isFailedRefundStatus(next) ? (refund.failure_reason ?? null) : null,
            }
          : {}),
      })
      .where(eq(refunds.id, row.id))
  }
  if (!moves) {
    return { status: "applied", refundId: row.id, created, from, to: from }
  }

  if (next === "succeeded") {
    await onSucceeded(tx, { order, refundId: row.id, amountCents: row.amountCents }, context)
  } else if (from === "succeeded" && isFailedRefundStatus(next)) {
    await onFailedAfterSuccess(tx, { order, refundId: row.id, amountCents: row.amountCents })
  } else if (isFailedRefundStatus(next)) {
    await trackRefundFailed(tx, { orderId: order.id, refundId: row.id, row })
  }
  return { status: "applied", refundId: row.id, created, from: created ? null : from, to: next }
}

type LockedOrder = typeof orders.$inferSelect

async function lockOrderOf(tx: Tx, refund: StripeRefund): Promise<LockedOrder | null> {
  const chargeId = stripeIdOf(refund.charge)
  const paymentIntentId = stripeIdOf(refund.payment_intent)
  const orderRef = refund.metadata?.order_ref
  const matches: SQL[] = []
  if (chargeId) matches.push(eq(orders.stripeChargeId, chargeId))
  if (paymentIntentId) matches.push(eq(orders.stripePaymentIntentId, paymentIntentId))
  if (orderRef && UUID.test(orderRef)) matches.push(eq(orders.id, orderRef))
  if (matches.length === 0) return null
  const [order] = await tx
    .select()
    .from(orders)
    .where(or(...matches))
    .limit(1)
    .for("update")
  return order ?? null
}

async function lockRefundRow(tx: Tx, orderId: string, refund: StripeRefund) {
  const [byStripeId] = await tx
    .select()
    .from(refunds)
    .where(eq(refunds.stripeRefundId, refund.id))
    .for("update")
  if (byStripeId) return byStripeId
  const ours = refund.metadata?.refund_id
  if (!ours || !UUID.test(ours)) return null
  const [byMetadata] = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, ours), eq(refunds.orderId, orderId)))
    .for("update")
  return byMetadata ?? null
}

async function onSucceeded(
  tx: Tx,
  input: { order: LockedOrder; refundId: string; amountCents: number },
  context: ApplyRefundContext,
): Promise<void> {
  const { order, refundId, amountCents } = input
  const refunded = order.amountRefundedCents + amountCents
  if (refunded > order.amountGrossCents) {
    throw new LedgerError(
      "over_refund",
      `refund ${refundId}: ${refunded} refunded of order ${order.id} (gross ${order.amountGrossCents})`,
    )
  }
  const full = refunded === order.amountGrossCents
  await tx
    .update(orders)
    .set({
      amountRefundedCents: refunded,
      status: orderStatusFor({
        grossCents: order.amountGrossCents,
        refundedCents: refunded,
        disputed: order.status === "disputed",
      }),
    })
    .where(eq(orders.id, order.id))
  // Posts now, or later with the sale's entries (`order_not_posted`).
  await postRefundLedger(tx, { refundId })
  if (full) {
    await tx
      .update(accessGrants)
      .set({ revokedAt: context.now })
      .where(and(eq(accessGrants.orderId, order.id), isNull(accessGrants.revokedAt)))
  }
  await track(
    "order.refunded",
    {
      actorUserId: null,
      subjectType: "order",
      subjectId: order.id,
      properties: {
        launch_id: order.launchId,
        refund_id: refundId,
        amount_cents: amountCents,
        currency: order.currency,
        full,
      },
    },
    tx,
  )
  context.afterCommit(() =>
    enqueue(
      "payouts/reverse.requested",
      { cause: "refund", id: refundId },
      {
        id: `reverse:refund:${refundId}`,
      },
    ),
  )
  context.afterCommit(() =>
    enqueue("refunds/succeeded.requested", { refundId }, { id: `refund-succeeded:${refundId}` }),
  )
}

async function onFailedAfterSuccess(
  tx: Tx,
  input: { order: LockedOrder; refundId: string; amountCents: number },
): Promise<void> {
  const { order, refundId, amountCents } = input
  const refunded = Math.max(0, order.amountRefundedCents - amountCents)
  await tx
    .update(orders)
    .set({
      amountRefundedCents: refunded,
      status: orderStatusFor({
        grossCents: order.amountGrossCents,
        refundedCents: refunded,
        disputed: order.status === "disputed",
      }),
    })
    .where(eq(orders.id, order.id))
  await reverseRefundLedger(tx, { refundId })

  // The buyer kept paying after all: give access back when this refund had ended it.
  if (order.amountRefundedCents === order.amountGrossCents && refunded < order.amountGrossCents) {
    await restoreAccess(tx, order.id)
  }
  const [row] = await tx.select().from(refunds).where(eq(refunds.id, refundId))
  if (row) await trackRefundFailed(tx, { orderId: order.id, refundId, row })
}

async function restoreAccess(tx: Tx, orderId: string): Promise<void> {
  const [active] = await tx
    .select({ id: accessGrants.id })
    .from(accessGrants)
    .where(and(eq(accessGrants.orderId, orderId), isNull(accessGrants.revokedAt)))
  if (active) return
  const [latest] = await tx
    .select({ id: accessGrants.id })
    .from(accessGrants)
    .where(and(eq(accessGrants.orderId, orderId), isNotNull(accessGrants.revokedAt)))
    .orderBy(desc(accessGrants.revokedAt))
    .limit(1)
  if (latest) {
    await tx.update(accessGrants).set({ revokedAt: null }).where(eq(accessGrants.id, latest.id))
  }
}

async function trackRefundFailed(
  tx: Tx,
  input: { orderId: string; refundId: string; row: { amountCents: number; currency: string } },
): Promise<void> {
  await track(
    "refund.failed",
    {
      actorUserId: null,
      subjectType: "refund",
      subjectId: input.refundId,
      properties: {
        order_id: input.orderId,
        amount_cents: input.row.amountCents,
        currency: input.row.currency,
      },
    },
    tx,
  )
}
