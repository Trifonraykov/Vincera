import fc from "fast-check"
import { and, eq, sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { chargebacks, events, ledgerEntries, orders, refunds } from "@/lib/db/schema"
import { PG_ERROR } from "@/lib/db/errors"
import { checkLedger } from "@/lib/ledger/check"
import { LedgerError } from "@/lib/ledger/errors"
import {
  postChargebackLedger,
  postDisputeFeeLedger,
  postOrderLedger,
  postRefundLedger,
  reverseRefundLedger,
} from "@/lib/ledger/post"

import { setupTestDatabase, expectPgError } from "../../helpers/db"
import {
  addRefunded,
  balanceTransaction,
  CONFIG,
  DAY_MS,
  entriesOf,
  PAID_AT,
  saleFixture,
  total,
} from "./helpers"

/** Posting the ledger against Postgres (§9; CLAUDE.md §19.33). */

const testDb = setupTestDatabase()
const NOW = new Date("2026-09-03T12:00:00.000Z")

beforeEach(() => setClockForTests(NOW))
afterEach(() => setClockForTests(null))

const post = (orderId: string, gross = 1900, fee = 54) =>
  testDb.db.transaction((tx) =>
    postOrderLedger(tx, { orderId, balanceTransaction: balanceTransaction(gross, fee) }, CONFIG),
  )

async function insertRefund(
  orderId: string,
  amountCents: number,
  status: "succeeded" | "pending" = "succeeded",
) {
  const [refund] = await testDb.db
    .insert(refunds)
    .values({
      orderId,
      amountCents,
      currency: "eur",
      status,
      stripeRefundId: `re_test_${crypto.randomUUID()}`,
    })
    .returning()
  if (!refund) throw new Error("no refund")
  return refund
}

async function insertChargeback(
  orderId: string,
  amountCents: number,
  status: "open" | "lost",
  feeCents = 1500,
) {
  const [chargeback] = await testDb.db
    .insert(chargebacks)
    .values({
      orderId,
      stripeDisputeId: `du_test_${crypto.randomUUID().replaceAll("-", "")}`,
      amountCents,
      feeCents,
      currency: "eur",
      status,
      stripeStatus: status === "open" ? "needs_response" : "lost",
      openedAt: NOW,
      closedAt: status === "open" ? null : NOW,
    })
    .returning()
  if (!chargeback) throw new Error("no chargeback")
  return chargeback
}

describe("postOrderLedger", () => {
  it("writes the split once, available after the hold, and records the fee and the event", async () => {
    const { order, creator, builder } = await saleFixture(testDb.db)
    await expect(post(order.id)).resolves.toEqual({
      status: "posted",
      entryCount: 5,
      platformFeeCents: 152,
    })

    const rows = await entriesOf(testDb.db, order.id)
    expect(total(rows)).toBe(1900)
    expect(rows.map((r) => [r.account, r.userId, r.amountCents]).sort()).toEqual(
      [
        ["builder_share", builder.user.id, 546],
        ["creator_share", creator.user.id, 818],
        ["platform_fee", null, 152],
        ["stripe_fee", null, 54],
        ["tax", null, 330],
      ].sort(),
    )
    for (const row of rows) {
      expect(row.availableAt.getTime()).toBe(PAID_AT.getTime() + 14 * DAY_MS)
      expect(row.currency).toBe("eur")
      expect(row.transferId).toBeNull()
    }

    const [updated] = await testDb.db.select().from(orders).where(eq(orders.id, order.id))
    expect(updated).toMatchObject({ stripeFeeCents: 54, ledgerPostedAt: NOW })
    expect(updated?.stripeBalanceTransactionId).toMatch(/^txn_test_/)

    const [event] = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.type, "order.ledger_posted"), eq(events.subjectId, order.id)))
    expect(event?.properties).toEqual({
      launch_id: order.launchId,
      stripe_fee_cents: 54,
      platform_fee_cents: 152,
      currency: "eur",
      entry_count: 5,
    })

    // Posting again (a replayed webhook, the hourly job) writes nothing.
    await expect(post(order.id)).resolves.toEqual({ status: "already_posted" })
    expect(await entriesOf(testDb.db, order.id)).toHaveLength(5)
  })

  it("posts once when two posts race", async () => {
    const { order } = await saleFixture(testDb.db)
    const results = await Promise.all([post(order.id), post(order.id)])
    expect(results.map((r) => r.status).sort()).toEqual(["already_posted", "posted"])
    expect(total(await entriesOf(testDb.db, order.id))).toBe(1900)
  })

  it("refuses a balance transaction of another currency or amount and writes nothing", async () => {
    const { order } = await saleFixture(testDb.db)
    await expect(
      testDb.db.transaction((tx) =>
        postOrderLedger(
          tx,
          { orderId: order.id, balanceTransaction: balanceTransaction(1900, 54, "usd") },
          CONFIG,
        ),
      ),
    ).rejects.toMatchObject({ code: "currency_mismatch" })
    await expect(post(order.id, 2000)).rejects.toMatchObject({
      code: "balance_transaction_mismatch",
    })
    expect(await entriesOf(testDb.db, order.id)).toHaveLength(0)
    const [unchanged] = await testDb.db.select().from(orders).where(eq(orders.id, order.id))
    expect(unchanged?.ledgerPostedAt).toBeNull()
  })

  it("refuses an unknown order", async () => {
    await expect(post(crypto.randomUUID())).rejects.toBeInstanceOf(LedgerError)
  })

  it("posts refunds and lost chargebacks that came before the fee was known", async () => {
    const { order } = await saleFixture(testDb.db)
    const refund = await insertRefund(order.id, 500)
    await expect(
      testDb.db.transaction((tx) => postRefundLedger(tx, { refundId: refund.id })),
    ).resolves.toEqual({ status: "order_not_posted" })
    await addRefunded(testDb.db, order.id, 500)

    await post(order.id)
    expect(total(await entriesOf(testDb.db, order.id))).toBe(1400)
    const [posted] = await testDb.db.select().from(refunds).where(eq(refunds.id, refund.id))
    expect(posted?.ledgerPostedAt).toEqual(NOW)
  })

  it("entries are append-only: a posted amount cannot be changed or deleted", async () => {
    const { order } = await saleFixture(testDb.db)
    await post(order.id)
    await expectPgError(
      testDb.db
        .update(ledgerEntries)
        .set({ amountCents: 1 })
        .where(eq(ledgerEntries.orderId, order.id)),
      PG_ERROR.appendOnlyViolation,
    )
    await expectPgError(
      testDb.db.delete(ledgerEntries).where(eq(ledgerEntries.orderId, order.id)),
      PG_ERROR.appendOnlyViolation,
    )
  })
})

describe("postRefundLedger", () => {
  it("mirrors partial refunds and zeroes every component with the last one", async () => {
    const { order } = await saleFixture(testDb.db)
    await post(order.id)

    const amounts = [700, 333, 867]
    for (const amount of amounts) {
      const refund = await insertRefund(order.id, amount)
      await expect(
        testDb.db.transaction((tx) => postRefundLedger(tx, { refundId: refund.id })),
      ).resolves.toMatchObject({ status: "posted" })
      await addRefunded(testDb.db, order.id, amount)
      const lines = await testDb.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.refundId, refund.id))
      expect(total(lines)).toBe(-amount)
      expect(lines.some((line) => line.account === "stripe_fee")).toBe(false)
      // A refund before payout: available with the sale, so it nets out in the same payout.
      for (const line of lines)
        expect(line.availableAt.getTime()).toBe(PAID_AT.getTime() + 14 * DAY_MS)
    }

    const rows = await entriesOf(testDb.db, order.id)
    expect(total(rows)).toBe(0)
    const byKey = new Map<string, number>()
    for (const row of rows) {
      const key = `${row.account}:${row.userId ?? ""}`
      byKey.set(key, (byKey.get(key) ?? 0) + row.amountCents)
    }
    for (const [key, value] of byKey) {
      if (!key.startsWith("stripe_fee") && !key.startsWith("adjustment"))
        expect([key, value]).toEqual([key, 0])
    }
    // The platform absorbs the fee Stripe kept.
    expect(byKey.get("stripe_fee:")).toBe(54)
    expect(byKey.get("adjustment:")).toBe(-54)
  })

  it("is idempotent, refuses refunds that did not succeed, and refuses over-refunds", async () => {
    const { order } = await saleFixture(testDb.db)
    await post(order.id)
    const refund = await insertRefund(order.id, 1900)
    const postIt = (refundId: string) =>
      testDb.db.transaction((tx) => postRefundLedger(tx, { refundId }))
    await postIt(refund.id)
    await expect(postIt(refund.id)).resolves.toEqual({ status: "already_posted" })
    expect(total(await entriesOf(testDb.db, order.id))).toBe(0)

    const pending = await insertRefund(order.id, 100, "pending")
    await expect(postIt(pending.id)).rejects.toMatchObject({ code: "invalid_state" })

    await testDb.db.update(refunds).set({ status: "succeeded" }).where(eq(refunds.id, pending.id))
    await expect(postIt(pending.id)).rejects.toMatchObject({ code: "over_refund" })
    expect(total(await entriesOf(testDb.db, order.id))).toBe(0)
  })

  it("a refund that failed after succeeding is reversed once", async () => {
    const { order } = await saleFixture(testDb.db)
    await post(order.id)
    const refund = await insertRefund(order.id, 600)
    await testDb.db.transaction((tx) => postRefundLedger(tx, { refundId: refund.id }))
    const reverse = () =>
      testDb.db.transaction((tx) => reverseRefundLedger(tx, { refundId: refund.id }))
    await expect(reverse()).resolves.toMatchObject({ status: "reversed" })
    await expect(reverse()).resolves.toEqual({ status: "already_reversed" })
    expect(total(await entriesOf(testDb.db, order.id))).toBe(1900)

    const never = await insertRefund(order.id, 100, "pending")
    await expect(
      testDb.db.transaction((tx) => reverseRefundLedger(tx, { refundId: never.id })),
    ).resolves.toEqual({ status: "nothing_to_reverse" })
  })
})

describe("postChargebackLedger", () => {
  it("mirrors a lost chargeback once and books its fee separately; refuses open ones", async () => {
    const { order } = await saleFixture(testDb.db)
    await post(order.id)
    const refund = await insertRefund(order.id, 400)
    await testDb.db.transaction((tx) => postRefundLedger(tx, { refundId: refund.id }))
    await addRefunded(testDb.db, order.id, 400)

    const open = await insertChargeback(order.id, 1500, "open")
    const postIt = (chargebackId: string) =>
      testDb.db.transaction((tx) => postChargebackLedger(tx, { chargebackId }))
    await expect(postIt(open.id)).rejects.toMatchObject({ code: "invalid_state" })

    const lost = await insertChargeback(order.id, 1500, "lost")
    await expect(postIt(lost.id)).resolves.toMatchObject({ status: "posted" })
    await expect(postIt(lost.id)).resolves.toEqual({ status: "already_posted" })
    await addRefunded(testDb.db, order.id, 1500)
    // The dispute fee is booked when Stripe withdraws it, not by the mirror.
    const feeIt = () =>
      testDb.db.transaction((tx) => postDisputeFeeLedger(tx, { chargebackId: lost.id }))
    await expect(feeIt()).resolves.toMatchObject({ status: "posted", entryCount: 2 })
    await expect(feeIt()).resolves.toEqual({ status: "already_posted" })

    const lines = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.chargebackId, lost.id))
    expect(total(lines)).toBe(-1500)
    expect(lines.filter((l) => l.account === "stripe_fee").map((l) => l.amountCents)).toEqual([
      1500,
    ])
    expect(total(await entriesOf(testDb.db, order.id))).toBe(0)

    const [{ count } = { count: -1 }] = await testDb.db
      .select({ count: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.orderId, order.id),
          sql`${ledgerEntries.userId} IS NOT NULL`,
          sql`${ledgerEntries.amountCents} > 0`,
          sql`${ledgerEntries.refundId} IS NOT NULL`,
        ),
      )
    expect(count).toBe(0)
  })
})

describe("random refund sequences against the database (property)", () => {
  it("keep every order at gross − refunds, and checkLedger clean", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 1900 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 400 }),
        async (wanted, fee) => {
          const { order } = await saleFixture(testDb.db)
          await post(order.id, 1900, fee)
          let left = 1900
          for (const amount of wanted) {
            const refundAmount = Math.min(amount, left)
            if (refundAmount <= 0) break
            const refund = await insertRefund(order.id, refundAmount)
            await testDb.db.transaction((tx) => postRefundLedger(tx, { refundId: refund.id }))
            await addRefunded(testDb.db, order.id, refundAmount)
            left -= refundAmount
          }
          expect(total(await entriesOf(testDb.db, order.id))).toBe(left)
          const report = await checkLedger(testDb.db, { at: NOW })
          expect(report.mismatches.filter((m) => m.orderId === order.id)).toEqual([])
        },
      ),
      { numRuns: 25 },
    )
  })
})
