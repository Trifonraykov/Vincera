import { eq } from "drizzle-orm"

import type { Db } from "@/lib/db/client"
import { accessGrants, events, ledgerEntries, notifications, orders } from "@/lib/db/schema"
import { newAccessToken } from "@/lib/delivery/token"
import { postOrderLedger } from "@/lib/ledger/post"
import { completeFakeOnboarding, createFakeEvent, type FakeStripeStore } from "@/lib/stripe/fake"
import type { StripeGateway } from "@/lib/stripe/gateway"
import { jsonObjectSchema, stripeEventSchema } from "@/lib/stripe/schemas"
import type { JsonObject } from "@/lib/db/schema"
import type Stripe from "stripe"

import { insertLiveLaunch, insertOrder, insertStripeAccount } from "../../helpers/db-fixtures"
import { balanceTransaction, CONFIG, DAY_MS, PAID_AT } from "../ledger/helpers"

/**
 * Fixtures of the payouts integration tests (CLAUDE.md §19.35): a live launch with a paid €19
 * order (21 % VAT, Stripe fee 54 → creator 818, builder 546, platform 152), its fake Stripe
 * PaymentIntent and charge (so refunds and disputes work against the fake gateway), and
 * payouts-ready connected accounts that exist in the fake store (transfers need them).
 */

export { CONFIG, DAY_MS, PAID_AT }
export const CREATOR_SHARE = 818
export const BUILDER_SHARE = 546
export const AFTER_HOLD = new Date(PAID_AT.getTime() + 15 * DAY_MS)

let counter = 0

export type FakeGateway = StripeGateway & { store: FakeStripeStore }

/** A connected account in the fake store plus its `stripe_accounts` row. */
export async function readyAccount(
  db: Db,
  gateway: FakeGateway,
  userId: string,
  overrides: { transfersActive?: boolean } = {},
) {
  const account = await gateway.createConnectedAccount(
    { country: "ES", email: null, userId },
    { idempotencyKey: `acct:${userId}` },
  )
  await completeFakeOnboarding(gateway.store, account.id, "enabled")
  const active = overrides.transfersActive ?? true
  await insertStripeAccount(db, userId, {
    stripeAccountId: account.id,
    payoutsEnabled: active,
    transfersCapability: active ? "active" : "pending",
    detailsSubmitted: true,
  })
  return account.id
}

/** A posted sale with its fake payment objects and an access grant; both members ready. */
export async function postedSale(
  db: Db,
  gateway: FakeGateway,
  options: { ready?: boolean; paidAt?: Date } = {},
) {
  counter += 1
  const tag = `${Date.now().toString(36)}${counter}`
  const launch = await insertLiveLaunch(db)
  const paymentIntentId = `pi_fake_${tag}`
  const chargeId = `ch_fake_${tag}`
  const order = await insertOrder(db, launch.launch.id, options.paidAt ?? PAID_AT, {
    amountGrossCents: 1900,
    taxCents: 330,
    stripeFeeCents: 0,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: chargeId,
  })
  await gateway.store.write("payment_intent", paymentIntentId, {
    id: paymentIntentId,
    object: "payment_intent",
    amount: 1900,
    currency: "eur",
    status: "succeeded",
    latest_charge: chargeId,
    created: 0,
  })
  await gateway.store.write("charge", chargeId, {
    id: chargeId,
    object: "charge",
    amount: 1900,
    amount_refunded: 0,
    currency: "eur",
    status: "succeeded",
    paid: true,
    refunded: false,
    payment_intent: paymentIntentId,
    balance_transaction: null,
    created: 0,
  })
  await db.transaction((tx) =>
    postOrderLedger(
      tx,
      { orderId: order.id, balanceTransaction: balanceTransaction(1900, 54) },
      CONFIG,
    ),
  )
  const [grant] = await db
    .insert(accessGrants)
    .values({ orderId: order.id, token: newAccessToken() })
    .returning()
  let accounts: { creator: string; builder: string } | null = null
  if (options.ready ?? true) {
    accounts = {
      creator: await readyAccount(db, gateway, launch.creator.user.id),
      builder: await readyAccount(db, gateway, launch.builder.user.id),
    }
  }
  return { ...launch, order, grant, paymentIntentId, chargeId, accounts }
}

/** A Stripe-shaped event (stored in the fake store) parsed like the webhook route parses it. */
export async function stripeEvent(
  store: FakeStripeStore,
  type: Stripe.Event.Type,
  object: JsonObject,
) {
  const raw = await createFakeEvent(store, type, object)
  return { event: stripeEventSchema.parse(raw), payload: jsonObjectSchema.parse(raw) }
}

export async function orderRow(db: Db, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
  if (!order) throw new Error("no order")
  return order
}

export async function userEntries(db: Db, userId: string) {
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, userId))
}

export function sum(rows: readonly { amountCents: number }[]): number {
  return rows.reduce((total, row) => total + row.amountCents, 0)
}

export async function eventTypes(db: Db, subjectId: string): Promise<string[]> {
  const rows = await db
    .select({ type: events.type })
    .from(events)
    .where(eq(events.subjectId, subjectId))
  return rows.map((row) => row.type).sort()
}

export async function notificationTypes(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ type: notifications.type })
    .from(notifications)
    .where(eq(notifications.userId, userId))
  return rows.map((row) => row.type).sort()
}
