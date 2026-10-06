import "server-only"

import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import type { JsonObject } from "@/lib/db/schema"

import {
  checkoutSessionParams,
  stripeChargeSchema,
  stripeCheckoutSessionSchema,
  stripePaymentIntentSchema,
  type StripeCharge,
  type StripeCheckoutSession,
} from "./checkout-shared"
import { randomId, unixSeconds, type FakeStripeOptions, type FakeStripeStore } from "./fake"
import type { CheckoutGateway } from "./gateway"
import { stripeIdOf } from "./ids"
import { stripeBalanceTransactionSchema } from "./money-shared"
import { StripeGatewayError } from "./shared"

/**
 * Fake checkout (Phase 4, CLAUDE.md §19.31, §19.34): Stripe-shaped `checkout_session`,
 * `payment_intent`, `charge` and `balance_transaction` objects in the fake store.
 *
 * - `createCheckoutSession` builds the session from `checkoutSessionParams(input)` (the same
 *   parameters the live gateway sends), with an id derived from the idempotency key (a retried
 *   request replays the first session; other parameters with the same key fail like Stripe). Its
 *   `url` is the fake checkout page `/api/dev/fake-stripe/checkout/<sessionId>`.
 * - The page completes the session with `completeFakeCheckoutSession` (card, card whose fee is
 *   still pending, or a delayed payment method), then delivers the events Stripe would send to the
 *   real webhook (lib/checkout/fake-page.ts).
 * - Tax is computed by Stripe Tax in real life; the fake uses a small VAT table by the buyer's
 *   country (`fakeTaxRateBps`), tax-inclusive. The fee is `FAKE_STRIPE_FEE` on the amount paid.
 */

/** The fake's card fee: 1.5% + €0.25 (the marketing example's, §19.8), rounded half up. */
export const FAKE_STRIPE_FEE = { percentBps: 150, fixedCents: 25 } as const

/** The fake's default VAT, included in the price: 21% (Spain, the platform's origin). */
export const FAKE_TAX_RATE_BPS = 2100

/** Standard VAT rates (basis points) the fake applies by the buyer's country; others: 0. */
const FAKE_TAX_TABLE: Readonly<Record<string, number>> = {
  AT: 2000,
  BE: 2100,
  DE: 1900,
  DK: 2500,
  ES: 2100,
  FI: 2550,
  FR: 2000,
  GB: 2000,
  IE: 2300,
  IT: 2200,
  NL: 2100,
  PL: 2300,
  PT: 2300,
  SE: 2500,
}

/** Countries offered on the fake page (the first is the default). */
export const FAKE_CHECKOUT_COUNTRIES = ["ES", "DE", "FR", "IT", "NL", "IE", "GB", "US"] as const

export function fakeTaxRateBps(country: string | null): number {
  if (!country) return FAKE_TAX_RATE_BPS
  return FAKE_TAX_TABLE[country] ?? 0
}

/** VAT included in `grossCents` at `rateBps`, rounded half up (integer arithmetic). */
export function inclusiveTaxCents(grossCents: number, rateBps: number): number {
  if (rateBps <= 0 || grossCents <= 0) return 0
  const denominator = 10_000 + rateBps
  return Math.floor((2 * grossCents * rateBps + denominator) / (2 * denominator))
}

/** The fake Stripe fee on a charge of `amountCents`. */
export function fakeStripeFeeCents(amountCents: number): number {
  if (amountCents <= 0) return 0
  return (
    Math.floor((2 * amountCents * FAKE_STRIPE_FEE.percentBps + 10_000) / 20_000) +
    FAKE_STRIPE_FEE.fixedCents
  )
}

/** Percent-off discount on `cents`, rounded half up like Stripe's coupons. */
function percentOff(cents: number, percent: number): number {
  return Math.floor((2 * cents * percent + 100) / 200)
}

export function fakeCheckoutPageUrl(appUrl: string, sessionId: string): string {
  return new URL(
    `/api/dev/fake-stripe/checkout/${encodeURIComponent(sessionId)}`,
    appUrl,
  ).toString()
}

function idFor(prefix: string, idempotencyKey: string): string {
  return `${prefix}${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`
}

const SESSION_ID_PATTERN = /^cs_fake_[A-Za-z0-9_]{1,120}$/

/** Fake-only fields the page needs (Stripe keeps these on its side). */
const fakeSessionExtrasSchema = z.object({
  success_url: z.string(),
  cancel_url: z.string(),
  allow_promotion_codes: z.boolean().default(false),
  fake_line: z.object({ name: z.string(), tax_code: z.string(), unit_amount: z.int() }),
})
export type FakeSessionExtras = z.output<typeof fakeSessionExtrasSchema>

const storedPromotionSchema = z.object({
  id: z.string(),
  code: z.string(),
  active: z.boolean(),
  coupon: z.string(),
})
const storedCouponSchema = z.object({ percent_off: z.number().min(0).max(100) })

async function readPromotion(
  store: FakeStripeStore,
  promotionCodeId: string,
): Promise<{ id: string; percentOff: number } | null> {
  let raw: JsonObject | null = null
  try {
    raw = await store.read("promotion_code", promotionCodeId)
  } catch (error) {
    if (error instanceof StripeGatewayError) return null
    throw error
  }
  const promotion = storedPromotionSchema.safeParse(raw)
  if (!promotion.success || !promotion.data.active) return null
  const coupon = storedCouponSchema.safeParse(await store.read("coupon", promotion.data.coupon))
  if (!coupon.success) return null
  return { id: promotion.data.id, percentOff: coupon.data.percent_off }
}

/** An active promotion code by its customer-facing text (what a buyer types on the page). */
export async function findFakePromotionByCode(
  store: FakeStripeStore,
  code: string,
): Promise<{ id: string; percentOff: number } | null> {
  let names: string[]
  try {
    names = await readdir(path.join(store.root, "promotion_code"))
  } catch {
    return null
  }
  const wanted = code.trim().toUpperCase()
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const raw = await store.read("promotion_code", name.slice(0, -".json".length))
    const parsed = storedPromotionSchema.safeParse(raw)
    if (parsed.success && parsed.data.active && parsed.data.code === wanted) {
      return readPromotion(store, parsed.data.id)
    }
  }
  return null
}

export type FakeStoredSession = { session: StripeCheckoutSession; extras: FakeSessionExtras }

/** A stored fake session with its page fields, or null. Marks an open session past `expires_at` expired. */
export async function readFakeCheckoutSession(
  store: FakeStripeStore,
  sessionId: string,
): Promise<FakeStoredSession | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null
  let raw = await store.read("checkout_session", sessionId)
  if (!raw) return null
  if (
    raw.status === "open" &&
    typeof raw.expires_at === "number" &&
    raw.expires_at <= unixSeconds()
  ) {
    raw = { ...raw, status: "expired", url: null }
    await store.write("checkout_session", sessionId, raw)
  }
  const session = stripeCheckoutSessionSchema.safeParse(raw)
  const extras = fakeSessionExtrasSchema.safeParse(raw)
  if (!session.success || !extras.success) return null
  return { session: session.data, extras: extras.data }
}

async function readRequired(
  store: FakeStripeStore,
  type: "checkout_session" | "payment_intent" | "charge" | "balance_transaction",
  id: string,
): Promise<JsonObject> {
  let object: JsonObject | null = null
  try {
    object = await store.read(type, id)
  } catch (error) {
    if (!(error instanceof StripeGatewayError)) throw error
  }
  if (!object) {
    throw new StripeGatewayError("resource_missing", `No such ${type.replace("_", " ")}: '${id}'`)
  }
  return object
}

/** A charge with its balance transaction expanded (or null while the fee is pending). */
async function expandedCharge(store: FakeStripeStore, chargeId: string): Promise<StripeCharge> {
  const raw = await readRequired(store, "charge", chargeId)
  const btId = typeof raw.balance_transaction === "string" ? raw.balance_transaction : null
  const balanceTransaction = btId
    ? stripeBalanceTransactionSchema.parse(await readRequired(store, "balance_transaction", btId))
    : null
  return stripeChargeSchema.parse({ ...raw, balance_transaction: balanceTransaction })
}

export function createFakeCheckoutGateway(
  store: FakeStripeStore,
  options: FakeStripeOptions,
): CheckoutGateway {
  return {
    async createCheckoutSession(input, { idempotencyKey }) {
      const params = checkoutSessionParams(input)
      const id = idFor("cs_fake_", idempotencyKey)
      const existing = await store.read("checkout_session", id)
      if (existing) {
        const session = stripeCheckoutSessionSchema.parse(existing)
        if (
          session.amount_subtotal !== input.priceCents ||
          session.metadata?.order_ref !== input.orderRef ||
          session.metadata?.launch_id !== input.launchId
        ) {
          throw new StripeGatewayError(
            "invalid_request",
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          )
        }
        return session
      }

      let discountCents = 0
      if (input.promotionCodeId) {
        const promotion = await readPromotion(store, input.promotionCodeId)
        if (!promotion) {
          throw new StripeGatewayError(
            "invalid_request",
            `No such promotion code: '${input.promotionCodeId}'`,
          )
        }
        discountCents = percentOff(input.priceCents, promotion.percentOff)
      }
      const amountTotal = input.priceCents - discountCents
      const created = unixSeconds()
      const session: JsonObject = {
        id,
        object: "checkout.session",
        status: "open",
        payment_status: "unpaid",
        mode: params.mode,
        url: fakeCheckoutPageUrl(options.appUrl, id),
        amount_subtotal: input.priceCents,
        amount_total: amountTotal,
        currency: input.currency,
        client_reference_id: params.client_reference_id,
        customer_details: null,
        total_details: {
          amount_discount: discountCents,
          amount_tax: inclusiveTaxCents(amountTotal, FAKE_TAX_RATE_BPS),
          amount_shipping: 0,
        },
        discounts: input.promotionCodeId ? [{ promotion_code: input.promotionCodeId }] : [],
        metadata: params.metadata,
        payment_intent: null,
        created,
        expires_at: params.expires_at,
        // Fake-only: what the fake page needs.
        success_url: params.success_url,
        cancel_url: params.cancel_url,
        allow_promotion_codes: !input.promotionCodeId,
        fake_line: {
          name: input.productName,
          tax_code: input.taxCode,
          unit_amount: input.priceCents,
        },
        fake_payment_intent_metadata: params.payment_intent_data.metadata,
        fake_transfer_group: params.payment_intent_data.transfer_group,
      }
      await store.write("checkout_session", id, session)
      return stripeCheckoutSessionSchema.parse(session)
    },

    async retrieveCheckoutSession(sessionId) {
      const stored = await readFakeCheckoutSession(store, sessionId)
      if (!stored) {
        throw new StripeGatewayError("resource_missing", `No such checkout session: '${sessionId}'`)
      }
      return stored.session
    },

    async retrievePaymentIntentWithBalanceTransaction(paymentIntentId) {
      const raw = await readRequired(store, "payment_intent", paymentIntentId)
      const chargeId = typeof raw.latest_charge === "string" ? raw.latest_charge : null
      return stripePaymentIntentSchema.parse({
        ...raw,
        latest_charge: chargeId ? await expandedCharge(store, chargeId) : null,
      })
    },

    async retrieveCharge(chargeId) {
      return expandedCharge(store, chargeId)
    },
  }
}

// --- Completing a fake session (the fake checkout page) -----------------------------------------

/**
 * How the buyer pays on the fake page:
 * - `card`: paid at once, the balance transaction (fee) exists right away;
 * - `card_fee_pending`: paid at once, but the balance transaction comes later (`charge.updated`);
 * - `delayed`: a delayed method (e.g. SEPA debit): the session completes unpaid, then succeeds;
 * - `delayed_fail`: the same, but the payment fails.
 */
export const FAKE_PAYMENT_METHODS = ["card", "card_fee_pending", "delayed", "delayed_fail"] as const
export type FakePaymentMethod = (typeof FAKE_PAYMENT_METHODS)[number]

export type CompleteFakeCheckoutInput = {
  method: FakePaymentMethod
  email: string
  country: string
  /** A code typed on the page (only when the session allows promotion codes). */
  promotionCode?: string | null
}

export type CompleteFakeCheckoutResult =
  | { ok: true; session: JsonObject; chargeId: string | null; paymentIntentId: string | null }
  | { ok: false; reason: "not_found" | "not_open" | "invalid_code" }

/**
 * Pay a fake session: writes the PaymentIntent (and, unless the method is delayed, the charge and
 * its balance transaction) and marks the session `complete` (`paid`, `unpaid` for delayed methods,
 * or `no_payment_required` for a 100% discount). The caller delivers the events.
 */
export async function completeFakeCheckoutSession(
  store: FakeStripeStore,
  sessionId: string,
  input: CompleteFakeCheckoutInput,
): Promise<CompleteFakeCheckoutResult> {
  const stored = await readFakeCheckoutSession(store, sessionId)
  if (!stored) return { ok: false, reason: "not_found" }
  if (stored.session.status !== "open") return { ok: false, reason: "not_open" }
  const raw = await readRequired(store, "checkout_session", sessionId)
  const { session, extras } = stored

  let discountCents = session.total_details?.amount_discount ?? 0
  let discounts = raw.discounts ?? []
  const typed = input.promotionCode?.trim()
  if (typed && extras.allow_promotion_codes && discountCents === 0) {
    const promotion = await findFakePromotionByCode(store, typed)
    if (!promotion) return { ok: false, reason: "invalid_code" }
    discountCents = percentOff(extras.fake_line.unit_amount, promotion.percentOff)
    discounts = [{ promotion_code: promotion.id }]
  }

  const amountTotal = extras.fake_line.unit_amount - discountCents
  const taxCents = inclusiveTaxCents(amountTotal, fakeTaxRateBps(input.country))
  const currency = session.currency ?? "eur"
  const created = unixSeconds()
  const delayed = input.method === "delayed" || input.method === "delayed_fail"

  let paymentIntentId: string | null = null
  let chargeId: string | null = null
  if (amountTotal > 0) {
    paymentIntentId = randomId("pi_fake_")
    const metadata = raw.fake_payment_intent_metadata ?? session.metadata ?? {}
    if (!delayed) {
      chargeId = await writeFakeCharge(store, {
        paymentIntentId,
        amount: amountTotal,
        currency,
        metadata,
        withBalanceTransaction: input.method === "card",
      })
    }
    await store.write("payment_intent", paymentIntentId, {
      id: paymentIntentId,
      object: "payment_intent",
      amount: amountTotal,
      currency,
      status: delayed ? "processing" : "succeeded",
      latest_charge: chargeId,
      metadata,
      transfer_group: raw.fake_transfer_group ?? null,
      created,
    })
  }

  const updated: JsonObject = {
    ...raw,
    status: "complete",
    payment_status: amountTotal === 0 ? "no_payment_required" : delayed ? "unpaid" : "paid",
    url: null,
    amount_total: amountTotal,
    customer_details: {
      email: input.email.trim().toLowerCase(),
      address: { country: input.country },
    },
    total_details: { amount_discount: discountCents, amount_tax: taxCents, amount_shipping: 0 },
    discounts,
    payment_intent: paymentIntentId,
  }
  await store.write("checkout_session", sessionId, updated)
  return { ok: true, session: updated, chargeId, paymentIntentId }
}

async function writeFakeCharge(
  store: FakeStripeStore,
  input: {
    paymentIntentId: string
    amount: number
    currency: string
    metadata: JsonObject[string]
    withBalanceTransaction: boolean
  },
): Promise<string> {
  const chargeId = randomId("ch_fake_")
  const created = unixSeconds()
  const balanceTransactionId = input.withBalanceTransaction
    ? await writeFakeBalanceTransaction(store, chargeId, input.amount, input.currency)
    : null
  await store.write("charge", chargeId, {
    id: chargeId,
    object: "charge",
    amount: input.amount,
    amount_refunded: 0,
    currency: input.currency,
    status: "succeeded",
    paid: true,
    refunded: false,
    payment_intent: input.paymentIntentId,
    balance_transaction: balanceTransactionId,
    metadata: input.metadata ?? {},
    created,
  })
  return chargeId
}

async function writeFakeBalanceTransaction(
  store: FakeStripeStore,
  chargeId: string,
  amount: number,
  currency: string,
): Promise<string> {
  const id = randomId("txn_fake_")
  const fee = fakeStripeFeeCents(amount)
  const created = unixSeconds()
  await store.write("balance_transaction", id, {
    id,
    object: "balance_transaction",
    amount,
    fee,
    net: amount - fee,
    currency,
    fee_details: [
      { amount: fee, currency, type: "stripe_fee", description: "Stripe processing fees" },
    ],
    status: "pending",
    type: "charge",
    available_on: created + 7 * 24 * 60 * 60,
    created,
    source: chargeId,
  })
  return id
}

/**
 * The fee of a `card_fee_pending` charge becomes known: its balance transaction is written and set
 * on the charge. Returns the charge (with the balance transaction's id, as `charge.updated` carries
 * it). Idempotent.
 */
export async function settleFakeChargeFee(
  store: FakeStripeStore,
  chargeId: string,
): Promise<JsonObject> {
  const raw = await readRequired(store, "charge", chargeId)
  if (typeof raw.balance_transaction === "string") return raw
  const charge = stripeChargeSchema.parse(raw)
  const balanceTransaction = await writeFakeBalanceTransaction(
    store,
    charge.id,
    charge.amount,
    charge.currency,
  )
  const updated = { ...raw, balance_transaction: balanceTransaction }
  await store.write("charge", chargeId, updated)
  return updated
}

/**
 * A delayed payment of a completed fake session settles: `succeeded` writes the charge and its
 * balance transaction and marks the session `paid`; `failed` marks the PaymentIntent failed.
 * Returns the updated session (the object of `checkout.session.async_payment_*`).
 */
export async function settleFakeDelayedPayment(
  store: FakeStripeStore,
  sessionId: string,
  outcome: "succeeded" | "failed",
): Promise<JsonObject> {
  const session = await readRequired(store, "checkout_session", sessionId)
  const paymentIntentId = stripeIdOf(
    typeof session.payment_intent === "string" ? session.payment_intent : null,
  )
  if (!paymentIntentId) {
    throw new StripeGatewayError("invalid_request", "This session has no payment to settle.")
  }
  const paymentIntent = await readRequired(store, "payment_intent", paymentIntentId)
  if (outcome === "failed") {
    await store.write("payment_intent", paymentIntentId, {
      ...paymentIntent,
      status: "requires_payment_method",
    })
    return session
  }
  if (paymentIntent.status === "succeeded") return session
  const amount = typeof paymentIntent.amount === "number" ? paymentIntent.amount : 0
  const currency = typeof paymentIntent.currency === "string" ? paymentIntent.currency : "eur"
  const chargeId = await writeFakeCharge(store, {
    paymentIntentId,
    amount,
    currency,
    metadata: paymentIntent.metadata ?? {},
    withBalanceTransaction: true,
  })
  await store.write("payment_intent", paymentIntentId, {
    ...paymentIntent,
    status: "succeeded",
    latest_charge: chargeId,
  })
  const updated = { ...session, payment_status: "paid" }
  await store.write("checkout_session", sessionId, updated)
  return updated
}
