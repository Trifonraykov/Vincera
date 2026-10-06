import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import Stripe from "stripe"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { STRIPE_API_VERSION } from "@/lib/stripe/client"
import { completeFakeOnboarding, createFakeStripeGateway } from "@/lib/stripe/fake"
import {
  closeFakeDispute,
  createFakeDispute,
  deliverFakeRefundEvent,
  drainFakeConnectedBalance,
  fakeConnectedBalance,
  setFakePlatformBalance,
  settleFakeRefund,
} from "@/lib/stripe/fake-money"
import { StripeGatewayError } from "@/lib/stripe/gateway"
import { createLiveStripeGateway } from "@/lib/stripe/live"
import { verifyStripeWebhook } from "@/lib/stripe/webhooks"

/** The money part of the Stripe gateway: the fake against a temp store, the live one against a stubbed HTTP layer. */

const APP_URL = "http://localhost:3000"
const NOW = new Date("2026-10-05T12:00:00.000Z")
const USER_ID = "0190a000-0000-7000-8000-000000000001"

let root = ""
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fake-money-test-"))
  setClockForTests(NOW)
})
afterEach(async () => {
  setClockForTests(null)
  await rm(root, { recursive: true, force: true })
})

function gateway() {
  return createFakeStripeGateway({ root, appUrl: APP_URL })
}

async function readyAccount(g = gateway()) {
  const account = await g.createConnectedAccount(
    { country: "ES", email: null, userId: USER_ID },
    { idempotencyKey: `acct:${USER_ID}` },
  )
  await completeFakeOnboarding(g.store, account.id, "enabled")
  return account.id
}

/** A paid fake charge as the fake checkout stores it. */
async function paidCharge(g: ReturnType<typeof gateway>, amount = 1900) {
  await g.store.write("charge", "ch_fake_1", {
    id: "ch_fake_1",
    object: "charge",
    amount,
    amount_refunded: 0,
    currency: "eur",
    status: "succeeded",
    paid: true,
    refunded: false,
    payment_intent: "pi_fake_1",
    balance_transaction: "txn_fake_sale",
    created: 1,
  })
  await g.store.write("payment_intent", "pi_fake_1", {
    id: "pi_fake_1",
    object: "payment_intent",
    amount,
    currency: "eur",
    status: "succeeded",
    latest_charge: "ch_fake_1",
    created: 1,
  })
  await g.store.write("balance_transaction", "txn_fake_sale", {
    id: "txn_fake_sale",
    object: "balance_transaction",
    amount,
    fee: 54,
    net: amount - 54,
    currency: "eur",
    fee_details: [{ amount: 54, currency: "eur", type: "stripe_fee" }],
    status: "pending",
    type: "charge",
    available_on: 2,
    created: 1,
  })
}

const transferInput = (destination: string, amount = 1200) => ({
  amount,
  currency: "eur",
  destination,
  transferGroup: "payout_t1",
  metadata: { transfer_id: "t1", batch_id: "b1", user_id: USER_ID },
})

describe("fake money gateway", () => {
  it("retrieves balance transactions and refuses unknown ids", async () => {
    const g = gateway()
    await paidCharge(g)
    const bt = await g.retrieveBalanceTransaction("txn_fake_sale")
    expect(bt.fee).toBe(54)
    await expect(g.retrieveBalanceTransaction("txn_fake_missing")).rejects.toMatchObject({
      code: "resource_missing",
    })
  })

  it("creates transfers idempotently, lists them by group, and refuses changed parameters", async () => {
    const g = gateway()
    const destination = await readyAccount(g)
    const first = await g.createTransfer(transferInput(destination), {
      idempotencyKey: "payout:b1:u1",
    })
    const again = await g.createTransfer(transferInput(destination), {
      idempotencyKey: "payout:b1:u1",
    })
    expect(again).toEqual(first)
    expect(first).toMatchObject({
      amount: 1200,
      amount_reversed: 0,
      destination,
      transfer_group: "payout_t1",
    })
    await expect(
      g.createTransfer(transferInput(destination, 1300), { idempotencyKey: "payout:b1:u1" }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(await g.listTransfersByGroup("payout_t1")).toEqual([first])
    expect(await g.listTransfersByGroup("payout_other")).toEqual([])
    expect(await fakeConnectedBalance(g.store, destination, "eur")).toBe(1200)
  })

  it("refuses a destination without active transfers, and an unknown one", async () => {
    const g = gateway()
    const account = await g.createConnectedAccount(
      { country: "ES", email: null, userId: USER_ID },
      { idempotencyKey: "acct:x" },
    )
    await expect(
      g.createTransfer(transferInput(account.id), { idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      g.createTransfer(transferInput("acct_fake_missing"), { idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ code: "resource_missing" })
  })

  it("fails a transfer with balance_insufficient when the platform balance is too low", async () => {
    const g = gateway()
    const destination = await readyAccount(g)
    await setFakePlatformBalance(g.store, "eur", 1000)
    const error = await g
      .createTransfer(transferInput(destination, 1200), { idempotencyKey: "k" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StripeGatewayError)
    expect(error).toMatchObject({ code: "balance_insufficient" })
    await g.createTransfer(transferInput(destination, 1000), { idempotencyKey: "k2" })
    await setFakePlatformBalance(g.store, "eur", null)
    await g.createTransfer(transferInput(destination, 5000), { idempotencyKey: "k3" })
  })

  it("reverses transfers up to what is left, and refuses when the connected balance is drained", async () => {
    const g = gateway()
    const destination = await readyAccount(g)
    const transfer = await g.createTransfer(transferInput(destination), { idempotencyKey: "k" })
    const reversalInput = { transferId: transfer.id, amount: 500, metadata: { refund_id: "r1" } }
    const reversal = await g.createTransferReversal(reversalInput, { idempotencyKey: "reversal:1" })
    expect(reversal).toMatchObject({ amount: 500, transfer: transfer.id })
    expect(await g.createTransferReversal(reversalInput, { idempotencyKey: "reversal:1" })).toEqual(
      reversal,
    )
    expect((await g.listTransfersByGroup("payout_t1"))[0]).toMatchObject({
      amount_reversed: 500,
      reversed: false,
    })

    await expect(
      g.createTransferReversal({ ...reversalInput, amount: 701 }, { idempotencyKey: "reversal:2" }),
    ).rejects.toMatchObject({ code: "invalid_request" })

    await drainFakeConnectedBalance(g.store, destination, "eur")
    await expect(
      g.createTransferReversal({ ...reversalInput, amount: 100 }, { idempotencyKey: "reversal:3" }),
    ).rejects.toMatchObject({ code: "balance_insufficient" })
  })

  it("refunds a charge partially then fully, then refuses with charge_already_refunded", async () => {
    const g = gateway()
    await paidCharge(g)
    const input = {
      paymentIntentId: "pi_fake_1",
      amount: 900,
      metadata: { refund_id: "r1", order_ref: "o1" },
    }
    const refund = await g.createRefund(input, { idempotencyKey: "refund:r1" })
    expect(refund).toMatchObject({
      amount: 900,
      status: "succeeded",
      charge: "ch_fake_1",
      payment_intent: "pi_fake_1",
    })
    expect(await g.createRefund(input, { idempotencyKey: "refund:r1" })).toEqual(refund)
    expect(await g.retrieveRefund(refund.id)).toEqual(refund)

    await expect(
      g.createRefund({ ...input, amount: 1001 }, { idempotencyKey: "refund:r2" }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    await g.createRefund({ ...input, amount: 1000 }, { idempotencyKey: "refund:r3" })
    await expect(
      g.createRefund({ ...input, amount: 1 }, { idempotencyKey: "refund:r4" }),
    ).rejects.toMatchObject({ code: "charge_already_refunded" })

    // A refund that fails later gives the amount back to the charge.
    const failed = await settleFakeRefund(g.store, refund.id, "failed")
    expect(failed).toMatchObject({ status: "failed", failure_reason: "expired_or_canceled_card" })
    await g.createRefund({ ...input, amount: 900 }, { idempotencyKey: "refund:r5" })
  })

  it("refuses a refund of an unknown payment", async () => {
    await expect(
      gateway().createRefund(
        { paymentIntentId: "pi_fake_none", amount: 1, metadata: {} },
        { idempotencyKey: "k" },
      ),
    ).rejects.toMatchObject({ code: "resource_missing" })
  })

  it("delivers signed refund events to the webhook when asked", async () => {
    const g = gateway()
    await paidCharge(g)
    const refund = await g.createRefund(
      { paymentIntentId: "pi_fake_1", amount: 500, metadata: { refund_id: "r1" } },
      { idempotencyKey: "refund:r1" },
    )
    const received: { body: string; signature: string }[] = []
    const fetchStub: typeof fetch = async (_url, init) => {
      received.push({
        body: String(init?.body),
        signature: new Headers(init?.headers as HeadersInit).get("stripe-signature") ?? "",
      })
      return new Response("ok", { status: 200 })
    }
    const result = await deliverFakeRefundEvent(g.store, refund.id, "refund.created", {
      url: `${APP_URL}/api/webhooks/stripe`,
      secret: "whsec_unit_test",
      fetch: fetchStub,
    })
    expect(result.status).toBe(200)
    const [delivery] = received
    if (!delivery) throw new Error("nothing delivered")
    const event = verifyStripeWebhook(delivery.body, delivery.signature, ["whsec_unit_test"])
    expect(event).toMatchObject({
      ok: true,
      event: { type: "refund.created", data: { object: { id: refund.id } } },
    })
  })

  it("opens and closes disputes with their balance transactions", async () => {
    const g = gateway()
    await paidCharge(g)
    const dispute = await createFakeDispute(g.store, { chargeId: "ch_fake_1" })
    expect(dispute).toMatchObject({ amount: 1900, status: "needs_response", charge: "ch_fake_1" })
    expect(dispute.balance_transactions?.[0]).toMatchObject({ amount: -1900, fee: 1500 })
    const lost = await closeFakeDispute(g.store, dispute.id, "lost")
    expect(lost.status).toBe("lost")
    expect(await g.retrieveDispute(dispute.id)).toEqual(lost)
    const won = await closeFakeDispute(
      g.store,
      (await createFakeDispute(g.store, { chargeId: "ch_fake_1", amount: 500 })).id,
      "won",
    )
    expect(won.balance_transactions?.map((bt) => bt.amount)).toEqual([-500, 500])
  })
})

// --- Live ---------------------------------------------------------------------------------------

type Captured = { url: string; method: string; headers: Headers; body: string }

function stubbedStripe(respond: (request: Captured) => { status: number; body: unknown }) {
  const calls: Captured[] = []
  const fetchStub: typeof fetch = async (input, init) => {
    const request: Captured = {
      url: String(input),
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

const TRANSFER = {
  id: "tr_1",
  object: "transfer",
  amount: 1200,
  amount_reversed: 0,
  currency: "eur",
  destination: "acct_1",
  transfer_group: "payout_t1",
  reversed: false,
  metadata: { transfer_id: "t1" },
  created: 1,
}

describe("live money gateway", () => {
  it("creates a transfer without source_transaction, with the idempotency key", async () => {
    const { gateway: g, calls } = stubbedStripe(() => ({ status: 200, body: TRANSFER }))
    const transfer = await g.createTransfer(transferInput("acct_1"), {
      idempotencyKey: "payout:b1:u1",
    })
    expect(transfer.id).toBe("tr_1")
    const [call] = calls
    if (!call) throw new Error("no request")
    expect(call.url).toBe("https://api.stripe.com/v1/transfers")
    expect(call.headers.get("idempotency-key")).toBe("payout:b1:u1")
    const params = Object.fromEntries(new URLSearchParams(call.body))
    expect(params).toMatchObject({
      amount: "1200",
      currency: "eur",
      destination: "acct_1",
      transfer_group: "payout_t1",
      "metadata[transfer_id]": "t1",
    })
    expect(params).not.toHaveProperty("source_transaction")
  })

  it("lists transfers of a group across pages", async () => {
    const { gateway: g, calls } = stubbedStripe((request) =>
      request.url.includes("starting_after")
        ? {
            status: 200,
            body: { object: "list", data: [{ ...TRANSFER, id: "tr_2" }], has_more: false },
          }
        : { status: 200, body: { object: "list", data: [TRANSFER], has_more: true } },
    )
    const found = await g.listTransfersByGroup("payout_t1")
    expect(found.map((t) => t.id)).toEqual(["tr_1", "tr_2"])
    expect(calls[0]?.url).toContain("transfer_group=payout_t1")
  })

  it("maps balance_insufficient and insufficient_funds to StripeGatewayError", async () => {
    for (const code of ["balance_insufficient", "insufficient_funds"]) {
      const { gateway: g } = stubbedStripe(() => ({
        status: 400,
        body: { error: { type: "invalid_request_error", code, message: "Not enough money." } },
      }))
      await expect(
        g.createTransferReversal(
          { transferId: "tr_1", amount: 100, metadata: {} },
          { idempotencyKey: "k" },
        ),
      ).rejects.toMatchObject({ name: "StripeGatewayError", code: "balance_insufficient" })
    }
  })

  it("maps charge_already_refunded and other invalid requests", async () => {
    const { gateway: g } = stubbedStripe(() => ({
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "charge_already_refunded",
          message: "Already.",
        },
      },
    }))
    await expect(
      g.createRefund(
        { paymentIntentId: "pi_1", amount: 100, metadata: {} },
        { idempotencyKey: "k" },
      ),
    ).rejects.toMatchObject({ code: "charge_already_refunded" })

    const { gateway: other } = stubbedStripe(() => ({
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "parameter_invalid_integer",
          message: "Bad.",
        },
      },
    }))
    await expect(other.retrieveRefund("re_1")).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("passes server errors through unmapped", async () => {
    const { gateway: g } = stubbedStripe(() => ({
      status: 500,
      body: { error: { type: "api_error", message: "Boom." } },
    }))
    const error = await g.retrieveBalanceTransaction("txn_1").catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(StripeGatewayError)
  })
})
