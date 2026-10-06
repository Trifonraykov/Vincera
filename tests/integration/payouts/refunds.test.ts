import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { payoutsRelease } from "@/inngest/functions/payouts-release"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import {
  accessGrants,
  chargebacks,
  ledgerEntries,
  orders,
  refunds,
  transferReversals,
  transfers,
} from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import { resetEnvCache } from "@/lib/env"
import { newId } from "@/lib/ids"
import { checkLedger } from "@/lib/ledger/check"
import { userBalances } from "@/lib/ledger/release"
import { runPayoutBatch } from "@/lib/payouts/release"
import { requestRefund, RefundRequestError } from "@/lib/refunds/request"
import { createFakeStripeGateway } from "@/lib/stripe/fake"
import {
  closeFakeDispute,
  createFakeDispute,
  drainFakeConnectedBalance,
  fakeConnectedBalance,
  settleFakeRefund,
} from "@/lib/stripe/fake-money"
import type { JsonObject } from "@/lib/db/schema"
import { processStripeEvent } from "@/lib/stripe/webhooks"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"
import {
  AFTER_HOLD,
  BUILDER_SHARE,
  CREATOR_SHARE,
  eventTypes,
  notificationTypes,
  orderRow,
  PAID_AT,
  postedSale,
  stripeEvent,
  sum,
  userEntries,
  type FakeGateway,
} from "./helpers"

/**
 * Refunds and chargebacks against Postgres and the fake Stripe gateway (§9 "Refunds", "Disputes";
 * §16 Phase 5 "Refunds reverse correctly"; CLAUDE.md §19.31, §19.35). The jobs the handlers
 * enqueue run inline (fake jobs), so the reversals and notices are part of each flow.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
const reportError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability", () => ({ reportError }))

const testDb = setupTestDatabase()
let gateway: FakeGateway
let admin: { id: string }

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "refunds-test-"))
  mocks.db = testDb.db
  admin = await insertUser(testDb.db, { roles: ["admin"], activeRole: "admin" })
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  reportError.mockReset()
  stubServiceEnv({ MIN_PAYOUT_CENTS: "500" })
  gateway = createFakeStripeGateway({
    root: path.join(mocks.dir, "fake-stripe"),
    appUrl: TEST_APP_URL,
  })
  setClockForTests(new Date(PAID_AT.getTime() + 60_000))
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  resetEnvCache()
  await closeDb()
})

async function payOut(at = AFTER_HOLD) {
  setClockForTests(at)
  await payoutsRelease.runInline({ runKey: `manual:${newId()}` })
}

async function transferOf(userId: string) {
  const [transfer] = await testDb.db.select().from(transfers).where(eq(transfers.userId, userId))
  return transfer
}

async function grantOf(orderId: string) {
  const [grant] = await testDb.db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.orderId, orderId))
  return grant
}

async function ledgerClean(at: Date) {
  const report = await checkLedger(testDb.db, { compareWithStripe: true, gateway, at })
  return report.mismatches
}

describe("refunds started in the app", () => {
  it("refunds part of an order before payout; the next payout nets it", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const result = await requestRefund(
      testDb.db,
      { orderId: sale.order.id, amountCents: 380, requestedByUserId: admin.id },
      { gateway },
    )
    expect(result.status).toBe("requested")
    const [refund] = await testDb.db.select().from(refunds).where(eq(refunds.id, result.refundId))
    expect(refund).toMatchObject({ status: "succeeded", amountCents: 380 })
    expect(refund?.stripeRefundId).toMatch(/^re_fake_/)
    expect(refund?.ledgerPostedAt).not.toBeNull()

    const order = await orderRow(testDb.db, sale.order.id)
    expect(order).toMatchObject({ status: "partially_refunded", amountRefundedCents: 380 })
    expect((await grantOf(sale.order.id))?.revokedAt).toBeNull()
    expect(await eventTypes(testDb.db, refund!.id)).toEqual(["refund.created"])
    expect(await eventTypes(testDb.db, sale.order.id)).toContain("order.refunded")

    // Notices (the refunds-notify job ran inline): the buyer, and both members.
    const emails = await listOutbox()
    expect(emails.some((email) => email.to.includes(order.buyerEmail))).toBe(true)
    expect(await notificationTypes(testDb.db, sale.creator.user.id)).toEqual(["order.refunded"])
    expect(await notificationTypes(testDb.db, sale.builder.user.id)).toEqual(["order.refunded"])

    // A fifth refunded: each member gives back a fifth of their share, netted in one transfer.
    const creatorNet = sum(await userEntries(testDb.db, sale.creator.user.id))
    const builderNet = sum(await userEntries(testDb.db, sale.builder.user.id))
    expect(creatorNet + builderNet).toBe(CREATOR_SHARE + BUILDER_SHARE - Math.round(1364 * 0.2))
    stubServiceEnv({ MIN_PAYOUT_CENTS: "100" })
    await payOut()
    expect(await transferOf(sale.creator.user.id)).toMatchObject({ amountCents: creatorNet })
    expect(await transferOf(sale.builder.user.id)).toMatchObject({ amountCents: builderNet })
    // Nothing was paid when it was refunded, so nothing is reversed.
    expect(
      await testDb.db
        .select()
        .from(transferReversals)
        .where(eq(transferReversals.refundId, result.refundId)),
    ).toEqual([])
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
  })

  it("refunds a paid-out order in full: transfer reversals, access ends, the books balance", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await payOut()
    const creatorTransfer = await transferOf(sale.creator.user.id)
    expect(creatorTransfer).toMatchObject({ amountCents: CREATOR_SHARE, status: "created" })

    setClockForTests(new Date(AFTER_HOLD.getTime() + 60_000))
    const result = await requestRefund(
      testDb.db,
      { orderId: sale.order.id, requestedByUserId: admin.id, reason: "requested_by_customer" },
      { gateway },
    )
    expect(result.status).toBe("requested")
    const order = await orderRow(testDb.db, sale.order.id)
    expect(order).toMatchObject({ status: "refunded", amountRefundedCents: 1900 })
    expect((await grantOf(sale.order.id))?.revokedAt).not.toBeNull()

    // Both members' shares were pulled back from their transfers.
    const reversals = await testDb.db
      .select()
      .from(transferReversals)
      .where(eq(transferReversals.refundId, result.refundId))
    expect(reversals.map((r) => [r.status, r.amountCents]).sort()).toEqual([
      ["succeeded", BUILDER_SHARE],
      ["succeeded", CREATOR_SHARE],
    ])
    expect(await transferOf(sale.creator.user.id)).toMatchObject({
      status: "reversed",
      amountReversedCents: CREATOR_SHARE,
    })
    expect(await fakeConnectedBalance(gateway.store, sale.accounts!.creator, "eur")).toBe(0)
    expect(await eventTypes(testDb.db, creatorTransfer!.id)).toEqual([
      "payout.reversed",
      "payout.sent",
    ])
    // Nothing left to pay or owe; the books balance against Stripe too.
    expect(await userBalances(testDb.db, { userId: sale.creator.user.id, at: AFTER_HOLD })).toEqual(
      [expect.objectContaining({ availableCents: 0, paidOutCents: 0 })],
    )
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
    // A second run of the reversal (a retried job) changes nothing.
    await payoutsRelease.runInline({ runKey: `manual:${newId()}` })
    expect(sum(await userEntries(testDb.db, sale.creator.user.id))).toBe(0)
  })

  it("keeps the negative entries unpaid when a reversal is refused, and nets them later", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await payOut()
    // Stripe already paid the connected balance out to the bank.
    await drainFakeConnectedBalance(gateway.store, sale.accounts!.creator, "eur")
    setClockForTests(new Date(AFTER_HOLD.getTime() + 60_000))
    const result = await requestRefund(
      testDb.db,
      { orderId: sale.order.id, requestedByUserId: admin.id },
      { gateway },
    )
    const [creatorReversal] = await testDb.db
      .select()
      .from(transferReversals)
      .innerJoin(transfers, eq(transfers.id, transferReversals.transferId))
      .where(
        and(
          eq(transferReversals.refundId, result.refundId),
          eq(transfers.userId, sale.creator.user.id),
        ),
      )
    expect(creatorReversal?.transfer_reversals).toMatchObject({
      status: "failed",
      failureCode: "balance_insufficient",
    })
    expect(
      await userBalances(testDb.db, {
        userId: sale.creator.user.id,
        at: new Date(AFTER_HOLD.getTime() + 60_000),
      }),
    ).toEqual([expect.objectContaining({ availableCents: -CREATOR_SHARE })])
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])

    // Fully refunded: nothing is left to refund.
    await expect(
      requestRefund(
        testDb.db,
        { orderId: sale.order.id, requestedByUserId: admin.id },
        { gateway },
      ),
    ).rejects.toMatchObject({ code: "not_refundable" })
  })

  it("refuses a refund larger than what is left, or on a disputed order", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await expect(
      requestRefund(
        testDb.db,
        { orderId: sale.order.id, amountCents: 1901, requestedByUserId: admin.id },
        { gateway },
      ),
    ).rejects.toMatchObject({ code: "too_much" })
    await testDb.db.update(orders).set({ status: "disputed" }).where(eq(orders.id, sale.order.id))
    await expect(
      requestRefund(
        testDb.db,
        { orderId: sale.order.id, requestedByUserId: admin.id },
        { gateway },
      ),
    ).rejects.toBeInstanceOf(RefundRequestError)
    expect(
      await testDb.db.select().from(refunds).where(eq(refunds.orderId, sale.order.id)),
    ).toEqual([])
  })
})

describe("refund webhooks", () => {
  function refundObject(sale: Awaited<ReturnType<typeof postedSale>>, id: string, status: string) {
    return {
      id,
      object: "refund",
      amount: 1900,
      currency: "eur",
      status,
      failure_reason: status === "failed" ? "expired_or_canceled_card" : null,
      reason: null,
      payment_intent: sale.paymentIntentId,
      charge: sale.chargeId,
      metadata: {},
      created: 1,
    } satisfies JsonObject
  }

  it("records a dashboard refund once, and undoes it when Stripe fails it later", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const refundId = `re_dash_${Date.now()}`
    const created = await stripeEvent(
      gateway.store,
      "refund.created",
      refundObject(sale, refundId, "succeeded"),
    )
    await expect(processStripeEvent(testDb.db, created.event, created.payload)).resolves.toEqual({
      status: "processed",
    })
    // The same event again (Stripe retries) is a no-op; so is a later event with the same state.
    await expect(processStripeEvent(testDb.db, created.event, created.payload)).resolves.toEqual({
      status: "duplicate",
    })
    const updated = await stripeEvent(
      gateway.store,
      "refund.updated",
      refundObject(sale, refundId, "succeeded"),
    )
    await processStripeEvent(testDb.db, updated.event, updated.payload)

    const rows = await testDb.db.select().from(refunds).where(eq(refunds.orderId, sale.order.id))
    expect(rows).toEqual([
      expect.objectContaining({ status: "succeeded", stripeRefundId: refundId, amountCents: 1900 }),
    ])
    expect(await eventTypes(testDb.db, rows[0]!.id)).toEqual(["refund.created"])
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({ status: "refunded" })
    expect((await grantOf(sale.order.id))?.revokedAt).not.toBeNull()
    expect(sum(await userEntries(testDb.db, sale.creator.user.id))).toBe(0)

    // Stripe fails it days later: the buyer keeps paying, the shares come back, access too.
    const failed = await stripeEvent(
      gateway.store,
      "refund.failed",
      refundObject(sale, refundId, "failed"),
    )
    await processStripeEvent(testDb.db, failed.event, failed.payload)
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({
      status: "paid",
      amountRefundedCents: 0,
    })
    expect((await grantOf(sale.order.id))?.revokedAt).toBeNull()
    expect(sum(await userEntries(testDb.db, sale.creator.user.id))).toBe(CREATOR_SHARE)
    expect(await eventTypes(testDb.db, rows[0]!.id)).toEqual(["refund.created", "refund.failed"])
    const [row] = await testDb.db.select().from(refunds).where(eq(refunds.id, rows[0]!.id))
    expect(row).toMatchObject({ status: "failed", failureReason: "expired_or_canceled_card" })

    // An older `pending` event arriving last never moves it back.
    const stale = await stripeEvent(
      gateway.store,
      "refund.updated",
      refundObject(sale, refundId, "pending"),
    )
    await processStripeEvent(testDb.db, stale.event, stale.payload)
    expect(
      (await testDb.db.select().from(refunds).where(eq(refunds.id, rows[0]!.id)))[0]?.status,
    ).toBe("failed")
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
  })

  it("applies the refunds listed on charge.refunded, and ignores charges of other platforms", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const refund = { ...refundObject(sale, `re_listed_${Date.now()}`, "succeeded"), amount: 500 }
    const charge = {
      id: sale.chargeId,
      object: "charge",
      amount: 1900,
      amount_refunded: 500,
      currency: "eur",
      status: "succeeded",
      paid: true,
      refunded: false,
      payment_intent: sale.paymentIntentId,
      balance_transaction: null,
      created: 1,
    }
    // Stripe's copy of the charge, which `ledger:check` compares with ours.
    await gateway.store.write("charge", sale.chargeId, charge)
    const charged = await stripeEvent(gateway.store, "charge.refunded", {
      ...charge,
      refunds: { data: [refund] },
    })
    await processStripeEvent(testDb.db, charged.event, charged.payload)
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({
      status: "partially_refunded",
      amountRefundedCents: 500,
    })

    const foreign = await stripeEvent(gateway.store, "refund.created", {
      ...refundObject(sale, `re_other_${Date.now()}`, "succeeded"),
      payment_intent: "pi_someone_else",
      charge: "ch_someone_else",
    })
    await expect(processStripeEvent(testDb.db, foreign.event, foreign.payload)).resolves.toEqual({
      status: "processed",
    })
  })

  it("settles a refund that the fake gateway fails later through the same handler", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const result = await requestRefund(
      testDb.db,
      { orderId: sale.order.id, amountCents: 400, requestedByUserId: admin.id },
      { gateway },
    )
    const [row] = await testDb.db.select().from(refunds).where(eq(refunds.id, result.refundId))
    const settled = await settleFakeRefund(gateway.store, row!.stripeRefundId!, "failed")
    const event = await stripeEvent(gateway.store, "refund.failed", { ...settled })
    await processStripeEvent(testDb.db, event.event, event.payload)
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({
      status: "paid",
      amountRefundedCents: 0,
    })
  })
})

describe("chargebacks", () => {
  async function deliver(
    type: "charge.dispute.created" | "charge.dispute.closed",
    dispute: object,
  ) {
    const event = await stripeEvent(gateway.store, type, dispute as JsonObject)
    return processStripeEvent(testDb.db, event.event, event.payload)
  }

  it("freezes the order's money while open, and releases it when won", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const dispute = await createFakeDispute(gateway.store, { chargeId: sale.chargeId })
    await deliver("charge.dispute.created", dispute)
    await deliver("charge.dispute.created", dispute) // a second delivery opens nothing more

    const [chargeback] = await testDb.db
      .select()
      .from(chargebacks)
      .where(eq(chargebacks.orderId, sale.order.id))
    expect(chargeback).toMatchObject({ status: "open", amountCents: 1900, feeCents: 1500 })
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({ status: "disputed" })
    expect(await eventTypes(testDb.db, sale.order.id)).toContain("order.disputed")
    expect(await notificationTypes(testDb.db, sale.creator.user.id)).toEqual(["order.disputed"])
    expect(await notificationTypes(testDb.db, admin.id)).toContain("admin.chargeback_opened")

    // Frozen: the payout after the hold leaves it out.
    await payOut()
    expect(await transferOf(sale.creator.user.id)).toBeUndefined()

    await deliver("charge.dispute.closed", await closeFakeDispute(gateway.store, dispute.id, "won"))
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({ status: "paid" })
    expect(await eventTypes(testDb.db, chargeback!.id)).toEqual(["chargeback.closed"])
    await payOut(new Date(AFTER_HOLD.getTime() + 86_400_000))
    expect(await transferOf(sale.creator.user.id)).toMatchObject({ amountCents: CREATOR_SHARE })
  })

  it("books a lost chargeback: shares reversed, the platform pays the fee, access ends", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await payOut()
    const dispute = await createFakeDispute(gateway.store, { chargeId: sale.chargeId })
    setClockForTests(new Date(AFTER_HOLD.getTime() + 60_000))
    await deliver("charge.dispute.created", dispute)
    await deliver(
      "charge.dispute.closed",
      await closeFakeDispute(gateway.store, dispute.id, "lost"),
    )

    const [chargeback] = await testDb.db
      .select()
      .from(chargebacks)
      .where(eq(chargebacks.orderId, sale.order.id))
    expect(chargeback).toMatchObject({ status: "lost" })
    expect(chargeback?.ledgerPostedAt).not.toBeNull()
    expect(await orderRow(testDb.db, sale.order.id)).toMatchObject({
      status: "refunded",
      amountRefundedCents: 1900,
    })
    expect((await grantOf(sale.order.id))?.revokedAt).not.toBeNull()
    // The dispute fee pair (stripe_fee +1500, adjustment −1500) is the platform's.
    const fee = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.chargebackId, chargeback!.id),
          eq(ledgerEntries.account, "stripe_fee"),
        ),
      )
    expect(fee).toEqual([expect.objectContaining({ amountCents: 1500, userId: null })])
    // Both members' payouts were reversed.
    expect(await transferOf(sale.creator.user.id)).toMatchObject({ status: "reversed" })
    expect(await transferOf(sale.builder.user.id)).toMatchObject({ status: "reversed" })
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
  })
})

describe("W3 review fixes (CLAUDE.md §19.37)", () => {
  async function deliverDispute(
    type: "charge.dispute.created" | "charge.dispute.closed",
    dispute: object,
  ) {
    const event = await stripeEvent(gateway.store, type, dispute as JsonObject)
    return processStripeEvent(testDb.db, event.event, event.payload)
  }

  async function feeLines(chargebackId: string) {
    return testDb.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.chargebackId, chargebackId), eq(ledgerEntries.account, "stripe_fee")),
      )
  }

  it("a chargeback lost after a partial refund books the excess as the platform's loss", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await requestRefund(
      testDb.db,
      { orderId: sale.order.id, amountCents: 1000, requestedByUserId: admin.id },
      { gateway },
    )
    // The buyer then disputes the whole charge (Stripe allows it after a refund).
    const dispute = await createFakeDispute(gateway.store, {
      chargeId: sale.chargeId,
      amount: 1900,
    })
    await deliverDispute("charge.dispute.created", dispute)
    await expect(
      deliverDispute(
        "charge.dispute.closed",
        await closeFakeDispute(gateway.store, dispute.id, "lost"),
      ),
    ).resolves.toEqual({ status: "processed" })

    const [chargeback] = await testDb.db
      .select()
      .from(chargebacks)
      .where(eq(chargebacks.orderId, sale.order.id))
    expect(chargeback).toMatchObject({ status: "lost" })
    expect(chargeback?.ledgerPostedAt).not.toBeNull()
    const order = await orderRow(testDb.db, sale.order.id)
    // Unfrozen, fully refunded, access ended.
    expect(order).toMatchObject({ status: "refunded", amountRefundedCents: 1900 })
    expect((await grantOf(sale.order.id))?.revokedAt).not.toBeNull()
    // Lines: what was left (900) mirrored, 1000 more on the platform, fee pair booked.
    const lines = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.chargebackId, chargeback!.id))
    expect(sum(lines)).toBe(-1900)
    expect((await feeLines(chargeback!.id)).map((line) => line.amountCents)).toEqual([1500])
    const orderLines = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, sale.order.id))
    expect(sum(orderLines)).toBe(1900 - 1000 - 1900)
    // Members gave back their whole share, never more.
    expect(sum(await userEntries(testDb.db, sale.creator.user.id))).toBe(0)
    expect(sum(await userEntries(testDb.db, sale.builder.user.id))).toBe(0)
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
  })

  it("books the dispute fee when Stripe withdraws it, also when the dispute is won", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const dispute = await createFakeDispute(gateway.store, { chargeId: sale.chargeId })
    await deliverDispute("charge.dispute.created", dispute)
    const [chargeback] = await testDb.db
      .select()
      .from(chargebacks)
      .where(eq(chargebacks.orderId, sale.order.id))
    expect((await feeLines(chargeback!.id)).map((line) => line.amountCents)).toEqual([1500])
    await deliverDispute("charge.dispute.created", dispute) // replay: booked once
    expect(await feeLines(chargeback!.id)).toHaveLength(1)

    await deliverDispute(
      "charge.dispute.closed",
      await closeFakeDispute(gateway.store, dispute.id, "won"),
    )
    // Stripe kept the fee: it stays booked, the order is paid again and balances.
    expect((await feeLines(chargeback!.id)).map((line) => line.amountCents)).toEqual([1500])
    const orderLines = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, sale.order.id))
    expect(sum(orderLines)).toBe(1900)
    // A stale "created" snapshot arriving after the close books nothing more.
    await deliverDispute("charge.dispute.created", dispute)
    expect(await feeLines(chargeback!.id)).toHaveLength(1)
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
  })

  it("takes the fee back when Stripe returns it with a won dispute", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const dispute = await createFakeDispute(gateway.store, { chargeId: sale.chargeId })
    await deliverDispute("charge.dispute.created", dispute)
    await deliverDispute(
      "charge.dispute.closed",
      await closeFakeDispute(gateway.store, dispute.id, "won", { returnFee: true }),
    )
    const [chargeback] = await testDb.db
      .select()
      .from(chargebacks)
      .where(eq(chargebacks.orderId, sale.order.id))
    expect(chargeback).toMatchObject({ status: "won", feeCents: 0 })
    expect((await feeLines(chargeback!.id)).map((line) => line.amountCents)).toEqual([1500, -1500])
  })

  it("claws back a refund that lands between a batch's collect and pay steps", async () => {
    const sale = await postedSale(testDb.db, gateway)
    setClockForTests(AFTER_HOLD)
    let refundId = ""
    const step = {
      run: async <T>(id: string, fn: () => Promise<T> | T): Promise<T> => {
        if (id.startsWith("pay:") && !refundId) {
          // The transfer is collected (`pending`); the refund succeeds before it is paid.
          const result = await requestRefund(
            testDb.db,
            { orderId: sale.order.id, amountCents: 380, requestedByUserId: admin.id },
            { gateway },
          )
          if (result.status !== "requested") throw new Error("refund not requested")
          refundId = result.refundId
        }
        return fn()
      },
    }
    await runPayoutBatch({ db: testDb.db, gateway, step }, { runKey: `manual:${newId()}` })

    const reversals = await testDb.db
      .select()
      .from(transferReversals)
      .where(eq(transferReversals.refundId, refundId))
    expect(reversals).toHaveLength(2)
    expect(reversals.every((reversal) => reversal.status === "succeeded")).toBe(true)
    expect(await transferOf(sale.creator.user.id)).toMatchObject({
      status: "partially_reversed",
      amountCents: CREATOR_SHARE,
    })
    expect(await ledgerClean(AFTER_HOLD)).toEqual([])
  })
  it("retries a refund for a payment of ours until its order is recorded", async () => {
    const sale = await postedSale(testDb.db, gateway)
    // A paid checkout whose completed event has not been processed: no order row yet.
    const tag = `${Date.now().toString(36)}u`
    const paymentIntentId = `pi_fake_${tag}`
    const chargeId = `ch_fake_${tag}`
    const orderRef = newId()
    await gateway.store.write("payment_intent", paymentIntentId, {
      id: paymentIntentId,
      object: "payment_intent",
      amount: 1900,
      currency: "eur",
      status: "succeeded",
      latest_charge: chargeId,
      metadata: { order_ref: orderRef, launch_id: sale.launch.id },
      created: 0,
    })
    await gateway.store.write("charge", chargeId, {
      id: chargeId,
      object: "charge",
      amount: 1900,
      amount_refunded: 1900,
      currency: "eur",
      status: "succeeded",
      paid: true,
      refunded: true,
      payment_intent: paymentIntentId,
      balance_transaction: null,
      created: 0,
    })
    const refundEvent = await stripeEvent(gateway.store, "refund.created", {
      id: `re_dash_${tag}`,
      object: "refund",
      amount: 1900,
      currency: "eur",
      status: "succeeded",
      failure_reason: null,
      reason: null,
      payment_intent: paymentIntentId,
      charge: chargeId,
      metadata: {},
      created: 1,
    })
    await expect(
      processStripeEvent(testDb.db, refundEvent.event, refundEvent.payload),
    ).rejects.toThrow("order is not recorded yet")

    // Fulfilment catches up; Stripe's retry then applies the refund.
    const [order] = await testDb.db
      .insert(orders)
      .values({
        id: orderRef,
        launchId: sale.launch.id,
        buyerEmail: "late@example.test",
        stripeCheckoutSessionId: `cs_test_${tag}`,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
        amountGrossCents: 1900,
        taxCents: 330,
        stripeFeeCents: 0,
        paidAt: PAID_AT,
      })
      .returning()
    await expect(
      processStripeEvent(testDb.db, refundEvent.event, refundEvent.payload),
    ).resolves.toEqual({ status: "processed" })
    expect(await orderRow(testDb.db, order!.id)).toMatchObject({
      status: "refunded",
      amountRefundedCents: 1900,
    })

    // A dispute on a payment of ours without an order is retried the same way.
    const tag2 = `${tag}d`
    await gateway.store.write("payment_intent", `pi_fake_${tag2}`, {
      id: `pi_fake_${tag2}`,
      object: "payment_intent",
      amount: 1900,
      currency: "eur",
      status: "succeeded",
      latest_charge: `ch_fake_${tag2}`,
      metadata: { order_ref: newId(), launch_id: sale.launch.id },
      created: 0,
    })
    await gateway.store.write("charge", `ch_fake_${tag2}`, {
      id: `ch_fake_${tag2}`,
      object: "charge",
      amount: 1900,
      amount_refunded: 0,
      currency: "eur",
      status: "succeeded",
      paid: true,
      refunded: false,
      payment_intent: `pi_fake_${tag2}`,
      balance_transaction: null,
      created: 0,
    })
    const disputeEvent = await stripeEvent(gateway.store, "charge.dispute.created", {
      id: `du_fake_${tag2}`,
      object: "dispute",
      amount: 1900,
      currency: "eur",
      status: "needs_response",
      reason: "fraudulent",
      charge: `ch_fake_${tag2}`,
      payment_intent: `pi_fake_${tag2}`,
      balance_transactions: [],
      created: 1,
    })
    await expect(
      processStripeEvent(testDb.db, disputeEvent.event, disputeEvent.payload),
    ).rejects.toThrow("order is not recorded yet")
  })
})

describe("transfer.reversed", () => {
  it("records a reversal made in Stripe's dashboard and reports it", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await payOut()
    const transfer = await transferOf(sale.creator.user.id)
    const reversal = await gateway.createTransferReversal(
      { transferId: transfer!.stripeTransferId!, amount: 100, metadata: {} },
      { idempotencyKey: `dashboard:${transfer!.id}` },
    )
    const stored = await gateway.store.read("transfer", transfer!.stripeTransferId!)
    const event = await stripeEvent(gateway.store, "transfer.reversed", {
      ...stored!,
      reversals: { data: [{ ...reversal }] },
    })
    await processStripeEvent(testDb.db, event.event, event.payload)
    await processStripeEvent(testDb.db, event.event, event.payload)

    expect(await transferOf(sale.creator.user.id)).toMatchObject({
      status: "partially_reversed",
      amountReversedCents: 100,
    })
    expect(
      await testDb.db
        .select()
        .from(transferReversals)
        .where(eq(transferReversals.transferId, transfer!.id)),
    ).toEqual([expect.objectContaining({ status: "succeeded", amountCents: 100, refundId: null })])
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Transfer reversed outside the app" }),
      expect.anything(),
    )
  })
})
