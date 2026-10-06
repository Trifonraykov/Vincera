import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import Stripe from "stripe"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import type { CreateCheckoutSessionInput } from "@/lib/stripe/checkout-shared"
import { STRIPE_API_VERSION } from "@/lib/stripe/client"
import { createFakeStripeGateway } from "@/lib/stripe/fake"
import {
  completeFakeCheckoutSession,
  fakeStripeFeeCents,
  fakeTaxRateBps,
  inclusiveTaxCents,
  settleFakeChargeFee,
  settleFakeDelayedPayment,
} from "@/lib/stripe/fake-checkout"
import { StripeGatewayError } from "@/lib/stripe/gateway"
import { createLiveStripeGateway } from "@/lib/stripe/live"

/**
 * The checkout topic of the Stripe gateway (CLAUDE.md §19.31, §19.34): the live implementation
 * against a stubbed HTTP layer (request shape, idempotency key, parsing, error mapping), and the
 * fake's sessions, payments, tax and fee arithmetic.
 */

const NOW = new Date("2026-10-05T12:00:00.000Z")
const ORDER_REF = "0199b000-0000-7000-8000-000000000001"
const LAUNCH_ID = "0199b000-0000-7000-8000-000000000002"

function input(overrides: Partial<CreateCheckoutSessionInput> = {}): CreateCheckoutSessionInput {
  return {
    orderRef: ORDER_REF,
    launchId: LAUNCH_ID,
    trackedLinkId: null,
    attribution: null,
    productName: "Budget tracker",
    priceCents: 1900,
    currency: "eur",
    taxCode: "txcd_10103000",
    successUrl: "http://localhost:3000/p/budget/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://localhost:3000/p/budget",
    expiresAt: Math.floor(NOW.getTime() / 1000) + 1800,
    promotionCodeId: null,
    ...overrides,
  }
}

describe("fake checkout arithmetic", () => {
  it("computes inclusive VAT and the card fee in integer cents, half up", () => {
    expect(inclusiveTaxCents(1900, 2100)).toBe(330)
    expect(inclusiveTaxCents(1900, 1900)).toBe(303)
    expect(inclusiveTaxCents(1210, 2100)).toBe(210)
    expect(inclusiveTaxCents(1900, 0)).toBe(0)
    expect(fakeStripeFeeCents(1900)).toBe(54)
    expect(fakeStripeFeeCents(100)).toBe(27)
    expect(fakeStripeFeeCents(0)).toBe(0)
    expect(fakeTaxRateBps("DE")).toBe(1900)
    expect(fakeTaxRateBps("US")).toBe(0)
    expect(fakeTaxRateBps(null)).toBe(2100)
  })
})

describe("fake checkout gateway", () => {
  let root = ""
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fake-checkout-"))
    setClockForTests(NOW)
  })
  afterEach(async () => {
    setClockForTests(null)
    await rm(root, { recursive: true, force: true })
  })

  it("replays a session per idempotency key and refuses other parameters", async () => {
    const gateway = createFakeStripeGateway({ root, appUrl: "http://localhost:3000" })
    const first = await gateway.createCheckoutSession(input(), { idempotencyKey: "checkout:a" })
    expect(first.id).toMatch(/^cs_fake_/)
    expect(first.url).toBe(`http://localhost:3000/api/dev/fake-stripe/checkout/${first.id}`)
    expect(first.metadata).toEqual({ order_ref: ORDER_REF, launch_id: LAUNCH_ID })
    const again = await gateway.createCheckoutSession(input(), { idempotencyKey: "checkout:a" })
    expect(again.id).toBe(first.id)
    await expect(
      gateway.createCheckoutSession(input({ priceCents: 2500 }), { idempotencyKey: "checkout:a" }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      gateway.createCheckoutSession(input({ promotionCodeId: "promo_missing" }), {
        idempotencyKey: "checkout:b",
      }),
    ).rejects.toBeInstanceOf(StripeGatewayError)
  })

  it("pays by card with the fee known, by card with the fee pending, and by a delayed method", async () => {
    const gateway = createFakeStripeGateway({ root, appUrl: "http://localhost:3000" })

    const card = await gateway.createCheckoutSession(input(), { idempotencyKey: "checkout:card" })
    const paid = await completeFakeCheckoutSession(gateway.store, card.id, {
      method: "card",
      email: "Buyer@Example.test",
      country: "ES",
    })
    if (!paid.ok || !paid.paymentIntentId) throw new Error("not paid")
    const session = await gateway.retrieveCheckoutSession(card.id)
    expect(session).toMatchObject({
      status: "complete",
      payment_status: "paid",
      amount_total: 1900,
      customer_details: { email: "buyer@example.test", address: { country: "ES" } },
      total_details: { amount_tax: 330, amount_discount: 0 },
    })
    const intent = await gateway.retrievePaymentIntentWithBalanceTransaction(paid.paymentIntentId)
    expect(intent.metadata).toEqual({ order_ref: ORDER_REF, launch_id: LAUNCH_ID })
    const charge = typeof intent.latest_charge === "string" ? null : intent.latest_charge
    expect(charge?.balance_transaction).toMatchObject({ amount: 1900, fee: 54, net: 1846 })
    expect(
      await completeFakeCheckoutSession(gateway.store, card.id, {
        method: "card",
        email: "x@example.test",
        country: "ES",
      }),
    ).toEqual({ ok: false, reason: "not_open" })

    const pending = await gateway.createCheckoutSession(input(), { idempotencyKey: "checkout:fee" })
    const feePending = await completeFakeCheckoutSession(gateway.store, pending.id, {
      method: "card_fee_pending",
      email: "b@example.test",
      country: "US",
    })
    if (!feePending.ok || !feePending.chargeId) throw new Error("not paid")
    expect((await gateway.retrieveCharge(feePending.chargeId)).balance_transaction).toBeNull()
    await settleFakeChargeFee(gateway.store, feePending.chargeId)
    expect((await gateway.retrieveCharge(feePending.chargeId)).balance_transaction).toMatchObject({
      fee: 54,
    })
    expect((await gateway.retrieveCheckoutSession(pending.id)).total_details?.amount_tax).toBe(0)

    const slow = await gateway.createCheckoutSession(input(), { idempotencyKey: "checkout:slow" })
    const delayed = await completeFakeCheckoutSession(gateway.store, slow.id, {
      method: "delayed",
      email: "c@example.test",
      country: "NL",
    })
    if (!delayed.ok || !delayed.paymentIntentId) throw new Error("not completed")
    expect((await gateway.retrieveCheckoutSession(slow.id)).payment_status).toBe("unpaid")
    expect(
      (await gateway.retrievePaymentIntentWithBalanceTransaction(delayed.paymentIntentId))
        .latest_charge,
    ).toBeNull()
    await settleFakeDelayedPayment(gateway.store, slow.id, "succeeded")
    expect((await gateway.retrieveCheckoutSession(slow.id)).payment_status).toBe("paid")
  })

  it("expires an open session after expires_at", async () => {
    const gateway = createFakeStripeGateway({ root, appUrl: "http://localhost:3000" })
    const session = await gateway.createCheckoutSession(input(), { idempotencyKey: "checkout:x" })
    setClockForTests(new Date(NOW.getTime() + 31 * 60 * 1000))
    expect((await gateway.retrieveCheckoutSession(session.id)).status).toBe("expired")
    await expect(gateway.retrieveCheckoutSession("cs_fake_missing")).rejects.toMatchObject({
      code: "resource_missing",
    })
  })
})

describe("live checkout gateway", () => {
  type Captured = { url: string; method: string; headers: Headers; body: string }

  function stubbed(respond: (request: Captured) => { status: number; body: unknown }) {
    const calls: Captured[] = []
    const fetchStub: typeof fetch = async (url, init) => {
      const request: Captured = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers as HeadersInit),
        body: typeof init?.body === "string" ? init.body : "",
      }
      calls.push(request)
      const { status, body } = respond(request)
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "request-id": "req_test" },
      })
    }
    const stripe = new Stripe("sk_test_unit", {
      apiVersion: STRIPE_API_VERSION,
      httpClient: Stripe.createFetchHttpClient(fetchStub),
      maxNetworkRetries: 0,
    })
    return { gateway: createLiveStripeGateway(stripe), calls }
  }

  const session = {
    id: "cs_test_1",
    object: "checkout.session",
    status: "open",
    payment_status: "unpaid",
    mode: "payment",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    amount_subtotal: 1900,
    amount_total: 1900,
    currency: "eur",
    metadata: { order_ref: ORDER_REF, launch_id: LAUNCH_ID },
    payment_intent: null,
    created: 1791201600,
    expires_at: 1791203400,
  }

  it("creates the session with the contract parameters and the idempotency key", async () => {
    const { gateway, calls } = stubbed(() => ({ status: 200, body: session }))
    const created = await gateway.createCheckoutSession(input(), {
      idempotencyKey: `checkout:${ORDER_REF}`,
    })
    expect(created.url).toBe(session.url)
    const [call] = calls
    expect(call?.url).toBe("https://api.stripe.com/v1/checkout/sessions")
    expect(call?.headers.get("idempotency-key")).toBe(`checkout:${ORDER_REF}`)
    const params = Object.fromEntries(new URLSearchParams(call?.body))
    expect(params).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][unit_amount]": "1900",
      "line_items[0][price_data][tax_behavior]": "inclusive",
      "line_items[0][price_data][product_data][tax_code]": "txcd_10103000",
      "automatic_tax[enabled]": "true",
      "metadata[order_ref]": ORDER_REF,
      "payment_intent_data[metadata][launch_id]": LAUNCH_ID,
      "payment_intent_data[transfer_group]": `order_${ORDER_REF}`,
      allow_promotion_codes: "true",
      success_url: input().successUrl,
    })
    expect(Object.keys(params).some((key) => key.startsWith("payment_method_types"))).toBe(false)
  })

  it("expands the balance transaction and maps missing objects", async () => {
    const { gateway, calls } = stubbed((request) =>
      request.url.includes("/payment_intents/")
        ? {
            status: 200,
            body: {
              id: "pi_test_1",
              object: "payment_intent",
              amount: 1900,
              currency: "eur",
              status: "succeeded",
              latest_charge: null,
              created: 1791201600,
            },
          }
        : {
            status: 404,
            body: {
              error: {
                type: "invalid_request_error",
                code: "resource_missing",
                message: "No such charge",
              },
            },
          },
    )
    await gateway.retrievePaymentIntentWithBalanceTransaction("pi_test_1")
    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain(
      "expand[0]=latest_charge.balance_transaction",
    )
    await expect(gateway.retrieveCharge("ch_missing")).rejects.toMatchObject({
      code: "resource_missing",
    })
  })
})
