import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import { withTransaction, type Tx } from "@/lib/db/client"
import { accessGrants, launches, orders, trackedLinks } from "@/lib/db/schema"
import { newAccessToken } from "@/lib/delivery/token"
import { track } from "@/lib/events/track"
import { enqueue } from "@/lib/jobs/enqueue"
import { LedgerError } from "@/lib/ledger/errors"
import { postOrderLedger, type LedgerConfig } from "@/lib/ledger/post"
import { reportError } from "@/lib/observability"
import {
  checkoutMetadataSchema,
  type StripeCharge,
  type StripeCheckoutSession,
} from "@/lib/stripe/checkout-shared"
import type { StripeGateway } from "@/lib/stripe/gateway"
import { stripeIdOf } from "@/lib/stripe/ids"
import type { StripeBalanceTransaction } from "@/lib/stripe/money-shared"

import { assignLicenseKey, isFulfillable } from "./license-keys"

export { assignLicenseKey, isFulfillable, remainingLicenseKeys } from "./license-keys"

/**
 * Order fulfilment (§9 steps 1–6; CLAUDE.md §19.31 "Fulfilment", §19.34): runs inside the
 * `checkout.session.completed` / `checkout.session.async_payment_succeeded` webhook transaction.
 *
 * One transaction creates the order (`id = metadata.order_ref`, status `paid`), the buyer's access
 * grant, a license key for `license_key` launches, and `order.paid`; when Stripe already knows the
 * fee (the charge's balance transaction exists) the ledger is posted in the same transaction,
 * otherwise `charge.updated` (or the hourly `ledger-post-pending`) posts it later. After the commit
 * `orders/paid.requested` sends the buyer's receipt and the sale notices.
 *
 * Idempotent: the order row is unique per Checkout Session (`ON CONFLICT DO NOTHING`), so replayed
 * or duplicate events change nothing.
 */

export type FulfilmentGateway = Pick<
  StripeGateway,
  "retrievePaymentIntentWithBalanceTransaction" | "retrieveCharge" | "retrieveBalanceTransaction"
>

export type FulfilmentContext = {
  gateway: FulfilmentGateway
  /** The event's `created` time: `paid_at` when there is no charge (a free order). */
  eventTime: Date
  /** Queue work for after the commit (the webhook's `afterCommit`). */
  afterCommit: (task: () => Promise<void> | void) => void
  /** Take rate and hold period (tests); defaults to the environment's. */
  ledgerConfig?: LedgerConfig
}

export type FulfilmentResult =
  | {
      status: "fulfilled"
      orderId: string
      ledger: "posted" | "fee_pending" | "not_applicable" | "failed"
      licenseKey: "assigned" | "out_of_stock" | "not_applicable"
    }
  | { status: "duplicate"; orderId: string }
  /** `payment_status` is `unpaid` (a delayed method still settling): nothing to fulfil yet. */
  | { status: "not_paid" }
  /** A session without our metadata (another integration on the same Stripe account). */
  | { status: "ignored"; reason: "foreign_session" | "unknown_launch" }

/** Ledger errors that mean "the data does not match", not "the code is wrong": left unposted. */
const DATA_LEDGER_ERRORS = new Set([
  "currency_mismatch",
  "balance_transaction_mismatch",
  "invalid_members",
])

export async function fulfilCheckoutSession(
  tx: Tx,
  session: StripeCheckoutSession,
  context: FulfilmentContext,
): Promise<FulfilmentResult> {
  if (!isFulfillable(session.payment_status)) return { status: "not_paid" }

  const metadata = checkoutMetadataSchema.safeParse(session.metadata ?? {})
  if (!metadata.success) {
    reportError(new Error("checkout.session without our metadata"), {
      tags: { area: "checkout" },
      extra: { session_id: session.id },
    })
    return { status: "ignored", reason: "foreign_session" }
  }
  const { order_ref: orderId, launch_id: launchId } = metadata.data

  const [existing] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.stripeCheckoutSessionId, session.id))
  if (existing) return { status: "duplicate", orderId: existing.id }

  const [launch] = await tx
    .select({ id: launches.id, deliveryType: launches.deliveryType })
    .from(launches)
    .where(eq(launches.id, launchId))
  if (!launch) {
    reportError(new Error("checkout.session for an unknown launch"), {
      tags: { area: "checkout" },
      extra: { session_id: session.id, launch_id: launchId },
    })
    return { status: "ignored", reason: "unknown_launch" }
  }

  const gross = session.amount_total
  const currency = session.currency
  if (gross === null || gross === undefined || !currency) {
    throw new Error(`checkout.session ${session.id} has no amount_total or currency`)
  }
  const buyerEmail = session.customer_details?.email?.trim().toLowerCase()
  if (!buyerEmail) throw new Error(`checkout.session ${session.id} has no customer email`)
  const country = session.customer_details?.address?.country?.toUpperCase() ?? null

  // The payment: PaymentIntent → charge → balance transaction (the fee, §9 step 2).
  const paymentIntentId = stripeIdOf(session.payment_intent)
  let charge: StripeCharge | null = null
  let balanceTransaction: StripeBalanceTransaction | null = null
  if (paymentIntentId) {
    const paymentIntent =
      await context.gateway.retrievePaymentIntentWithBalanceTransaction(paymentIntentId)
    const latest = paymentIntent.latest_charge
    charge = typeof latest === "string" ? await context.gateway.retrieveCharge(latest) : latest
    balanceTransaction = charge ? await balanceTransactionOf(context.gateway, charge) : null
  }
  const paidAt = charge ? new Date(charge.created * 1000) : context.eventTime

  const attribution = await resolveCompletionAttribution(tx, {
    launchId,
    session,
    metadataLinkId: metadata.data.tracked_link_id ?? null,
    metadataAttribution: metadata.data.attribution ?? null,
  })

  const [inserted] = await tx
    .insert(orders)
    .values({
      id: orderId,
      launchId,
      buyerEmail,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      stripeChargeId: charge?.id ?? null,
      amountGrossCents: gross,
      taxCents: session.total_details?.amount_tax ?? 0,
      discountCents: session.total_details?.amount_discount ?? 0,
      currency,
      buyerCountry: country && /^[A-Z]{2}$/.test(country) ? country : null,
      trackedLinkId: attribution?.trackedLinkId ?? null,
      attribution: attribution?.attribution ?? null,
      status: "paid",
      paidAt,
    })
    .onConflictDoNothing()
    .returning({ id: orders.id })
  if (!inserted) {
    // A concurrent delivery of the same session won the insert.
    return { status: "duplicate", orderId }
  }

  await tx.insert(accessGrants).values({ orderId, token: newAccessToken() })

  let licenseKey: "assigned" | "out_of_stock" | "not_applicable" = "not_applicable"
  if (launch.deliveryType === "license_key") {
    licenseKey = (await assignLicenseKey(tx, launchId, orderId, paidAt))
      ? "assigned"
      : "out_of_stock"
  }

  await track(
    "order.paid",
    {
      actorUserId: null,
      subjectType: "order",
      subjectId: orderId,
      properties: {
        launch_id: launchId,
        tracked_link_id: attribution?.trackedLinkId ?? null,
        amount_gross_cents: gross,
        tax_cents: session.total_details?.amount_tax ?? 0,
        stripe_fee_cents: balanceTransaction?.fee ?? 0,
        currency,
      },
      occurredAt: paidAt,
    },
    tx,
  )

  let ledger: "posted" | "fee_pending" | "not_applicable" | "failed" = "not_applicable"
  if (gross > 0) {
    ledger = balanceTransaction
      ? await postLedgerSafely(tx, orderId, balanceTransaction, context.ledgerConfig)
      : "fee_pending"
  }

  context.afterCommit(() =>
    enqueue("orders/paid.requested", { orderId }, { id: `order:${orderId}` }),
  )
  return { status: "fulfilled", orderId, ledger, licenseKey }
}

/**
 * Post the sale in a savepoint. A data mismatch (another currency, another amount, members whose
 * splits do not add up) is reported and leaves the order unposted for `ledger:check` to flag; the
 * buyer still gets the order. Other ledger errors are bugs and fail the event.
 */
async function postLedgerSafely(
  tx: Tx,
  orderId: string,
  balanceTransaction: StripeBalanceTransaction,
  config: LedgerConfig | undefined,
): Promise<"posted" | "failed"> {
  try {
    await withTransaction(
      (inner) => postOrderLedger(inner, { orderId, balanceTransaction }, config),
      tx,
    )
    return "posted"
  } catch (error) {
    if (error instanceof LedgerError && DATA_LEDGER_ERRORS.has(error.code)) {
      reportError(error, {
        tags: { area: "checkout", ledger_code: error.code },
        extra: { orderId },
      })
      return "failed"
    }
    throw error
  }
}

/** The charge's balance transaction, retrieved when only its id came; null while pending. */
export async function balanceTransactionOf(
  gateway: Pick<StripeGateway, "retrieveBalanceTransaction">,
  charge: StripeCharge,
): Promise<StripeBalanceTransaction | null> {
  const field = charge.balance_transaction
  if (field === null) return null
  return typeof field === "string" ? gateway.retrieveBalanceTransaction(field) : field
}

/**
 * Who the order is attributed to (§10; CLAUDE.md §19.31): a promotion code that belongs to an
 * enabled tracked link of this launch wins (`discount_code`); otherwise the link from the session's
 * metadata, re-checked (same launch, still enabled), with its `cookie | ref` origin; else none.
 */
async function resolveCompletionAttribution(
  tx: Tx,
  input: {
    launchId: string
    session: StripeCheckoutSession
    metadataLinkId: string | null
    metadataAttribution: "cookie" | "ref" | null
  },
): Promise<{ trackedLinkId: string; attribution: "cookie" | "ref" | "discount_code" } | null> {
  for (const discount of input.session.discounts ?? []) {
    const promotionCodeId = stripeIdOf(discount.promotion_code)
    if (!promotionCodeId) continue
    const [link] = await tx
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.stripePromotionCodeId, promotionCodeId),
          eq(trackedLinks.launchId, input.launchId),
          isNull(trackedLinks.disabledAt),
        ),
      )
    if (link) return { trackedLinkId: link.id, attribution: "discount_code" }
  }
  if (input.metadataLinkId && input.metadataAttribution) {
    const [link] = await tx
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.id, input.metadataLinkId),
          eq(trackedLinks.launchId, input.launchId),
          isNull(trackedLinks.disabledAt),
        ),
      )
    if (link) return { trackedLinkId: link.id, attribution: input.metadataAttribution }
  }
  return null
}

export type ChargeLedgerResult =
  | { status: "posted" | "already_posted" | "fee_pending" | "failed"; orderId: string }
  /** No order for the charge yet (`checkout.session.completed` has not landed). */
  | { status: "no_order" }

/**
 * `charge.updated` (§19.10 "Ledger timing"): once a charge has its balance transaction, find the
 * order by the charge id (else its PaymentIntent, recording the charge id) and post the sale.
 * Idempotent: a posted order is left alone. A charge that arrives before its order does nothing;
 * fulfilment (or the hourly safety net) posts it.
 */
export async function postLedgerForCharge(
  tx: Tx,
  charge: StripeCharge,
  context: {
    gateway: Pick<StripeGateway, "retrieveBalanceTransaction">
    ledgerConfig?: LedgerConfig
  },
): Promise<ChargeLedgerResult> {
  const paymentIntentId = stripeIdOf(charge.payment_intent)
  let [order] = await tx
    .select({
      id: orders.id,
      ledgerPostedAt: orders.ledgerPostedAt,
      chargeId: orders.stripeChargeId,
    })
    .from(orders)
    .where(eq(orders.stripeChargeId, charge.id))
  if (!order && paymentIntentId) {
    ;[order] = await tx
      .select({
        id: orders.id,
        ledgerPostedAt: orders.ledgerPostedAt,
        chargeId: orders.stripeChargeId,
      })
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
  }
  if (!order) return { status: "no_order" }
  if (order.ledgerPostedAt) return { status: "already_posted", orderId: order.id }
  if (order.chargeId === null) {
    await tx
      .update(orders)
      .set({ stripeChargeId: charge.id })
      .where(and(eq(orders.id, order.id), isNull(orders.stripeChargeId)))
  }
  const balanceTransaction = await balanceTransactionOf(context.gateway, charge)
  if (!balanceTransaction) return { status: "fee_pending", orderId: order.id }
  const status = await postLedgerSafely(tx, order.id, balanceTransaction, context.ledgerConfig)
  return { status, orderId: order.id }
}
