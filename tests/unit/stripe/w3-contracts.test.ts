import { describe, expect, it } from "vitest"

import {
  CHECKOUT_METADATA_KEYS,
  checkoutMetadataSchema,
  checkoutSessionParams,
  DEFAULT_TAX_CODES,
  stripeBalanceTransactionSchema,
  stripeCheckoutSessionSchema,
  stripeDisputeSchema,
  stripeIdOf,
  stripePaymentIntentSchema,
  stripePromotionCodeSchema,
  stripeRefundSchema,
  stripeTransferSchema,
  taxCodeFor,
  type CreateCheckoutSessionInput,
} from "@/lib/stripe/schemas"

/** The Phase 4–5 Stripe contracts written by the W3 prep (CLAUDE.md §19.31). */

const ORDER_REF = "0199b3a0-0000-7000-8000-000000000001"
const LAUNCH_ID = "0199b3a0-0000-7000-8000-000000000002"
const LINK_ID = "0199b3a0-0000-7000-8000-000000000003"

const input: CreateCheckoutSessionInput = {
  orderRef: ORDER_REF,
  launchId: LAUNCH_ID,
  trackedLinkId: LINK_ID,
  attribution: "cookie",
  productName: "Budget tracker",
  priceCents: 2900,
  currency: "eur",
  taxCode: DEFAULT_TAX_CODES.url,
  successUrl: "https://app.test/p/budget/success?session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://app.test/p/budget",
  expiresAt: 1_791_203_400,
  promotionCodeId: null,
}

const balanceTransaction = {
  id: "txn_1",
  object: "balance_transaction",
  amount: 2900,
  fee: 69,
  net: 2831,
  currency: "eur",
  fee_details: [{ amount: 69, currency: "eur", type: "stripe_fee", description: "Stripe fee" }],
  status: "pending",
  type: "charge",
  available_on: 1_791_806_400,
  created: 1_791_201_600,
  source: "ch_1",
}

describe("checkout session parameters", () => {
  it("puts the metadata on the session and the PaymentIntent, with the transfer group", () => {
    const params = checkoutSessionParams(input)
    const metadata = {
      order_ref: ORDER_REF,
      launch_id: LAUNCH_ID,
      tracked_link_id: LINK_ID,
      attribution: "cookie",
    }
    expect(params.metadata).toEqual(metadata)
    expect(params.payment_intent_data).toEqual({ metadata, transfer_group: `order_${ORDER_REF}` })
    expect(params.client_reference_id).toBe(ORDER_REF)
    expect(checkoutMetadataSchema.parse(params.metadata)).toEqual(metadata)
    expect(Object.values(CHECKOUT_METADATA_KEYS).sort()).toEqual(Object.keys(metadata).sort())
  })

  it("sells one tax-inclusive line with Stripe Tax and never sets payment_method_types", () => {
    const params = checkoutSessionParams(input)
    expect(params.mode).toBe("payment")
    expect(params.automatic_tax).toEqual({ enabled: true })
    expect(params.line_items).toEqual([
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: 2900,
          tax_behavior: "inclusive",
          product_data: {
            name: "Budget tracker",
            tax_code: "txcd_10103000",
            metadata: { launch_id: LAUNCH_ID },
          },
        },
      },
    ])
    expect(params).not.toHaveProperty("payment_method_types")
  })

  it("omits attribution keys without a link and picks discounts or promotion codes", () => {
    const plain = checkoutSessionParams({ ...input, trackedLinkId: null, attribution: null })
    expect(plain.metadata).toEqual({ order_ref: ORDER_REF, launch_id: LAUNCH_ID })
    expect(plain).toMatchObject({ allow_promotion_codes: true })
    expect(plain).not.toHaveProperty("discounts")

    const coded = checkoutSessionParams({ ...input, promotionCodeId: "promo_1" })
    expect(coded).toMatchObject({ discounts: [{ promotion_code: "promo_1" }] })
    expect(coded).not.toHaveProperty("allow_promotion_codes")
  })

  it("rejects metadata that is not ours", () => {
    expect(checkoutMetadataSchema.safeParse({ order_ref: "fixture" }).success).toBe(false)
    expect(
      checkoutMetadataSchema.safeParse({
        order_ref: ORDER_REF,
        launch_id: LAUNCH_ID,
        attribution: "discount_code",
      }).success,
    ).toBe(false)
  })

  it("chooses a tax code per delivery type unless the launch sets one", () => {
    expect(taxCodeFor({ deliveryType: "file", taxCode: null })).toBe("txcd_10202000")
    expect(taxCodeFor({ deliveryType: "license_key", taxCode: null })).toBe("txcd_10202000")
    expect(taxCodeFor({ deliveryType: "url", taxCode: null })).toBe("txcd_10103000")
    expect(taxCodeFor({ deliveryType: "url", taxCode: "txcd_10000000" })).toBe("txcd_10000000")
  })
})

describe("Phase 4–5 object schemas", () => {
  it("parses a completed session with tax, discount and the PaymentIntent id", () => {
    const session = stripeCheckoutSessionSchema.parse({
      id: "cs_test_1",
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      url: null,
      amount_subtotal: 2900,
      amount_total: 2320,
      currency: "eur",
      client_reference_id: ORDER_REF,
      customer_details: { email: "buyer@example.test", address: { country: "ES" } },
      total_details: { amount_discount: 580, amount_tax: 403, amount_shipping: 0 },
      discounts: [{ promotion_code: "promo_1", coupon: null }],
      metadata: { order_ref: ORDER_REF, launch_id: LAUNCH_ID },
      payment_intent: "pi_1",
      created: 1_791_201_600,
      expires_at: 1_791_203_400,
      unknown_field: true,
    })
    expect(stripeIdOf(session.payment_intent)).toBe("pi_1")
    expect(stripeIdOf(session.discounts?.[0]?.promotion_code)).toBe("promo_1")
    expect(session).not.toHaveProperty("unknown_field")
  })

  it("parses a PaymentIntent whose latest charge and balance transaction are expanded or not", () => {
    const expanded = stripePaymentIntentSchema.parse({
      id: "pi_1",
      object: "payment_intent",
      amount: 2900,
      currency: "eur",
      status: "succeeded",
      created: 1_791_201_600,
      latest_charge: {
        id: "ch_1",
        object: "charge",
        amount: 2900,
        amount_refunded: 0,
        currency: "eur",
        status: "succeeded",
        paid: true,
        refunded: false,
        payment_intent: "pi_1",
        balance_transaction: balanceTransaction,
        created: 1_791_201_600,
      },
    })
    const charge = expanded.latest_charge
    if (charge === null || typeof charge === "string") throw new Error("expected a charge")
    const fee = typeof charge.balance_transaction === "object" ? charge.balance_transaction : null
    expect(fee?.fee).toBe(69)

    const pending = stripePaymentIntentSchema.parse({
      id: "pi_2",
      object: "payment_intent",
      amount: 2900,
      currency: "eur",
      status: "succeeded",
      created: 1_791_201_600,
      latest_charge: "ch_2",
    })
    expect(pending.latest_charge).toBe("ch_2")
  })

  it("parses money objects", () => {
    expect(stripeBalanceTransactionSchema.parse(balanceTransaction).net).toBe(2831)
    const transfer = stripeTransferSchema.parse({
      id: "tr_1",
      object: "transfer",
      amount: 1500,
      amount_reversed: 0,
      currency: "eur",
      destination: "acct_1",
      transfer_group: "payout_x",
      reversed: false,
      metadata: { transfer_id: "x" },
      created: 1_791_201_600,
    })
    expect(stripeIdOf(transfer.destination)).toBe("acct_1")
    const refund = stripeRefundSchema.parse({
      id: "re_1",
      object: "refund",
      amount: 500,
      currency: "eur",
      status: "succeeded",
      payment_intent: { id: "pi_1" },
      charge: "ch_1",
      metadata: { refund_id: "r" },
      created: 1_791_201_600,
    })
    expect(stripeIdOf(refund.payment_intent)).toBe("pi_1")
    const dispute = stripeDisputeSchema.parse({
      id: "du_1",
      object: "dispute",
      amount: 2900,
      currency: "eur",
      status: "needs_response",
      reason: "fraudulent",
      charge: "ch_1",
      balance_transactions: [{ ...balanceTransaction, id: "txn_2", amount: -2900, fee: 1500 }],
      created: 1_791_201_600,
    })
    expect(dispute.balance_transactions?.[0]?.fee).toBe(1500)
    expect(
      stripePromotionCodeSchema.parse({
        id: "promo_1",
        object: "promotion_code",
        code: "LAUNCH20",
        active: true,
        created: 1_791_201_600,
      }).code,
    ).toBe("LAUNCH20")
  })

  it("refuses ids with the wrong prefix", () => {
    expect(
      stripeBalanceTransactionSchema.safeParse({ ...balanceTransaction, id: "ch_1" }).success,
    ).toBe(false)
  })
})
