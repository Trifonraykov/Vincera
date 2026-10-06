import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq, inArray } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { ledgerEntries, orders, transfers, users } from "@/lib/db/schema"
import { checkLedger, formatLedgerReport } from "@/lib/ledger/check"
import { postPendingOrders } from "@/lib/ledger/pending"
import { postOrderLedger } from "@/lib/ledger/post"
import { payableBalances, releaseFailedTransferEntries, userBalances } from "@/lib/ledger/release"
import { completeFakeOnboarding, createFakeStripeGateway } from "@/lib/stripe/fake"
import type { StripePaymentIntent } from "@/lib/stripe/checkout-shared"

import { setupTestDatabase } from "../../helpers/db"
import { insertStripeAccount, insertTransfer } from "../../helpers/db-fixtures"
import { balanceTransaction, CONFIG, DAY_MS, PAID_AT, saleFixture, total } from "./helpers"

const reportError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability", () => ({ reportError }))

/** Balances, failed-transfer release, reconciliation and the post-pending safety net (§9; §19.33). */

const testDb = setupTestDatabase()
const NOW = new Date("2026-09-03T12:00:00.000Z")
const AFTER_HOLD = new Date(PAID_AT.getTime() + 15 * DAY_MS)

let root = ""
beforeEach(async () => {
  setClockForTests(NOW)
  reportError.mockReset()
  root = await mkdtemp(path.join(tmpdir(), "ledger-check-"))
})
afterEach(async () => {
  setClockForTests(null)
  await rm(root, { recursive: true, force: true })
})

async function postedSale(overrides: Partial<typeof orders.$inferInsert> = {}) {
  const sale = await saleFixture(testDb.db, overrides)
  await testDb.db.transaction((tx) =>
    postOrderLedger(
      tx,
      { orderId: sale.order.id, balanceTransaction: balanceTransaction(1900, 54) },
      CONFIG,
    ),
  )
  return sale
}

async function readyAccounts(...userIds: string[]) {
  for (const userId of userIds) {
    await insertStripeAccount(testDb.db, userId, {
      payoutsEnabled: true,
      transfersCapability: "active",
    })
  }
}

describe("payableBalances", () => {
  it("pays available, untransferred entries of payouts-ready active users, net of refunds", async () => {
    const { order, creator, builder } = await postedSale()
    await readyAccounts(creator.user.id, builder.user.id)

    // Still in the hold period.
    const early = await testDb.db.transaction((tx) =>
      payableBalances(tx, { cutoffAt: NOW, minPayoutCents: 0 }),
    )
    expect(early.filter((b) => [creator.user.id, builder.user.id].includes(b.userId))).toEqual([])

    const balances = await testDb.db.transaction((tx) =>
      payableBalances(tx, { cutoffAt: AFTER_HOLD, minPayoutCents: 0 }),
    )
    const mine = balances.filter((b) => [creator.user.id, builder.user.id].includes(b.userId))
    expect(mine.map((b) => [b.userId, b.amountCents, b.entryIds.length]).sort()).toEqual(
      [
        [creator.user.id, 818, 1],
        [builder.user.id, 546, 1],
      ].sort(),
    )
    expect(mine.every((b) => b.currency === "eur" && b.stripeAccountId.startsWith("acct_"))).toBe(
      true,
    )

    // A minimum above the builder's balance leaves the builder out.
    const withMin = await testDb.db.transaction((tx) =>
      payableBalances(tx, { cutoffAt: AFTER_HOLD, minPayoutCents: 600, userId: builder.user.id }),
    )
    expect(withMin).toEqual([])
    expect(order.id).toBeTruthy()
  })

  it("excludes disputed orders, suspended users and accounts that are not ready; nets negatives", async () => {
    const first = await postedSale()
    await readyAccounts(first.creator.user.id)
    await insertStripeAccount(testDb.db, first.builder.user.id, {
      payoutsEnabled: true,
      transfersCapability: "pending",
    })

    // A negative adjustment for the creator (e.g. a refund mirror after a payout) nets out.
    await testDb.db.insert(ledgerEntries).values({
      orderId: first.order.id,
      userId: first.creator.user.id,
      account: "creator_share",
      amountCents: -18,
      currency: "eur",
      availableAt: PAID_AT,
    })
    const payable = (userId: string) =>
      testDb.db.transaction((tx) =>
        payableBalances(tx, { cutoffAt: AFTER_HOLD, minPayoutCents: 0, userId }),
      )
    expect((await payable(first.creator.user.id))[0]?.amountCents).toBe(800)
    expect(await payable(first.builder.user.id)).toEqual([])

    await testDb.db.update(orders).set({ status: "disputed" }).where(eq(orders.id, first.order.id))
    expect(await payable(first.creator.user.id)).toEqual([])
    await testDb.db.update(orders).set({ status: "paid" }).where(eq(orders.id, first.order.id))

    await testDb.db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, first.creator.user.id))
    expect(await payable(first.creator.user.id)).toEqual([])
  })

  it("never returns a balance that nets to zero or below", async () => {
    const { order, creator } = await postedSale()
    await readyAccounts(creator.user.id)
    await testDb.db.insert(ledgerEntries).values({
      orderId: order.id,
      userId: creator.user.id,
      account: "adjustment",
      amountCents: -900,
      currency: "eur",
      availableAt: PAID_AT,
    })
    const balances = await testDb.db.transaction((tx) =>
      payableBalances(tx, { cutoffAt: AFTER_HOLD, minPayoutCents: 0, userId: creator.user.id }),
    )
    expect(balances).toEqual([])
  })
})

describe("releaseFailedTransferEntries and userBalances", () => {
  it("makes a refused transfer's entries payable again without touching any row", async () => {
    const { creator } = await postedSale()
    await readyAccounts(creator.user.id)
    const [balance] = await testDb.db.transaction((tx) =>
      payableBalances(tx, { cutoffAt: AFTER_HOLD, minPayoutCents: 0, userId: creator.user.id }),
    )
    if (!balance) throw new Error("no balance")
    const transfer = await insertTransfer(testDb.db, creator.user.id, {
      amountCents: balance.amountCents,
    })
    await testDb.db
      .update(ledgerEntries)
      .set({ transferId: transfer.id })
      .where(inArray(ledgerEntries.id, balance.entryIds))

    const release = () =>
      testDb.db.transaction((tx) => releaseFailedTransferEntries(tx, { transferId: transfer.id }))
    await expect(release()).rejects.toMatchObject({ code: "invalid_state" })

    await testDb.db
      .update(transfers)
      .set({ status: "failed", failureCode: "balance_insufficient" })
      .where(eq(transfers.id, transfer.id))
    await expect(release()).resolves.toEqual({
      status: "released",
      entryCount: 1,
      amountCents: 818,
    })
    await expect(release()).resolves.toEqual({ status: "already_released" })

    const marked = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transferId, transfer.id))
    expect(total(marked)).toBe(0)
    const again = await testDb.db.transaction((tx) =>
      payableBalances(tx, { cutoffAt: AFTER_HOLD, minPayoutCents: 0, userId: creator.user.id }),
    )
    expect(again[0]?.amountCents).toBe(818)

    const [summary] = await userBalances(testDb.db, { userId: creator.user.id, at: AFTER_HOLD })
    expect(summary).toEqual({
      currency: "eur",
      pendingCents: 0,
      availableCents: 818,
      onHoldCents: 0,
      paidOutCents: 0,
    })
    const [during] = await userBalances(testDb.db, { userId: creator.user.id, at: NOW })
    expect(during).toMatchObject({ pendingCents: 818, availableCents: 0 })
  })
})

describe("checkLedger", () => {
  it("passes on a consistent ledger and names each kind of mismatch", async () => {
    const clean = await postedSale()
    let report = await checkLedger(testDb.db, { at: NOW })
    expect(report.mismatches.filter((m) => m.orderId === clean.order.id)).toEqual([])
    expect(report.ordersChecked).toBeGreaterThan(0)

    // An entry nobody explains.
    const tampered = await postedSale()
    await testDb.db.insert(ledgerEntries).values({
      orderId: tampered.order.id,
      userId: null,
      account: "adjustment",
      amountCents: 7,
      currency: "eur",
      availableAt: PAID_AT,
    })
    // An order paid long ago that never got its ledger.
    const stuck = await saleFixture(testDb.db)
    // A transfer whose entries do not add up to it.
    const transfer = await insertTransfer(testDb.db, clean.creator.user.id, { amountCents: 999 })
    // A free order (100 % discount: no payment) is never posted and is not a mismatch (§19.36).
    const free = await saleFixture(testDb.db, {
      amountGrossCents: 0,
      taxCents: 0,
      stripePaymentIntentId: null,
    })

    report = await checkLedger(testDb.db, { at: AFTER_HOLD })
    expect(report.mismatches.filter((m) => m.orderId === free.order.id)).toEqual([])
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        { kind: "order_sum", orderId: tampered.order.id, expectedCents: 1900, actualCents: 1907 },
        { kind: "order_not_posted", orderId: stuck.order.id, expectedCents: 1900, actualCents: 0 },
        {
          kind: "transfer_sum",
          transferId: transfer.id,
          detail: "status pending",
          expectedCents: 999,
          actualCents: 0,
        },
        // Still pending after a day: the run crashed around the Stripe call.
        {
          kind: "transfer_pending",
          transferId: transfer.id,
          detail: "pending for more than a day",
          expectedCents: 999,
          actualCents: 0,
        },
      ]),
    )
    expect(formatLedgerReport(report)).toContain(
      `order_sum: order ${tampered.order.id}: expected 1900, found 1907`,
    )
  })

  it("flags refunded amounts and refunds or disputes Stripe knows and we do not", async () => {
    const gateway = createFakeStripeGateway({ root, appUrl: "http://localhost:3000" })
    const chargeId = `ch_fake_${Date.now().toString(36)}`
    const sale = await postedSale({ stripeChargeId: chargeId })
    await gateway.store.write("charge", chargeId, {
      id: chargeId,
      object: "charge",
      amount: 1900,
      amount_refunded: 500,
      currency: "eur",
      status: "succeeded",
      paid: true,
      refunded: false,
      disputed: true,
      payment_intent: null,
      balance_transaction: null,
      created: 0,
    })
    // An order whose refunded amount no refund explains.
    const drifted = await postedSale()
    await testDb.db
      .update(orders)
      .set({ amountRefundedCents: 300, status: "partially_refunded" })
      .where(eq(orders.id, drifted.order.id))

    const report = await checkLedger(testDb.db, { compareWithStripe: true, gateway, at: NOW })
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        {
          kind: "order_stripe",
          orderId: sale.order.id,
          detail: "refunded amount",
          expectedCents: 500,
          actualCents: 0,
        },
        {
          kind: "order_stripe",
          orderId: sale.order.id,
          detail: "disputed at Stripe, no chargeback recorded",
          expectedCents: 0,
          actualCents: 0,
        },
        { kind: "order_refunded", orderId: drifted.order.id, expectedCents: 0, actualCents: 300 },
      ]),
    )
  })

  it("compares transfers with Stripe (the fake store)", async () => {
    const { creator } = await postedSale()
    const gateway = createFakeStripeGateway({ root, appUrl: "http://localhost:3000" })
    const account = await gateway.createConnectedAccount(
      { country: "ES", email: null, userId: creator.user.id },
      { idempotencyKey: `acct:${creator.user.id}` },
    )
    await completeFakeOnboarding(gateway.store, account.id, "enabled")

    const transfer = await insertTransfer(testDb.db, creator.user.id, {
      amountCents: 818,
      destinationAccountId: account.id,
    })
    const atStripe = await gateway.createTransfer(
      {
        amount: 818,
        currency: "eur",
        destination: account.id,
        transferGroup: `payout_${transfer.id}`,
        metadata: { transfer_id: transfer.id },
      },
      { idempotencyKey: `payout:${transfer.batchId}:${creator.user.id}` },
    )
    const entries = await testDb.db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, creator.user.id))
    await testDb.db
      .update(ledgerEntries)
      .set({ transferId: transfer.id })
      .where(
        inArray(
          ledgerEntries.id,
          entries.map((e) => e.id),
        ),
      )
    await testDb.db
      .update(transfers)
      .set({ status: "created", stripeTransferId: atStripe.id })
      .where(eq(transfers.id, transfer.id))

    const mine = (report: Awaited<ReturnType<typeof checkLedger>>) =>
      report.mismatches.filter((m) => m.transferId === transfer.id)
    expect(
      mine(await checkLedger(testDb.db, { compareWithStripe: true, gateway, at: NOW })),
    ).toEqual([])

    // Stripe reversed part of it; we did not record it.
    await gateway.createTransferReversal(
      { transferId: atStripe.id, amount: 100, metadata: {} },
      { idempotencyKey: "reversal:test" },
    )
    expect(
      mine(await checkLedger(testDb.db, { compareWithStripe: true, gateway, at: NOW })),
    ).toEqual([
      {
        kind: "transfer_stripe",
        transferId: transfer.id,
        detail: "amount_reversed",
        expectedCents: 718,
        actualCents: 818,
      },
    ])

    // Stripe has never heard of it.
    await testDb.db
      .update(transfers)
      .set({ stripeTransferId: "tr_fake_unknown" })
      .where(eq(transfers.id, transfer.id))
    const unknown = await checkLedger(testDb.db, { compareWithStripe: true, gateway, at: NOW })
    expect(mine(unknown)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "transfer_stripe",
          detail: "missing at Stripe (tr_fake_unknown)",
        }),
        // The real transfer is still in its group, and no row records it any more.
        expect.objectContaining({
          kind: "transfer_stripe",
          detail: `1 transfers at Stripe in its group (${atStripe.id})`,
        }),
      ]),
    )
    expect(unknown.mismatches).toContainEqual(
      expect.objectContaining({ kind: "transfer_unknown", stripeId: atStripe.id }),
    )
  })
})

describe("postPendingOrders", () => {
  function paymentIntent(
    id: string,
    chargeBalance: "object" | "id" | "none" | "no_charge",
  ): StripePaymentIntent {
    const bt = balanceTransaction(1900, 54)
    return {
      id,
      object: "payment_intent",
      amount: 1900,
      currency: "eur",
      status: "succeeded",
      created: 0,
      latest_charge:
        chargeBalance === "no_charge"
          ? null
          : {
              id: `ch_${id.slice(3)}`,
              object: "charge",
              amount: 1900,
              amount_refunded: 0,
              currency: "eur",
              status: "succeeded",
              paid: true,
              refunded: false,
              created: 0,
              balance_transaction:
                chargeBalance === "object" ? bt : chargeBalance === "id" ? bt.id : null,
            },
    }
  }

  it("posts orders whose fee is known, waits for the others, and reports failures", async () => {
    const posted = await saleFixture(testDb.db, { stripePaymentIntentId: "pi_test_object" })
    const byId = await saleFixture(testDb.db, { stripePaymentIntentId: "pi_test_byid" })
    const waiting = await saleFixture(testDb.db, { stripePaymentIntentId: "pi_test_wait" })
    const broken = await saleFixture(testDb.db, { stripePaymentIntentId: "pi_test_broken" })
    const recent = await saleFixture(testDb.db, {
      stripePaymentIntentId: "pi_test_recent",
      paidAt: new Date(NOW.getTime() - 60_000),
    })

    const gateway = {
      retrievePaymentIntentWithBalanceTransaction: vi.fn(async (id: string) => {
        if (id === "pi_test_broken") throw new Error("Stripe is down")
        if (id === "pi_test_object") return paymentIntent(id, "object")
        if (id === "pi_test_byid") return paymentIntent(id, "id")
        return paymentIntent(id, "none")
      }),
      retrieveBalanceTransaction: vi.fn(async () => balanceTransaction(1900, 54)),
    }
    const result = await postPendingOrders(testDb.db, {
      gateway,
      at: NOW,
      config: CONFIG,
      batchSize: 2,
    })
    expect(result.posted).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.waiting).toBeGreaterThanOrEqual(1)
    expect(reportError).toHaveBeenCalledTimes(1)

    const state = await testDb.db
      .select({ id: orders.id, posted: orders.ledgerPostedAt })
      .from(orders)
      .where(
        inArray(orders.id, [
          posted.order.id,
          byId.order.id,
          waiting.order.id,
          broken.order.id,
          recent.order.id,
        ]),
      )
    const postedIds = state
      .filter((o) => o.posted !== null)
      .map((o) => o.id)
      .sort()
    expect(postedIds).toEqual([posted.order.id, byId.order.id].sort())
    expect(gateway.retrievePaymentIntentWithBalanceTransaction).not.toHaveBeenCalledWith(
      "pi_test_recent",
    )

    // A second run is a no-op for what is posted.
    const again = await postPendingOrders(testDb.db, { gateway, at: NOW, config: CONFIG })
    expect(again.posted).toBe(0)
  })
})
