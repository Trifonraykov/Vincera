import "server-only"

import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm"

import { getDb, type Tx } from "@/lib/db/client"
import { accessGrants, chargebacks, orders } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { enqueue } from "@/lib/jobs/enqueue"
import { postChargebackLedger, postDisputeFeeLedger } from "@/lib/ledger/post"
import { isOurCheckoutPayment, OrderNotRecordedYetError } from "@/lib/orders/unrecorded-payment"
import { chargebackOutcome, orderStatusFor } from "@/lib/refunds/status"
import type { CheckoutGateway } from "@/lib/stripe/gateway"
import { stripeIdOf } from "@/lib/stripe/ids"
import type { StripeDispute } from "@/lib/stripe/money-shared"

import { notifyChargebackOpened } from "./notify"

/**
 * Apply a Stripe dispute (chargeback) to the platform (§9 "Disputes (chargebacks)"; CLAUDE.md
 * §19.31, §19.35). Called by every `charge.dispute.*` handler inside the webhook transaction;
 * idempotent on `stripe_dispute_id`. Lock order: the order first, then the chargeback.
 *
 * - First sight (whatever the event): the `chargebacks` row (`open`), the order → `disputed`
 *   (its untransferred entries are left out of payouts: the "freeze", §19.5), `order.disputed`;
 *   after the commit the members' `order.disputed` and the admins' `admin.chargeback_opened`
 *   notices.
 * - Every event: the dispute fee Stripe withdrew (or returned) is booked as a platform pair
 *   (`postDisputeFeeLedger`, CLAUDE.md §19.37), whatever the outcome.
 * - Closed `won` (also `warning_closed` / `prevented`): `won`, the order's status from its refunded
 *   amount again (unless another chargeback on it is still open), `chargeback.closed`. Its
 *   entries are payable again.
 * - Closed `lost`: `lost`, the mirror entries capped at what is left of the order plus a platform
 *   `adjustment` for any excess (`postChargebackLedger`), the amount added to
 *   `amount_refunded_cents` (at most up to gross), access revoked when nothing is left, and after
 *   the commit `payouts/reverse` for shares already paid out.
 */

export type ApplyDisputeContext = {
  afterCommit: (task: () => Promise<void> | void) => void
  now: Date
  /** For telling our payments apart when no order matches (default: `getStripeGateway()`). */
  gateway?: Pick<CheckoutGateway, "retrieveCharge" | "retrievePaymentIntentWithBalanceTransaction">
}

export type ApplyDisputeResult =
  | { status: "unknown_order" }
  | { status: "applied"; chargebackId: string; opened: boolean; closed: "won" | "lost" | null }

/**
 * Stripe's dispute fee as this snapshot shows it: the fees on the dispute's balance transactions
 * (the withdrawal's fee is positive; a reinstatement that returns it carries a negative fee).
 */
export function disputeFeeCents(dispute: StripeDispute): number {
  const net = (dispute.balance_transactions ?? []).reduce(
    (sum, transaction) => sum + transaction.fee,
    0,
  )
  return Math.max(0, net)
}

/**
 * The fee to keep on the chargeback. Events can arrive out of order, so while it is open the fee
 * only grows (a later snapshot has more balance transactions); a closed snapshot settles it (a
 * won dispute whose fee Stripe returned brings it down), and once closed it can only come down.
 */
export function nextDisputeFee(input: {
  storedFeeCents: number
  storedOpen: boolean
  snapshotFeeCents: number
  snapshotClosed: boolean
}): number {
  const { storedFeeCents, storedOpen, snapshotFeeCents, snapshotClosed } = input
  if (storedOpen)
    return snapshotClosed ? snapshotFeeCents : Math.max(storedFeeCents, snapshotFeeCents)
  return snapshotClosed ? Math.min(storedFeeCents, snapshotFeeCents) : storedFeeCents
}

export async function applyStripeDispute(
  tx: Tx,
  dispute: StripeDispute,
  context: ApplyDisputeContext,
): Promise<ApplyDisputeResult> {
  const matches: SQL[] = []
  const chargeId = stripeIdOf(dispute.charge)
  const paymentIntentId = stripeIdOf(dispute.payment_intent)
  if (chargeId) matches.push(eq(orders.stripeChargeId, chargeId))
  if (paymentIntentId) matches.push(eq(orders.stripePaymentIntentId, paymentIntentId))
  const [order] =
    matches.length === 0
      ? []
      : await tx
          .select()
          .from(orders)
          .where(or(...matches))
          .limit(1)
          .for("update")
  if (!order) {
    // Our payment whose order is not recorded yet: fail so Stripe retries (CLAUDE.md §19.37).
    if (await isOurCheckoutPayment(tx, { chargeId, paymentIntentId }, context.gateway)) {
      throw new OrderNotRecordedYetError(`dispute ${dispute.id}`)
    }
    return { status: "unknown_order" }
  }

  const fee = disputeFeeCents(dispute)
  let [row] = await tx
    .select()
    .from(chargebacks)
    .where(eq(chargebacks.stripeDisputeId, dispute.id))
    .for("update")
  let opened = false

  if (!row) {
    const [inserted] = await tx
      .insert(chargebacks)
      .values({
        orderId: order.id,
        stripeDisputeId: dispute.id,
        amountCents: dispute.amount,
        feeCents: fee,
        currency: dispute.currency,
        reason: dispute.reason ?? null,
        status: "open",
        stripeStatus: dispute.status,
        openedAt: new Date(dispute.created * 1000),
      })
      .onConflictDoNothing({ target: chargebacks.stripeDisputeId })
      .returning()
    if (inserted) {
      opened = true
      row = inserted
      await tx.update(orders).set({ status: "disputed" }).where(eq(orders.id, order.id))
      await track(
        "order.disputed",
        {
          actorUserId: null,
          subjectType: "order",
          subjectId: order.id,
          properties: { launch_id: order.launchId },
        },
        tx,
      )
      const chargebackId = inserted.id
      context.afterCommit(async () => {
        await notifyChargebackOpened(getDb(), chargebackId)
      })
    } else {
      ;[row] = await tx
        .select()
        .from(chargebacks)
        .where(eq(chargebacks.stripeDisputeId, dispute.id))
        .for("update")
    }
  }
  if (!row) throw new Error(`chargeback ${dispute.id} could not be recorded`)

  const outcome = chargebackOutcome(dispute.status)
  const feeCents = nextDisputeFee({
    storedFeeCents: row.feeCents,
    storedOpen: row.status === "open",
    snapshotFeeCents: fee,
    snapshotClosed: outcome !== "open",
  })
  await tx
    .update(chargebacks)
    .set({ stripeStatus: dispute.status, feeCents })
    .where(eq(chargebacks.id, row.id))
  // The fee is a platform cost as soon as Stripe withdraws it, whatever the outcome (§9).
  await postDisputeFeeLedger(tx, { chargebackId: row.id })

  if (row.status !== "open" || outcome === "open") {
    return { status: "applied", chargebackId: row.id, opened, closed: null }
  }

  // Another chargeback on the same order still open keeps it disputed.
  const [otherOpen] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(chargebacks)
    .where(
      and(
        eq(chargebacks.orderId, order.id),
        eq(chargebacks.status, "open"),
        ne(chargebacks.id, row.id),
      ),
    )
  const stillDisputed = (otherOpen?.n ?? 0) > 0

  if (outcome === "won") {
    await tx
      .update(chargebacks)
      .set({ status: "won", closedAt: context.now })
      .where(eq(chargebacks.id, row.id))
    await tx
      .update(orders)
      .set({
        status: orderStatusFor({
          grossCents: order.amountGrossCents,
          refundedCents: order.amountRefundedCents,
          disputed: stillDisputed,
        }),
      })
      .where(eq(orders.id, order.id))
  } else {
    // A buyer can dispute the whole charge after a refund: what goes beyond the gross is a
    // platform loss in the ledger (`postChargebackLedger`), never more than gross on the order.
    const refunded = Math.min(order.amountGrossCents, order.amountRefundedCents + row.amountCents)
    await tx
      .update(chargebacks)
      .set({ status: "lost", closedAt: context.now })
      .where(eq(chargebacks.id, row.id))
    await tx
      .update(orders)
      .set({
        amountRefundedCents: refunded,
        status: orderStatusFor({
          grossCents: order.amountGrossCents,
          refundedCents: refunded,
          disputed: stillDisputed,
        }),
      })
      .where(eq(orders.id, order.id))
    await postChargebackLedger(tx, { chargebackId: row.id })
    if (refunded === order.amountGrossCents) {
      await tx
        .update(accessGrants)
        .set({ revokedAt: context.now })
        .where(and(eq(accessGrants.orderId, order.id), isNull(accessGrants.revokedAt)))
    }
    const chargebackId = row.id
    context.afterCommit(() =>
      enqueue(
        "payouts/reverse.requested",
        { cause: "chargeback", id: chargebackId },
        {
          id: `reverse:chargeback:${chargebackId}`,
        },
      ),
    )
  }

  await track(
    "chargeback.closed",
    {
      actorUserId: null,
      subjectType: "chargeback",
      subjectId: row.id,
      properties: {
        order_id: order.id,
        outcome,
        amount_cents: row.amountCents,
        currency: row.currency,
      },
    },
    tx,
  )
  return { status: "applied", chargebackId: row.id, opened, closed: outcome }
}
